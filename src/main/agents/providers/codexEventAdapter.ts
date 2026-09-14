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
  // 老版本 codex 用这条通知报「上下文压缩完了」(新版本改成 contextCompaction item 的
  // started/completed)。转成 exec 那边同名的形状,让 codexCompactionPhase 一处认两代协议。
  if (method === 'thread/compacted') return { type: 'thread.compacted' }
  if (method === 'item/started' && p.item) return { type: 'item.started', item: normItem(p.item) }
  if (method === 'error') {
    const m = p.error && typeof p.error === 'object' ? p.error.message : (p.message ?? p.error)
    return { type: 'error', error: { message: String(m ?? 'codex error') } }
  }
  return null
}

/**
 * `thread/tokenUsage/updated` → 上下文用量。**codex 是唯一一个把已用和窗口都官方给全的 provider**,
 * 所以只有它能画出可信的占比条。
 *
 * ★取 `last` 不取 `total`:`total` 是整个 thread 的累计,拿它当「现在占了多少」会让进度条虚高到
 *  100%(和 claude 那边刻意跳过 `result` 事件是同一个道理,见 chatStream 的 extractContextTokens)。
 * ★只算输入侧(input + 缓存读 + 缓存写)。生成出来的 output / reasoning 不是当前占用 ——
 *  它们要到下一轮才变成输入。
 * ★`modelContextWindow` 在 schema 里是可空的,缺席就是「不知道」,不许拿别处的数去补。
 */
export function codexTokenUsage(msg: any): { used: number; window?: number } | null {
  if (msg?.method !== 'thread/tokenUsage/updated') return null
  const tu = msg.params?.tokenUsage
  const last = tu?.last
  if (!last || typeof last !== 'object') return null
  const n = (x: any) => (typeof x === 'number' && x > 0 ? x : 0)
  const used = n(last.inputTokens) + n(last.cachedInputTokens) + n(last.cacheWriteInputTokens)
  const w = tu.modelContextWindow
  return { used, window: typeof w === 'number' && w > 0 ? w : undefined }
}
