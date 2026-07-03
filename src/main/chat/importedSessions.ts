import type { ChatSession, ImportedIndex } from '@shared/types'
import { readIndex as readIndexDefault } from '../sessionImport/importStore'

export function deriveImportedSessions(
  cwd: string,
  deps: { readIndex?: () => ImportedIndex } = {},
): ChatSession[] {
  const readIndex = deps.readIndex ?? readIndexDefault
  return readIndex().sessions
    .filter(s => s.cwd === cwd)
    .sort((a, b) => b.lastTs - a.lastTs)
    .map(s => ({
      id: `ext-${s.source}-${s.externalId}`,
      title: s.title,
      mode: 'chat' as const,
      createdAt: s.startedAt,
      readonly: true as const,
      external: { source: s.source, externalId: s.externalId, filePaths: s.filePaths },
    }))
}
