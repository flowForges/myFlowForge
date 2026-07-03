import { SOURCES } from './sources'
import { BUILTIN_PROVIDERS } from '@shared/providerCatalog'
import type { SessionImportCoverage } from '@shared/types'

const REASONS: Record<string, string> = {
  gemini: '会话记录存储在云端，暂不支持本地导入',
}
const DEFAULT_REASON = '无本地会话记录，暂不支持导入'

export function computeCoverage(
  sourceIds: string[],
  providers: { id: string; displayName: string }[],
): SessionImportCoverage {
  const supp = new Set(sourceIds)
  const supported = providers
    .filter(p => supp.has(p.id))
    .map(p => ({ id: p.id, label: p.displayName }))
  const unsupported = providers
    .filter(p => !supp.has(p.id))
    .map(p => ({ id: p.id, label: p.displayName, reason: REASONS[p.id] ?? DEFAULT_REASON }))
  return { supported, unsupported }
}

export function sessionImportCoverage(): SessionImportCoverage {
  return computeCoverage(
    SOURCES.map(s => s.id),
    BUILTIN_PROVIDERS.map(p => ({ id: p.id, displayName: p.displayName })),
  )
}
