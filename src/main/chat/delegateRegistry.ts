// In-memory registry of lightweight-delegation sub-agents, keyed by `${wsPath}::${sessionId}`. Delegate
// runs are ephemeral (no RunStore / runId), so the IDs panel can't find them via readRun. This registry
// records each delegate batch's sub-agents so composeAgentSessions can surface them (and their CLI
// session ids once known). Replaced per batch; survives until the next batch or process exit — it's a
// diagnostic aid, not persisted state.

export interface DelegateAgentRow {
  agentId: string
  name: string
  provider: string
  sessionId: string   // CLI session id once onSession fires; the agentId is a placeholder until then
  status: 'run' | 'ok' | 'idle'
  depth?: number      // 1 = delegate sub-agent (default); 2 = grand-agent (a sub-agent's own Task)
  parentId?: string   // for depth 2: the delegate sub-agent that spawned it
}

const reg = new Map<string, DelegateAgentRow[]>()
const key = (ws: string, sid: string) => `${ws}::${sid}`

/** Replace the delegate sub-agent list for this chat session (called at the start of each delegate). */
export function startDelegateBatch(ws: string, sid: string, rows: DelegateAgentRow[]): void {
  reg.set(key(ws, sid), rows)
}

/** Append a single agent (e.g. a grand-agent discovered mid-run) to this session's list. */
export function addDelegateAgent(ws: string, sid: string, row: DelegateAgentRow): void {
  const list = reg.get(key(ws, sid))
  if (list && !list.some(x => x.agentId === row.agentId)) list.push(row)
}

export function updateDelegateSession(ws: string, sid: string, agentId: string, sessionId: string): void {
  const r = reg.get(key(ws, sid))?.find(x => x.agentId === agentId)
  if (r) r.sessionId = sessionId
}

export function updateDelegateState(ws: string, sid: string, agentId: string, status: DelegateAgentRow['status']): void {
  const r = reg.get(key(ws, sid))?.find(x => x.agentId === agentId)
  if (r) r.status = status
}

export function listDelegateAgents(ws: string, sid: string): DelegateAgentRow[] {
  return reg.get(key(ws, sid)) ?? []
}
