import { describe, it, expect } from 'vitest'
import { probeGitRepo } from './gitProbe'

describe('probeGitRepo', () => {
  it('非 git 目录返回 null', () => {
    expect(probeGitRepo('/x', { exists: () => false, run: () => '' })).toBeNull()
  })
  it('解析 remote + branch', () => {
    const r = probeGitRepo('/repo', { exists: () => true, run: (a) => a[0] === 'remote' ? 'git@github.com:me/x.git\n' : 'feat/y\n' })
    expect(r).toEqual({ cwd: '/repo', repoUrl: 'git@github.com:me/x.git', branch: 'feat/y' })
  })
  it('无 remote → repoUrl null, branch 失败→main', () => {
    const r = probeGitRepo('/repo', { exists: () => true, run: (a) => { if (a[0] === 'remote') throw new Error('no remote'); throw new Error('x') } })
    expect(r).toEqual({ cwd: '/repo', repoUrl: null, branch: 'main' })
  })
})
