import { describe, it, expect, vi } from 'vitest'
import { tempBranchName, createTempBranch, mergeTempBranch, discardTempBranch, isCleanTree, parkTempBranch, abandonTempBranch, TempBranchMergeError, currentBranch, type GitRunner } from './tempBranch'

// C2 守卫(2026-08-17 审查):merge/park/discard 动手之前都会先问一句「我还在这个 run 的临时分支上吗」
// (tempBranch.ts 的 onTempBranch),所以每个假 runner 都得能回答 `rev-parse --abbrev-ref HEAD`。
// 下面这个 helper 回答"在"——既有用例断言的全是这条正常路径;"不在"那几条路径由本文件末尾
// describe('C2 · 收尾动作先确认自己在哪条分支上') 单独覆盖,真 git 复现见 tempBranch.integration.test.ts。
const ONBRANCH = ['rev-parse', '--abbrev-ref', 'HEAD']
const onTemp = (runId: string, args: string[]): string | null =>
  args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? `${tempBranchName(runId)}\n` : null

describe('tempBranch', () => {
  it('分支名稳定', () => {
    expect(tempBranchName('abc')).toBe('forge/run-abc')
  })

  it('createTempBranch 从 base 切新分支', async () => {
    const calls: string[][] = []
    const git = async (_cwd: string, args: string[]) => { calls.push(args); return '' }
    const got = await createTempBranch('/repo', 'feat/x', 'abc', git)
    expect(got.branch).toBe('forge/run-abc')
    expect(calls).toContainEqual(['checkout', '-b', 'forge/run-abc', 'feat/x'])
  })

  it('createTempBranch 报清晰错误当 base 不存在', async () => {
    const git = async () => { throw new Error("fatal: invalid reference: feat/missing") }
    await expect(createTempBranch('/repo', 'feat/missing', 'abc', git)).rejects.toThrow(/forge\/run-abc.*feat\/missing/s)
  })

  it('mergeTempBranch 先在 temp 分支 add+commit 未提交改动，再 checkout target --no-ff 合并，最后删 temp 分支', async () => {
    const calls: string[][] = []
    const git = async (_cwd: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'status' && args[1] === '--porcelain') return 'A  new.txt\n M existing.txt\n'
      return onTemp('abc', args) ?? ''
    }
    await mergeTempBranch('/repo', 'main', 'abc', git)
    expect(calls).toEqual([
      ONBRANCH,
      ['add', '-A'],
      ['status', '--porcelain'],
      ['commit', '--no-verify', '-m', 'forge: run abc'],
      ['checkout', 'main'],
      ['merge', '--no-ff', 'forge/run-abc'],
      ['branch', '-D', 'forge/run-abc'],
    ])
  })

  it('mergeTempBranch 当 temp 分支上没有任何改动(status 干净)时跳过 commit，不报 "nothing to commit"', async () => {
    const calls: string[][] = []
    const git = async (_cwd: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'status' && args[1] === '--porcelain') return ''
      return onTemp('abc', args) ?? ''
    }
    await mergeTempBranch('/repo', 'main', 'abc', git)
    expect(calls).toEqual([
      ONBRANCH,
      ['add', '-A'],
      ['status', '--porcelain'],
      ['checkout', 'main'],
      ['merge', '--no-ff', 'forge/run-abc'],
      ['branch', '-D', 'forge/run-abc'],
    ])
  })

  it('mergeTempBranch 当 git merge --abort 本身也失败时，把它折进错误信息而不是吞掉', async () => {
    const git = async (_cwd: string, args: string[]) => {
      if (args[0] === 'merge' && args[1] === '--no-ff') throw new Error('CONFLICT (content): Merge conflict')
      if (args[0] === 'merge' && args[1] === '--abort') throw new Error('fatal: There is no merge to abort')
      return onTemp('abc', args) ?? ''
    }
    await expect(mergeTempBranch('/repo', 'main', 'abc', git)).rejects.toBeInstanceOf(TempBranchMergeError)
    await expect(mergeTempBranch('/repo', 'main', 'abc', git)).rejects.toThrow(/CONFLICT/)
    await expect(mergeTempBranch('/repo', 'main', 'abc', git)).rejects.toThrow(/no merge to abort/)
  })

  describe('mergeTempBranch 冲突', () => {
    it('在 abort 之前读冲突文件，abort 后保留分支，抛 TempBranchMergeError', async () => {
      const calls: Array<{ cwd: string; args: string[] }> = []
      const run: GitRunner = async (c, a) => {
        calls.push({ cwd: c, args: a })
        if (a[0] === 'status') return ' M a.ts\n'
        if (a[0] === 'merge' && a[1] === '--no-ff') throw new Error('CONFLICT (content): Merge conflict in src/foo.ts')
        if (a[0] === 'diff') return 'src/foo.ts\nsrc/bar.ts\n'
        return onTemp('r1', a) ?? ''
      }
      let caught: unknown
      try { await mergeTempBranch('/repo', 'branch1', 'r1', run) } catch (e) { caught = e }

      expect(caught).toBeInstanceOf(TempBranchMergeError)
      const err = caught as TempBranchMergeError
      expect(err.conflictFiles).toEqual(['src/foo.ts', 'src/bar.ts'])
      expect(err.tempBranch).toBe('forge/run-r1')
      expect(err.target).toBe('branch1')

      // 冲突文件必须在 merge --abort 之前读 —— abort 之后 U 状态就没了。
      const diffAt = calls.findIndex((c) => c.args[0] === 'diff')
      const abortAt = calls.findIndex((c) => c.args[0] === 'merge' && c.args[1] === '--abort')
      expect(diffAt).toBeGreaterThan(-1)
      expect(abortAt).toBeGreaterThan(diffAt)
      // abort 必须发生在跟失败的 merge 同一个 cwd 上，不能串到别的项目的仓库去。
      expect(calls[abortAt].cwd).toBe('/repo')
      // 分支绝不能动 —— 不止 -D，任何 branch 子命令都不该在失败路径上出现；本次运行的全部改动都在上面。
      expect(calls.some((c) => c.args[0] === 'branch')).toBe(false)
    })

    it('读冲突文件失败 → 不阻断，conflictFiles 为空但仍照常 abort 并抛错', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => {
        calls.push(a)
        if (a[0] === 'status') return ''
        if (a[0] === 'merge' && a[1] === '--no-ff') throw new Error('CONFLICT')
        if (a[0] === 'diff') throw new Error('boom')
        return onTemp('r1', a) ?? ''
      }
      let caught: unknown
      try { await mergeTempBranch('/repo', 'branch1', 'r1', run) } catch (e) { caught = e }

      expect(caught).toBeInstanceOf(TempBranchMergeError)
      const err = caught as TempBranchMergeError
      // 读冲突文件失败(boom)不该吞掉/覆盖原始的 merge 失败原因(CONFLICT)。
      expect(err.message).toMatch(/CONFLICT/)
      // conflictFiles 读取失败时优雅降级为空数组，而不是抛出/中断。
      expect(err.conflictFiles).toEqual([])
      // abort 仍然照常执行 —— diff 读取失败不能连带跳过 abort。
      expect(calls.some((c) => c[0] === 'merge' && c[1] === '--abort')).toBe(true)
    })

    it('成功合并 → 提交、切分支、merge、删临时分支', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => {
        calls.push(a)
        if (a[0] === 'status') return ' M a.ts\n'
        return onTemp('r1', a) ?? ''
      }
      await mergeTempBranch('/repo', 'branch1', 'r1', run)
      expect(calls).toEqual([
        ONBRANCH,
        ['add', '-A'],
        ['status', '--porcelain'],
        ['commit', '--no-verify', '-m', 'forge: run r1'],
        ['checkout', 'branch1'],
        ['merge', '--no-ff', 'forge/run-r1'],
        ['branch', '-D', 'forge/run-r1'],
      ])
    })
  })

  it('discardTempBranch force-checkout target(丢弃未提交改动)+clean -fd(丢弃未跟踪新文件) 后强删 temp 分支', async () => {
    const calls: string[][] = []
    const git = async (_cwd: string, args: string[]) => { calls.push(args); return onTemp('abc', args) ?? '' }
    await discardTempBranch('/repo', 'main', 'abc', null, git)
    expect(calls).toEqual([
      ONBRANCH,
      ['checkout', '-f', 'main'],
      ['clean', '-fd'],
      ['branch', '-D', 'forge/run-abc'],
    ])
  })

  it('createTempBranch/mergeTempBranch/discardTempBranch 都把 cwd 传给 git runner', async () => {
    const cwds: string[] = []
    const git = async (cwd: string, args: string[]) => { cwds.push(cwd); return onTemp('a', args) ?? '' }
    await createTempBranch('/repo1', 'main', 'a', git)
    await mergeTempBranch('/repo2', 'main', 'a', git)
    await discardTempBranch('/repo3', 'main', 'a', null, git)
    // createTempBranch now does checkout + add -A + status --porcelain (clean tree here → no commit/rev-parse).
    // merge/discard 各自多一次 rev-parse --abbrev-ref HEAD(C2 分支守卫),同样必须落在自己的 cwd 上 ——
    // 守卫要是问错了仓库,后面所有动作都会基于别人的分支状态决定做不做。
    expect(cwds).toEqual([
      '/repo1', '/repo1', '/repo1',
      '/repo2', '/repo2', '/repo2', '/repo2', '/repo2', '/repo2',
      '/repo3', '/repo3', '/repo3', '/repo3',
    ])
  })

  describe('isCleanTree (Finding 3)', () => {
    it('true 当 git status --porcelain 输出为空', async () => {
      const git = async () => ''
      expect(await isCleanTree('/repo', git)).toBe(true)
    })

    it('false 当有未跟踪新文件或未提交改动', async () => {
      const git = async () => '?? new.txt\n'
      expect(await isCleanTree('/repo', git)).toBe(false)
    })

    it('把 cwd 传给 git runner', async () => {
      const cwds: string[] = []
      const git = async (cwd: string) => { cwds.push(cwd); return '' }
      await isCleanTree('/repo', git)
      expect(cwds).toEqual(['/repo'])
    })
  })

  describe('parkTempBranch (Finding 4 — abort PARKS instead of discards)', () => {
    it('提交 temp 分支上的未提交改动，再 checkout target — 不删除/不 clean temp 分支', async () => {
      const calls: string[][] = []
      const git = async (_cwd: string, args: string[]) => {
        calls.push(args)
        if (args[0] === 'status' && args[1] === '--porcelain') return 'A  new.txt\n M existing.txt\n'
        return onTemp('abc', args) ?? ''
      }
      await parkTempBranch('/repo', 'main', 'abc', null, git)
      expect(calls).toEqual([
        ONBRANCH,
        ['add', '-A'],
        ['status', '--porcelain'],
        ['commit', '--no-verify', '-m', 'forge: run abc (aborted)'],
        ['checkout', 'main'],
      ])
    })

    it('temp 分支干净(status 无输出)时跳过 commit，直接 checkout target', async () => {
      const calls: string[][] = []
      const git = async (_cwd: string, args: string[]) => {
        calls.push(args)
        if (args[0] === 'status' && args[1] === '--porcelain') return ''
        return onTemp('abc', args) ?? ''
      }
      await parkTempBranch('/repo', 'main', 'abc', null, git)
      expect(calls).toEqual([
        ONBRANCH,
        ['add', '-A'],
        ['status', '--porcelain'],
        ['checkout', 'main'],
      ])
    })

    it('绝不调用 branch -D 或 clean -fd — 温度分支保留，工作可恢复', async () => {
      const calls: string[][] = []
      const git = async (_cwd: string, args: string[]) => {
        calls.push(args)
        if (args[0] === 'status' && args[1] === '--porcelain') return 'A  new.txt\n'
        return onTemp('abc', args) ?? ''
      }
      await parkTempBranch('/repo', 'main', 'abc', null, git)
      expect(calls.some((c) => c[0] === 'branch')).toBe(false)
      expect(calls.some((c) => c[0] === 'clean')).toBe(false)
    })

    it('把 cwd 传给 git runner', async () => {
      const cwds: string[] = []
      const git = async (cwd: string, args: string[]) => { cwds.push(cwd); return onTemp('abc', args) ?? '' }
      await parkTempBranch('/repo', 'main', 'abc', null, git)
      expect(cwds).toEqual(['/repo', '/repo', '/repo', '/repo'])
    })
  })

  describe('createTempBranch 运行前快照', () => {
    it('脏树 → 建分支后立刻提交快照，返回 snapshotSha', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_cwd, args) => {
        calls.push(args)
        if (args[0] === 'status') return ' M src/foo.ts\n?? src/new.ts\n'
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc1234\n'
        return ''
      }
      const got = await createTempBranch('/repo', 'branch1', 'r1', run)

      expect(got.branch).toBe('forge/run-r1')
      expect(got.snapshotSha).toBe('abc1234')
      expect(calls).toEqual([
        ['checkout', '-b', 'forge/run-r1', 'branch1'],
        ['add', '-A'],
        ['status', '--porcelain'],
        // C1c:快照是 app 替用户做的记账提交,绝不跑用户的 pre-commit —— 一个 lint-staged 钩子挂掉
        // 就会把整次启动带进「HEAD 被留在临时分支上」的连锁(见 tempBranch.ts / launch.ts 的注释)。
        ['commit', '--no-verify', '-m', 'forge: 运行前快照'],
        ['rev-parse', 'HEAD'],
      ])
    })

    it('干净树 → 不提交任何东西，snapshotSha 为 null', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_cwd, args) => { calls.push(args); return '' }
      const got = await createTempBranch('/repo', 'branch1', 'r1', run)

      expect(got.snapshotSha).toBeNull()
      expect(calls.some((c) => c[0] === 'commit')).toBe(false)
      expect(calls.some((c) => c[0] === 'rev-parse')).toBe(false)
    })

    it('checkout 失败 → 抛出带 base 与 branch 的可读错误', async () => {
      const run: GitRunner = async () => { throw new Error('fatal: invalid reference') }
      await expect(createTempBranch('/repo', 'gone', 'r1', run)).rejects.toThrow(
        /Failed to create temp branch "forge\/run-r1" from base "gone"/
      )
    })

    it('快照提交失败 → 抛出可读错误，不吞掉', async () => {
      const run: GitRunner = async (_cwd, args) => {
        if (args[0] === 'status') return ' M a.ts\n'
        if (args[0] === 'commit') throw new Error('fatal: no user.email')
        return ''
      }
      await expect(createTempBranch('/repo', 'branch1', 'r1', run)).rejects.toThrow(
        /Failed to commit pre-run snapshot .*forge\/run-r1/
      )
    })
  })

  describe('discardTempBranch 顺序不变式', () => {
    it('还原成功 → 才删分支', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => { calls.push(a); return onTemp('r1', a) ?? '' }
      await discardTempBranch('/repo', 'branch1', 'r1', 'abc1234', run)
      expect(calls).toEqual([
        ONBRANCH,
        ['checkout', '-f', 'branch1'],
        ['clean', '-fd'],
        ['cherry-pick', '-n', 'abc1234'],
        ['reset'],
        ['branch', '-D', 'forge/run-r1'],
      ])
    })

    it('还原冲突 → 绝不删分支，并抛出带分支名和 sha 的可读错误', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => {
        calls.push(a)
        if (a[0] === 'cherry-pick' && a[1] === '-n') throw new Error('CONFLICT')
        return onTemp('r1', a) ?? ''
      }
      await expect(discardTempBranch('/repo', 'branch1', 'r1', 'abc1234', run)).rejects.toThrow(
        /forge\/run-r1[\s\S]*abc1234/
      )
      expect(calls.some((c) => c[0] === 'branch' && c[1] === '-D')).toBe(false)
    })

    it('无快照 → 行为与改动前一致', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => { calls.push(a); return onTemp('r1', a) ?? '' }
      await discardTempBranch('/repo', 'branch1', 'r1', null, run)
      expect(calls).toEqual([
        ONBRANCH,
        ['checkout', '-f', 'branch1'],
        ['clean', '-fd'],
        ['branch', '-D', 'forge/run-r1'],
      ])
    })
  })

  describe('parkTempBranch 还原快照但保留分支', () => {
    it('提交在制品 → 切回目标 → 还原快照 → 不删分支', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => {
        calls.push(a)
        if (a[0] === 'status') return ' M a.ts\n'
        return onTemp('r1', a) ?? ''
      }
      await parkTempBranch('/repo', 'branch1', 'r1', 'abc1234', run)
      expect(calls).toEqual([
        ONBRANCH,
        ['add', '-A'],
        ['status', '--porcelain'],
        ['commit', '--no-verify', '-m', 'forge: run r1 (aborted)'],
        ['checkout', 'branch1'],
        ['cherry-pick', '-n', 'abc1234'],
        ['reset'],
      ])
      expect(calls.some((c) => c[0] === 'branch' && c[1] === '-D')).toBe(false)
    })

    it('还原冲突 → 只警告不抛错，temp 分支保留', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => {
        calls.push(a)
        if (a[0] === 'cherry-pick' && a[1] === '-n') throw new Error('CONFLICT')
        return onTemp('r1', a) ?? ''
      }
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await expect(parkTempBranch('/repo', 'branch1', 'r1', 'abc1234', run)).resolves.toBeUndefined()
        expect(warnSpy).toHaveBeenCalled()
        expect(calls.some((c) => c[0] === 'branch' && c[1] === '-D')).toBe(false)
      } finally {
        warnSpy.mockRestore()
        errorSpy.mockRestore()
      }
    })
  })
})

// 2026-08-17 审查 C2(真 git 复现,见 tempBranch.integration.test.ts 里对应的三条集成用例):一次合并
// 失败后仓库已经被切回用户自己的分支、失败卡还明说「已恢复到合并前的干净状态」,用户于是接着在那儿
// 干活;此时点「重新收尾」会原样再调一遍这三个函数。这组用例钉住的是「它们先看自己在哪条分支上」。
describe('C2 · 收尾动作先确认自己在哪条分支上', () => {
  // 假 runner 一律回答"我在 branch1 上"——即用户自己的分支,不是 forge/run-r1。
  const onUserBranch = (calls: string[][]): GitRunner => async (_c, a) => {
    calls.push(a)
    if (a[0] === 'rev-parse' && a[1] === '--abbrev-ref') return 'branch1\n'
    if (a[0] === 'status') return ' M user-wip.ts\n'   // 用户失败之后自己写的东西
    return ''
  }

  it('merge:不在临时分支上就不 add/commit —— 那些脏东西是用户的,不能盖上 forge 的名字', async () => {
    const calls: string[][] = []
    await mergeTempBranch('/repo', 'branch1', 'r1', onUserBranch(calls))
    expect(calls.some((c) => c[0] === 'add')).toBe(false)
    expect(calls.some((c) => c[0] === 'commit')).toBe(false)
    // 合并本身照常重试 —— 用户点「重新收尾」要的就是这个。
    expect(calls).toContainEqual(['merge', '--no-ff', 'forge/run-r1'])
  })

  it('park:不在临时分支上就整个跳过 —— 不提交、不 cherry-pick 快照', async () => {
    const calls: string[][] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(parkTempBranch('/repo', 'branch1', 'r1', 'snap123', onUserBranch(calls))).resolves.toBeUndefined()
    } finally { warnSpy.mockRestore() }
    expect(calls).toEqual([['rev-parse', '--abbrev-ref', 'HEAD']])
  })

  it('discard:不在临时分支上就拒绝执行 —— 绝不 checkout -f / clean -fd 删用户自己的未跟踪文件', async () => {
    const calls: string[][] = []
    await expect(discardTempBranch('/repo', 'branch1', 'r1', 'snap123', onUserBranch(calls)))
      .rejects.toThrow(/forge\/run-r1/)
    expect(calls.some((c) => c[0] === 'checkout')).toBe(false)
    expect(calls.some((c) => c[0] === 'clean')).toBe(false)
    expect(calls.some((c) => c[0] === 'branch')).toBe(false)
  })

  it('读不出当前分支 → 抛可读错误,不静默当成"不在"(那会让环境故障看起来像一次成功的空收尾)', async () => {
    const run: GitRunner = async (_c, a) => {
      if (a[0] === 'rev-parse' && a[1] === '--abbrev-ref') throw new Error('not a git repository')
      return ''
    }
    await expect(parkTempBranch('/repo', 'branch1', 'r1', null, run)).rejects.toThrow(/not a git repository/)
    await expect(mergeTempBranch('/repo', 'branch1', 'r1', run)).rejects.toThrow(/not a git repository/)
    await expect(discardTempBranch('/repo', 'branch1', 'r1', null, run)).rejects.toThrow(/not a git repository/)
  })
})

// 2026-08-17 审查 C1b:建分支途中失败时的就地撤回。真 git 覆盖见集成测试。
describe('abandonTempBranch', () => {
  it('普通 checkout 切回 base + 取消暂存 + 删临时分支 —— 绝不 -f / clean(快照没提交成时那是用户改动的唯一副本)', async () => {
    const calls: string[][] = []
    // HEAD 已在临时分支上 = createTempBranch 过了 checkout -b、跑过 add -A。
    const run: GitRunner = async (_c, a) => { calls.push(a); return onTemp('r1', a) ?? '' }
    await abandonTempBranch('/repo', 'branch1', 'r1', run)
    expect(calls).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['checkout', 'branch1'],
      // createTempBranch 失败前已经 `add -A` 过,不 reset 的话用户的改动会以「全部已暂存」的样子留下。
      ['reset'],
      ['branch', '-D', 'forge/run-r1'],
    ])
  })

  it('`checkout -b` 自己就失败时(HEAD 还在 base 上)不 reset —— 我们没暂存过任何东西,别去动用户自己 staged 的改动', async () => {
    const calls: string[][] = []
    const run: GitRunner = async (_c, a) => {
      calls.push(a)
      if (a[0] === 'rev-parse' && a[1] === '--abbrev-ref') return 'branch1\n'
      return ''
    }
    await abandonTempBranch('/repo', 'branch1', 'r1', run)
    expect(calls.some((c) => c[0] === 'reset')).toBe(false)
  })

  it('分支压根没建成(branch -D 失败)不算撤回失败 —— 切回 base 才是要紧的那一步', async () => {
    const run: GitRunner = async (_c, a) => {
      if (a[0] === 'branch') throw new Error("error: branch 'forge/run-r1' not found")
      return ''
    }
    await expect(abandonTempBranch('/repo', 'branch1', 'r1', run)).resolves.toBeUndefined()
  })

  it('切不回 base → 抛错(这才是"HEAD 被留在废弃临时分支上"那个危险状态的信号)', async () => {
    const run: GitRunner = async (_c, a) => {
      if (a[0] === 'checkout') throw new Error('error: pathspec did not match')
      return ''
    }
    await expect(abandonTempBranch('/repo', 'branch1', 'r1', run)).rejects.toThrow(/branch1/)
  })
})

describe('currentBranch', () => {
  it('正常分支 → 返回分支名（去掉换行）', async () => {
    const run: GitRunner = async (_c, a) => {
      expect(a).toEqual(['rev-parse', '--abbrev-ref', 'HEAD'])
      return 'branch1\n'
    }
    expect(await currentBranch('/repo', run)).toBe('branch1')
  })

  it('detached HEAD → git 回 "HEAD"，归一成空串', async () => {
    const run: GitRunner = async () => 'HEAD\n'
    expect(await currentBranch('/repo', run)).toBe('')
  })

  it('git 失败（非 detached）→ 原样抛出，不归一成空串（Task 8：detached 与"读取失败"要分开措辞，前提是失败会抛出而不是被这里吞掉）', async () => {
    const run: GitRunner = async () => { throw new Error('not a git repo') }
    await expect(currentBranch('/repo', run)).rejects.toThrow(/not a git repo/)
  })

  it('目录不存在等失败 → 抛出的错误里不含 detached HEAD 那句话（调用方据此分辨该说哪种话）', async () => {
    const run: GitRunner = async () => { throw new Error('ENOENT: no such file or directory, chdir') }
    let message = ''
    try { await currentBranch('/missing', run) } catch (err) { message = err instanceof Error ? err.message : String(err) }
    expect(message).not.toMatch(/detached HEAD/)
    expect(message).toMatch(/ENOENT/)
  })
})
