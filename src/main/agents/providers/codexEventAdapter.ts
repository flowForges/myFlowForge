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
 * ★★★占用量 = `last.inputTokens`,**一个数,什么都不加**。真机采样(2026-09-14,codex 0.153.4):
 *
 *      last.input=27351 cached=0     total.input=27351   window=258400
 *      last.input=27467 cached=27136 total.input=54818
 *      last.input=32958 cached=27264 total.input=87776
 *      last.input=33069 cached=32768 total.input=120845
 *
 *  · `last` 是**最近一次模型请求**的输入(不是整轮累加)—— 它随对话缓慢增长、始终低于窗口,
 *    正是「现在占了多少」。
 *  · `cachedInputTokens` 是 `inputTokens` 的**子集**(27136 之于 27467)。第一版把它们相加,
 *    等于把同一批 token 数了两三遍 —— 用户截图里出现过 `794.4K / 200.0K 100%`,就是这么来的。
 *  · `total` 是全线程累计,拿它当占用量会一路涨到 100% 再也下不来。
 *
 * ★这条和 claude 那边**不一样,别照抄**:Anthropic 的 usage 里 input/cache_read/cache_creation
 *  是三份**互不重叠**的数,所以那边要相加(见 chatStream 的 extractContextTokens)。
 *  同一个概念在两家 API 里的拆法不同 —— 这正是「必须按各家官方语义读」的理由。
 *
 * ★`modelContextWindow` 在 schema 里是可空的,缺席就是「不知道」,不许拿别处的数去补。
 */
export function codexTokenUsage(msg: any): { used: number; window?: number } | null {
  if (msg?.method !== 'thread/tokenUsage/updated') return null
  const tu = msg.params?.tokenUsage
  const last = tu?.last
  if (!last || typeof last !== 'object') return null
  const used = typeof last.inputTokens === 'number' && last.inputTokens > 0 ? last.inputTokens : 0
  const w = tu.modelContextWindow
  return { used, window: typeof w === 'number' && w > 0 ? w : undefined }
}
