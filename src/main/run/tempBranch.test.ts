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

  it('mergeTempBranch checkout target 后 --no-ff 合并再删 temp 分支', async () => {
    const calls: string[][] = []
    const git = async (_cwd: string, args: string[]) => { calls.push(args); return '' }
    await mergeTempBranch('/repo', 'main', 'abc', git)
    expect(calls).toEqual([
      ['checkout', 'main'],
      ['merge', '--no-ff', 'forge/run-abc'],
      ['branch', '-D', 'forge/run-abc'],
    ])
  })

  it('mergeTempBranch 报清晰错误当合并冲突', async () => {
    const git = async (_cwd: string, args: string[]) => {
      if (args[0] === 'merge') throw new Error('CONFLICT (content): Merge conflict')
      return ''
    }
    await expect(mergeTempBranch('/repo', 'main', 'abc', git)).rejects.toThrow(/forge\/run-abc.*main/s)
  })

  it('discardTempBranch checkout target 后强删 temp 分支', async () => {
    const calls: string[][] = []
    const git = async (_cwd: string, args: string[]) => { calls.push(args); return '' }
    await discardTempBranch('/repo', 'main', 'abc', git)
    expect(calls).toEqual([
      ['checkout', 'main'],
      ['branch', '-D', 'forge/run-abc'],
    ])
  })

  it('createTempBranch/mergeTempBranch/discardTempBranch 都把 cwd 传给 git runner', async () => {
    const cwds: string[] = []
    const git = async (cwd: string, _args: string[]) => { cwds.push(cwd); return '' }
    await createTempBranch('/repo1', 'main', 'a', git)
    await mergeTempBranch('/repo2', 'main', 'a', git)
    await discardTempBranch('/repo3', 'main', 'a', git)
    expect(cwds).toEqual(['/repo1', '/repo2', '/repo2', '/repo2', '/repo3', '/repo3'])
  })
})
