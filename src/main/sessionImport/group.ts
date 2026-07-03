import type { DiscoveredSession, SessionGroup } from '@shared/types'

function matchWs(cwd: string, wsPaths: string[]): string | null {
  // EXACT match only. A session counts as "已在工作区" solely when its cwd IS a registered
  // workspace. Ancestor-prefix matching was wrong: a broad parent (e.g. /Users/x/work) would
  // claim every child session as imported, yet those children never get their own row in the
  // sidebar list (listWorkspaces keys lightweight workspaces by the exact imported cwd). The
  // result was the reported bug — sessions shown as "已在工作区" that the user never imported and
  // can't find in the workspace list.
  return cwd && wsPaths.includes(cwd) ? cwd : null
}

export function groupByCwd(sessions: DiscoveredSession[], wsPaths: string[]): SessionGroup[] {
  const byKey = new Map<string, SessionGroup>()
  for (const s of sessions) {
    const matched = matchWs(s.cwd, wsPaths)
    const wsPath = matched ?? s.cwd
    const key = s.cwd  // group by cwd, not wsPath
    let g = byKey.get(key)
    if (!g) { g = { cwd: s.cwd, wsPath, matched: matched !== null, sessions: [] }; byKey.set(key, g) }
    g.sessions.push(s)
  }
  const groups = [...byKey.values()]
  for (const g of groups) g.sessions.sort((a, b) => b.lastTs - a.lastTs)
  groups.sort((a, b) => Math.max(...b.sessions.map(s => s.lastTs), 0) - Math.max(...a.sessions.map(s => s.lastTs), 0))
  return groups
}
