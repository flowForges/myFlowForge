import type { DiscoveredSession } from '@shared/types'

export type ImportStatus = 'all' | 'imported' | 'new'
const key = (s: DiscoveredSession) => `${s.source}::${s.externalId}`

export function applyImportFilter(
  sessions: DiscoveredSession[],
  importedKeys: Set<string>,
  status: ImportStatus,
  sourceFilter: string,
): DiscoveredSession[] {
  return sessions
    .filter(s => sourceFilter === 'all' || s.source === sourceFilter)
    .filter(s => status === 'all' || (status === 'imported') === importedKeys.has(key(s)))
    .sort((a, b) => {
      const ia = importedKeys.has(key(a)) ? 1 : 0
      const ib = importedKeys.has(key(b)) ? 1 : 0
      return ia !== ib ? ia - ib : b.lastTs - a.lastTs // 未导入(0)在前, 再 lastTs 倒序
    })
}
