// codex app-server (v2) event → codex `exec --json` event shape, so the EXISTING parseCodexEvent /
// codexToolActivity / codexErrorMessage in codex.ts consume app-server output unchanged. Pure; no I/O.
const ITEM_TYPE: Record<string, string> = {
  agentMessage: 'agent_message', reasoning: 'reasoning',
  commandExecution: 'command_execution', fileChange: 'file_change', userMessage: 'user_message',
}
function normItem(it: any): any {
  if (!it || typeof it !== 'object') return it
  const type = ITEM_TYPE[String(it.type)] ?? it.type
  return { ...it, type }
}
export function adaptCodexEvent(msg: any): any | null {
  const method: string | undefined = msg?.method
  if (!method) return null
  const p = msg.params ?? {}
  if (method === 'item/agentMessage/delta') {
    const delta = typeof p.delta === 'string' ? p.delta : (typeof p.text === 'string' ? p.text : '')
    return delta ? { msg: { type: 'agent_message_delta', delta } } : null
  }
  if (method === 'item/completed' && p.item) return { type: 'item.completed', item: normItem(p.item) }
  if (method === 'item/started' && p.item) return { type: 'item.started', item: normItem(p.item) }
  if (method === 'error') {
    const m = p.error && typeof p.error === 'object' ? p.error.message : (p.message ?? p.error)
    return { type: 'error', error: { message: String(m ?? 'codex error') } }
  }
  return null
}
