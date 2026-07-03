import type { GitRepoCandidate } from '@shared/types'

// 派生 repo 名(与 config/store.deriveProjectName 同口径: 取末段去 .git)
export function repoName(repoUrl: string): string {
  return repoUrl.replace(/\.git$/, '').replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? repoUrl
}

export function collectGitCandidates(
  cwds: string[],
  deps: { probe: (c: string) => GitRepoCandidate | null; existingRepoNames: Set<string> },
): GitRepoCandidate[] {
  const out: GitRepoCandidate[] = []
  for (const c of cwds) {
    const g = deps.probe(c)
    if (!g) continue
    if (g.repoUrl && deps.existingRepoNames.has(repoName(g.repoUrl))) continue
    out.push(g)
  }
  return out
}
