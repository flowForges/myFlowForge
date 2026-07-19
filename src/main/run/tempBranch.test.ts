import { describe, it, expect } from 'vitest'
import { tempBranchName, createTempBranch, mergeTempBranch, discardTempBranch } from './tempBranch'

describe('tempBranch', () => {
  it('分支名稳定', () => {
    expect(tempBranchName('abc')).toBe('forge/run-abc')
  })

  it('createTempBranch 从 base 切新分支', async () => {
    const calls: string[][] = []
    const git = async (_cwd: string, args: string[]) => { calls.push(args); return '' }
    const name = await createTempBranch('/repo', 'feat/x', 'abc', git)
    expect(name).toBe('forge/run-abc')
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

  it('mergeTempBranch 报清晰错误当合并冲突', async () => {
    const git = async (_cwd: string, args: string[]) => {
      if (args[0] === 'merge' && args[1] === '--no-ff') throw new Error('CONFLICT (content): Merge conflict')
      return ''
    }
    await expect(mergeTempBranch('/repo', 'main', 'abc', git)).rejects.toThrow(/forge\/run-abc.*main/s)
  })

  it('mergeTempBranch 冲突时 best-effort 执行 git merge --abort 恢复目标仓库为干净状态，再抛出可读错误', async () => {
    const calls: Array<{ cwd: string; args: string[] }> = []
    const git = async (cwd: string, args: string[]) => {
      calls.push({ cwd, args })
      if (args[0] === 'merge' && args[1] === '--no-ff') throw new Error('CONFLICT (content): Merge conflict in app.ts')
      return ''
    }
    await expect(mergeTempBranch('/repo', 'main', 'abc', git)).rejects.toThrow(/forge\/run-abc.*main/s)
    // The abort must be issued, in the SAME cwd as the failed merge, after the merge attempt.
    const mergeIdx = calls.findIndex((c) => c.args[0] === 'merge' && c.args[1] === '--no-ff')
    const abortIdx = calls.findIndex((c) => c.args[0] === 'merge' && c.args[1] === '--abort')
    expect(mergeIdx).toBeGreaterThanOrEqual(0)
    expect(abortIdx).toBeGreaterThan(mergeIdx)
    expect(calls[abortIdx].cwd).toBe('/repo')
    // branch -D must NOT run after a failed merge — the temp branch is left intact for retry/inspection.
    expect(calls.some((c) => c.args[0] === 'branch')).toBe(false)
  })

  it('mergeTempBranch 当 git merge --abort 本身也失败时，把它折进错误信息而不是吞掉', async () => {
    const git = async (_cwd: string, args: string[]) => {
      if (args[0] === 'merge' && args[1] === '--no-ff') throw new Error('CONFLICT (content): Merge conflict')
      if (args[0] === 'merge' && args[1] === '--abort') throw new Error('fatal: There is no merge to abort')
      return ''
    }
    await expect(mergeTempBranch('/repo', 'main', 'abc', git)).rejects.toThrow(/CONFLICT/)
    await expect(mergeTempBranch('/repo', 'main', 'abc', git)).rejects.toThrow(/no merge to abort/)
  })

  it('discardTempBranch force-checkout target(丢弃未提交改动)+clean -fd(丢弃未跟踪新文件) 后强删 temp 分支', async () => {
    const calls: string[][] = []
    const git = async (_cwd: string, args: string[]) => { calls.push(args); return '' }
    await discardTempBranch('/repo', 'main', 'abc', git)
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
    await discardTempBranch('/repo3', 'main', 'a', git)
    expect(cwds).toEqual(['/repo1', '/repo2', '/repo2', '/repo2', '/repo2', '/repo2', '/repo3', '/repo3', '/repo3'])
  })
})
