// In-memory registry of the main agent's NATIVE Task sub-agents (Claude's Task tool etc.), keyed by
// `${wsPath}::${sessionId}`. These run in a child process of the CLI and expose no CLI session id — they
// only surface as start + result on the parent stream (see chatService.onSubagent). They already render
// as SubagentCards inline in the chat, but the IDs panel (composeAgentSessions) had no source for them —
// this registry is that source, mirroring delegateRegistry so the panel shows the main→sub structure for
// native sub-agents too. Replaced each turn; diagnostic only, never persisted.

export interface NativeSubagentRow {
  id: string          // the Task tool_use id (also the placeholder identity — no CLI session id exists)
  name: string        // description / subagentType / fallback
  provider: string    // the main agent's provider (the sub-agent runs under the same CLI)
  status: 'run' | 'ok' | 'idle'
}

const reg = new Map<string, NativeSubagentRow[]>()
const key = (ws: string, sid: string) => `${ws}::${sid}`

/** Replace this session's native sub-agent list (called each turn from chatService.onSubagent; reset to
 *  [] at turn start so a turn with no Task sub-agents doesn't keep showing the previous turn's). */
export function setNativeSubagents(ws: string, sid: string, rows: NativeSubagentRow[]): void {
  reg.set(key(ws, sid), rows)
}

export function listNativeSubagents(ws: string, sid: string): NativeSubagentRow[] {
  return reg.get(key(ws, sid)) ?? []
}
