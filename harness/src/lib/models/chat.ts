// OpenAI Chat Completions 协议编解码(spec §6.2),含各家供应商差异(quirks)
import type { Message, ModelError, ModelEvent, ModelRequest } from './types'

export type ChatQuirks = {
  thinking?: 'zai' | 'qwen' | 'deepseek'
  replayReasoningContent?: boolean
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  noDeveloperRole?: boolean
}

type Obj = Record<string, unknown>

export function buildChatBody(req: ModelRequest, quirks: ChatQuirks): object {
  const messages: Obj[] = []
  if (req.system !== undefined) messages.push({ role: quirks.noDeveloperRole ? 'system' : 'developer', content: req.system })
  for (const m of req.messages) messages.push(...chatMessages(m, quirks))
  const body: Obj = { model: req.model, messages, stream: true, stream_options: { include_usage: true } }
  if (req.tools?.length)
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  if (req.toolChoice) body.tool_choice = req.toolChoice
  if (req.maxOutput !== undefined) body[quirks.maxTokensField ?? 'max_tokens'] = req.maxOutput
  const off = req.reasoning === 'off'
  if (quirks.thinking === 'zai') body.thinking = { type: off ? 'disabled' : 'enabled' }
  else if (quirks.thinking === 'qwen') body.enable_thinking = !off
  else if (!quirks.thinking && req.reasoning && !off) body.reasoning_effort = req.reasoning
  return body
}

function chatMessages(m: Message, quirks: ChatQuirks): Obj[] {
  if (m.role === 'tool') {
    return m.parts.flatMap((p) => (p.type === 'tool_result' ? [{ role: 'tool', tool_call_id: p.callId, content: p.content }] : []))
  }
  if (m.role === 'user') {
    const out: Obj[] = []
    // tool_result 放在 user 消息里时也要拆成 tool 消息,且排在 user 内容之前
    for (const p of m.parts) if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.callId, content: p.content })
    const texts = m.parts.filter((p) => p.type === 'text' || p.type === 'image')
    if (texts.length) {
      const hasImage = texts.some((p) => p.type === 'image')
      const content = hasImage
        ? texts.map((p) =>
            p.type === 'image' ? { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } } : { type: 'text', text: p.type === 'text' ? p.text : '' },
          )
        : texts.map((p) => (p.type === 'text' ? p.text : '')).join('')
      out.push({ role: 'user', content }) // tool 消息必须紧跟 assistant tool_calls,故在前
    }
    return out
  }
  const msg: Obj = { role: 'assistant' }
  let text = ''
  const calls: Obj[] = []
  for (const p of m.parts) {
    if (p.type === 'text') text += p.text
    else if (p.type === 'tool_call') calls.push({ id: p.id, type: 'function', function: { name: p.name, arguments: p.args } })
    else if (p.type === 'reasoning' && quirks.replayReasoningContent) {
      const rc = (p.replay as { reasoning_content?: string } | undefined)?.reasoning_content
      if (rc !== undefined) msg.reasoning_content = rc
    }
  }
  msg.content = text || (calls.length ? null : '')
  if (calls.length) msg.tool_calls = calls
  return [msg]
}

export function mapChatError(code: string | undefined, type: string | undefined, message: string): ModelError {
  const c = `${code ?? ''} ${type ?? ''}`
  const n = Number(code)
  if (n === 429) return { kind: 'rate_limit', message, retryable: true }
  if (n === 401 || n === 403) return { kind: 'auth', message, retryable: false }
  if (n === 400) return { kind: 'bad_request', message, retryable: false }
  if (n >= 500 && n < 600) return { kind: 'unavailable', message, retryable: true }
  if (c.includes('rate_limit')) return { kind: 'rate_limit', message, retryable: true }
  if (c.includes('insufficient_quota') || c.includes('quota') || c.includes('billing')) return { kind: 'quota', message, retryable: false }
  if (c.includes('invalid_request') || c.includes('context_length')) return { kind: 'bad_request', message, retryable: false }
  if (c.includes('server_error') || c.includes('overloaded')) return { kind: 'unavailable', message, retryable: true }
  return { kind: 'unavailable', message, retryable: false }
}

interface Chunk {
  choices?: {
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null
  error?: { code?: string | number; type?: string; message?: string }
}

const REASONS: Record<string, 'stop' | 'length' | 'tool_calls'> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
  content_filter: 'stop',
}

export async function* decodeChatStream(events: AsyncIterable<{ event?: string; data: string }>): AsyncIterable<ModelEvent> {
  const ids = new Map<number, string>() // tool call index → id
  let reasoning = ''
  let finish: string | undefined
  let received = false // 收到过任何内容/用量
  let hasCall = false
  let usage: ModelEvent | undefined
  const reasonOf = (): 'stop' | 'length' | 'tool_calls' => {
    const r = REASONS[finish ?? 'stop'] ?? 'stop'
    return r === 'stop' && hasCall ? 'tool_calls' : r // 部分供应商有工具调用也报 stop
  }
  const tail = function* (): Iterable<ModelEvent> {
    if (reasoning) yield { type: 'reasoning', replay: { reasoning_content: reasoning } }
    if (usage) yield usage
  }
  try {
    for await (const e of events) {
      if (e.data.trim() === '[DONE]') {
        if (finish === undefined && !received) break // 什么都没收到的 [DONE] 视为异常
        yield* tail()
        yield { type: 'done', reason: reasonOf() }
        return
      }
      let f: Chunk
      try {
        f = JSON.parse(e.data) as Chunk
      } catch {
        continue
      }
      if (f.error) {
        yield { type: 'done', reason: 'error', error: mapChatError(f.error.code !== undefined ? String(f.error.code) : undefined, f.error.type, f.error.message ?? 'stream error') }
        return
      }
      if (f.usage) {
        received = true
        const cached = f.usage.prompt_tokens_details?.cached_tokens
        usage = {
          type: 'usage',
          input: f.usage.prompt_tokens ?? 0,
          output: f.usage.completion_tokens ?? 0,
          ...(cached !== undefined && { cacheRead: cached }),
        }
      }
      for (const ch of f.choices ?? []) {
        const d = ch.delta
        if (d?.reasoning_content) {
          reasoning += d.reasoning_content
          received = true
          yield { type: 'reasoning', delta: d.reasoning_content }
        }
        if (d?.content) received = true
        if (d?.content) yield { type: 'text', delta: d.content }
        for (const tc of d?.tool_calls ?? []) {
          const idx = tc.index ?? 0
          if (tc.id) ids.set(idx, tc.id)
          const id = ids.get(idx)
          if (!id) continue
          const args = tc.function?.arguments ?? ''
          if (tc.id || args) hasCall = received = true
          if (tc.id || args) yield { type: 'tool_call', id, ...(tc.function?.name && { name: tc.function.name }), argsDelta: args }
        }
        if (ch.finish_reason) finish = ch.finish_reason
      }
    }
  } catch (err) {
    yield { type: 'done', reason: 'error', error: { kind: 'network', message: err instanceof Error ? err.message : String(err), retryable: true } }
    return
  }
  if (finish !== undefined) {
    // 部分供应商不发 [DONE]:见过 finish_reason 的 EOF 视为正常结束
    yield* tail()
    yield { type: 'done', reason: reasonOf() }
    return
  }
  yield { type: 'done', reason: 'error', error: { kind: 'network', message: 'stream ended before completion', retryable: true } }
}
