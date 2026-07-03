import { describe, it, expect } from 'vitest'
import { collectGitCandidates } from './importResult'
import type { GitRepoCandidate } from '@shared/types'

const probe = (c: string): GitRepoCandidate | null =>
  c === '/a' ? { cwd: '/a', repoUrl: 'git@github.com:me/a.git', branch: 'main' }
  : c === '/b' ? { cwd: '/b', repoUrl: null, branch: 'main' }
  : null

describe('collectGitCandidates', () => {
  it('探测 + 排除已在项目库的(按 repo 名)', () => {
    const out = collectGitCandidates(['/a', '/b', '/c'], { probe, existingRepoNames: new Set(['a']) })
    // /a 已在库被排除; /b 无 remote 保留(供 UI 标注不可加入); /c 非 git 跳过
    expect(out.map(r => r.cwd)).toEqual(['/b'])
  })
})
