import type { ChatSession, ImportedMessage } from '@shared/types'
import { readSessions } from './sessionStore'
import { readSession as readImported } from '../sessionImport/sources'
import { readMessages } from './chatStore'
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

// Fallback for IN-APP sessions (not imported from an external CLI). When a turn is "gapped" — the
// active provider has no native session to resume — the new CLI knows nothing of the prior turns.
// The classic trigger: the user switches provider mid-session (e.g. qoder → codex, or an auto-switch
// after a software update), so codex resumes an empty/foreign session and replies as if it knows
// nothing. Re-feed the recent conversation from Forge's OWN stored messages so context survives the
// switch. Clamped (30 turns / 40k tokens) to bound cost; empty for a brand-new session's first turn.
export function buildLocalHistoryPreamble(
  wsPath: string,
  sessionId: string,
  deps: { read?: (ws: string, sid: string) => ImportedMessage[] } = {},
): string {
  const read = deps.read ?? ((ws, sid) => readMessages(ws, sid).map(m => ({ who: m.who, text: m.text, ts: m.ts })))
  const msgs = read(wsPath, sessionId)
  const { kept, omitted } = clampHistory(msgs)
  return renderHistoryPreamble(kept, omitted)
}
