const KEY = 'forge.expandedWs'

export function toggleExpanded(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id); else next.add(id)
  return next
}
// Add without toggling — used when ENTERING a workspace (create / navigate) so it opens expanded with
// its session list visible, rather than requiring a second click. Returns the same set if already open
// (lets callers skip a redundant state update / persist).
export function ensureExpanded(set: Set<string>, id: string): Set<string> {
  if (set.has(id)) return set
  const next = new Set(set); next.add(id); return next
}
export function loadExpanded(): string[] {
  try { const r = localStorage.getItem(KEY); return r ? (JSON.parse(r) as string[]) : [] } catch { return [] }
}
export function saveExpanded(ids: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(ids)) } catch { /* ignore */ }
}
