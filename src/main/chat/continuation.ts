import type { ChatSession, ImportedMessage } from '@shared/types'
import { readSessions } from './sessionStore'
import { readSession as readImported } from '../sessionImport/sources'
import { clampHistory, renderHistoryPreamble } from './contextRebuild'

export function buildContinuationPreamble(
  wsPath: string,
  sessionId: string,
  deps: {
    sessions?: ChatSession[]
    read?: (s: { source: string; externalId: string; cwd: string; filePaths: string[]; title: string; startedAt: number; lastTs: number; messageCount: number; hasBody: boolean }) => ImportedMessage[]
  } = {},
): string {
  const sessions = deps.sessions ?? readSessions(wsPath).sessions
  const s = sessions.find(x => x.id === sessionId)
  if (!s?.continuedFrom || !s.external) return ''
  const read = deps.read ?? readImported
  const msgs = read({
    source: s.external.source,
    externalId: s.external.externalId,
    cwd: wsPath,
    filePaths: s.external.filePaths,
    title: s.title,
    startedAt: 0,
    lastTs: 0,
    messageCount: 0,
    hasBody: true,
  })
  const { kept, omitted } = clampHistory(msgs)
  return renderHistoryPreamble(kept, omitted)
}
