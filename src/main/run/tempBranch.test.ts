import { describe, it, expect, vi } from 'vitest'
import { tempBranchName, createTempBranch, mergeTempBranch, discardTempBranch, isCleanTree, parkTempBranch, restoreSnapshot, TempBranchMergeError, type GitRunner } from './tempBranch'

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
      return ''
    }
    await mergeTempBranch('/repo', 'main', 'abc', git)
    expect(calls).toEqual([
      ['add', '-A'],
      ['status', '--porcelain'],
      ['commit', '-m', 'forge: run abc'],
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
      return ''
    }
    await mergeTempBranch('/repo', 'main', 'abc', git)
    expect(calls).toEqual([
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
      return ''
    }
    await expect(mergeTempBranch('/repo', 'main', 'abc', git)).rejects.toBeInstanceOf(TempBranchMergeError)
    await expect(mergeTempBranch('/repo', 'main', 'abc', git)).rejects.toThrow(/CONFLICT/)
    await expect(mergeTempBranch('/repo', 'main', 'abc', git)).rejects.toThrow(/no merge to abort/)
  })

  describe('mergeTempBranch 冲突', () => {
    it('在 abort 之前读冲突文件，abort 后保留分支，抛 TempBranchMergeError', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => {
        calls.push(a)
        if (a[0] === 'status') return ' M a.ts\n'
        if (a[0] === 'merge' && a[1] === '--no-ff') throw new Error('CONFLICT (content): Merge conflict in src/foo.ts')
        if (a[0] === 'diff') return 'src/foo.ts\nsrc/bar.ts\n'
        return ''
      }
      let caught: unknown
      try { await mergeTempBranch('/repo', 'branch1', 'r1', run) } catch (e) { caught = e }

      expect(caught).toBeInstanceOf(TempBranchMergeError)
      const err = caught as TempBranchMergeError
      expect(err.conflictFiles).toEqual(['src/foo.ts', 'src/bar.ts'])
      expect(err.tempBranch).toBe('forge/run-r1')
      expect(err.target).toBe('branch1')

      // 冲突文件必须在 merge --abort 之前读 —— abort 之后 U 状态就没了。
      const diffAt = calls.findIndex((c) => c[0] === 'diff')
      const abortAt = calls.findIndex((c) => c[0] === 'merge' && c[1] === '--abort')
      expect(diffAt).toBeGreaterThan(-1)
      expect(abortAt).toBeGreaterThan(diffAt)
      // 分支绝不能删 —— 本次运行的全部改动都在上面。
      expect(calls.some((c) => c[0] === 'branch' && c[1] === '-D')).toBe(false)
    })

    it('读冲突文件失败 → 不阻断，conflictFiles 为空但仍照常 abort 并抛错', async () => {
      const run: GitRunner = async (_c, a) => {
        if (a[0] === 'status') return ''
        if (a[0] === 'merge' && a[1] === '--no-ff') throw new Error('CONFLICT')
        if (a[0] === 'diff') throw new Error('boom')
        return ''
      }
      await expect(mergeTempBranch('/repo', 'branch1', 'r1', run)).rejects.toBeInstanceOf(TempBranchMergeError)
    })

    it('成功合并 → 提交、切分支、merge、删临时分支', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => {
        calls.push(a)
        if (a[0] === 'status') return ' M a.ts\n'
        return ''
      }
      await mergeTempBranch('/repo', 'branch1', 'r1', run)
      expect(calls).toEqual([
        ['add', '-A'],
        ['status', '--porcelain'],
        ['commit', '-m', 'forge: run r1'],
        ['checkout', 'branch1'],
        ['merge', '--no-ff', 'forge/run-r1'],
        ['branch', '-D', 'forge/run-r1'],
      ])
    })
  })

  it('discardTempBranch force-checkout target(丢弃未提交改动)+clean -fd(丢弃未跟踪新文件) 后强删 temp 分支', async () => {
    const calls: string[][] = []
    const git = async (_cwd: string, args: string[]) => { calls.push(args); return '' }
    await discardTempBranch('/repo', 'main', 'abc', null, git)
    expect(calls).toEqual([
      ['checkout', '-f', 'main'],
      ['clean', '-fd'],
      ['branch', '-D', 'forge/run-abc'],
    ])
  })

  it('createTempBranch/mergeTempBranch/discardTempBranch 都把 cwd 传给 git runner', async () => {
    const cwds: string[] = []
    const git = async (cwd: string, _args: string[]) => { cwds.push(cwd); return '' }
    await createTempBranch('/repo1', 'main', 'a', git)
    await mergeTempBranch('/repo2', 'main', 'a', git)
    await discardTempBranch('/repo3', 'main', 'a', null, git)
    // createTempBranch now does checkout + add -A + status --porcelain (clean tree here → no commit/rev-parse).
    expect(cwds).toEqual(['/repo1', '/repo1', '/repo1', '/repo2', '/repo2', '/repo2', '/repo2', '/repo2', '/repo3', '/repo3', '/repo3'])
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
        return ''
      }
      await parkTempBranch('/repo', 'main', 'abc', null, git)
      expect(calls).toEqual([
        ['add', '-A'],
        ['status', '--porcelain'],
        ['commit', '-m', 'forge: run abc (aborted)'],
        ['checkout', 'main'],
      ])
    })

    it('temp 分支干净(status 无输出)时跳过 commit，直接 checkout target', async () => {
      const calls: string[][] = []
      const git = async (_cwd: string, args: string[]) => {
        calls.push(args)
        if (args[0] === 'status' && args[1] === '--porcelain') return ''
        return ''
      }
      await parkTempBranch('/repo', 'main', 'abc', null, git)
      expect(calls).toEqual([
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
        return ''
      }
      await parkTempBranch('/repo', 'main', 'abc', null, git)
      expect(calls.some((c) => c[0] === 'branch')).toBe(false)
      expect(calls.some((c) => c[0] === 'clean')).toBe(false)
    })

    it('把 cwd 传给 git runner', async () => {
      const cwds: string[] = []
      const git = async (cwd: string) => { cwds.push(cwd); return '' }
      await parkTempBranch('/repo', 'main', 'abc', null, git)
      expect(cwds).toEqual(['/repo', '/repo', '/repo'])
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
        ['commit', '-m', 'forge: 运行前快照'],
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

  describe('restoreSnapshot', () => {
    it('snapshotSha 为 null → 什么都不做', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => { calls.push(a); return '' }
      expect(await restoreSnapshot('/repo', null, run)).toBe('none')
      expect(calls).toEqual([])
    })

    it('成功 → cherry-pick -n 后 reset，改动回到未提交状态', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => { calls.push(a); return '' }
      expect(await restoreSnapshot('/repo', 'abc1234', run)).toBe('restored')
      expect(calls).toEqual([
        ['cherry-pick', '-n', 'abc1234'],
        ['reset'],
      ])
    })

    it('cherry-pick 冲突 → abort 并返回 conflict', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => {
        calls.push(a)
        if (a[0] === 'cherry-pick' && a[1] === '-n') throw new Error('CONFLICT (content): a.ts')
        return ''
      }
      expect(await restoreSnapshot('/repo', 'abc1234', run)).toBe('conflict')
      expect(calls).toEqual([
        ['cherry-pick', '-n', 'abc1234'],
        ['cherry-pick', '--abort'],
      ])
    })
  })

  describe('discardTempBranch 顺序不变式', () => {
    it('还原成功 → 才删分支', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => { calls.push(a); return '' }
      await discardTempBranch('/repo', 'branch1', 'r1', 'abc1234', run)
      expect(calls).toEqual([
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
        return ''
      }
      await expect(discardTempBranch('/repo', 'branch1', 'r1', 'abc1234', run)).rejects.toThrow(
        /forge\/run-r1[\s\S]*abc1234/
      )
      expect(calls.some((c) => c[0] === 'branch' && c[1] === '-D')).toBe(false)
    })

    it('无快照 → 行为与改动前一致', async () => {
      const calls: string[][] = []
      const run: GitRunner = async (_c, a) => { calls.push(a); return '' }
      await discardTempBranch('/repo', 'branch1', 'r1', null, run)
      expect(calls).toEqual([
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
        return ''
      }
      await parkTempBranch('/repo', 'branch1', 'r1', 'abc1234', run)
      expect(calls).toEqual([
        ['add', '-A'],
        ['status', '--porcelain'],
        ['commit', '-m', 'forge: run r1 (aborted)'],
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
        return ''
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
