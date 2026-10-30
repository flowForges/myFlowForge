// Anthropic Messages 协议编解码(spec §6.3)
import type { Message, ModelError, ModelEvent, ModelRequest } from './types'

export type AnthropicQuirks = { forceAdaptiveThinking?: boolean }

type Obj = Record<string, unknown>

const BUDGETS = { low: 2048, medium: 8192, high: 24576 } as const

export function buildAnthropicBody(req: ModelRequest, quirks: AnthropicQuirks): object {
  const messages: { role: 'user' | 'assistant'; content: Obj[] }[] = []
  for (const m of req.messages) {
    const converted = anthropicMessage(m)
    if (!converted.content.length) continue
    const last = messages.at(-1)
    if (last && last.role === converted.role) last.content.push(...converted.content) // 必须角色交替
    else messages.push(converted)
  }
  // tool_result 必须排在 user 消息内容最前
  for (const m of messages)
    if (m.role === 'user') m.content = [...m.content.filter((b) => b.type === 'tool_result'), ...m.content.filter((b) => b.type !== 'tool_result')]
  let maxTokens = req.maxOutput ?? 8192
  let thinking: Obj | undefined
  if (req.reasoning && req.reasoning !== 'off') {
    if (quirks.forceAdaptiveThinking) thinking = { type: 'adaptive' }
    else {
      const want = BUDGETS[req.reasoning]
      if (req.maxOutput === undefined) {
        maxTokens = want + 8192 // budget_tokens 必须小于 max_tokens
        thinking = { type: 'enabled', budget_tokens: want }
      } else {
        const budget = Math.min(want, req.maxOutput - 1)
        if (budget >= 1024) thinking = { type: 'enabled', budget_tokens: budget } // 最小预算 1024,不够就不开
      }
    }
  }
  const body: Obj = { model: req.model, messages, max_tokens: maxTokens, stream: true }
  if (thinking) body.thinking = thinking
  if (req.system !== undefined) body.system = req.system
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  if (req.toolChoice && req.tools?.length) body.tool_choice = { type: req.toolChoice }
  return body
}

function anthropicMessage(m: Message): { role: 'user' | 'assistant'; content: Obj[] } {
  if (m.role !== 'assistant') {
    const content: Obj[] = []
    for (const p of m.parts) {
      if (p.type === 'text') content.push({ type: 'text', text: p.text })
      else if (p.type === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } })
      else if (p.type === 'tool_result')
        content.push({ type: 'tool_result', tool_use_id: p.callId, content: p.content, ...(p.isError && { is_error: true }) })
    }
    return { role: 'user', content }
  }
  const thinking: Obj[] = []
  const rest: Obj[] = []
  for (const p of m.parts) {
    if (p.type === 'reasoning') {
      if (p.replay && typeof p.replay === 'object') thinking.push(p.replay as Obj)
    } else if (p.type === 'text') {
      if (p.text) rest.push({ type: 'text', text: p.text })
    } else if (p.type === 'tool_call') {
      let input: unknown = {}
      try {
        input = JSON.parse(p.args || '{}')
      } catch {
        input = {}
      }
      rest.push({ type: 'tool_use', id: p.id, name: p.name, input })
    }
  }
  return { role: 'assistant', content: [...thinking, ...rest] }
}

export function mapAnthropicError(type: string | undefined, message: string): ModelError {
  const n = Number(type)
  if (n === 429) return { kind: 'rate_limit', message, retryable: true }
  if (n === 401 || n === 403) return { kind: 'auth', message, retryable: false }
  if (n === 400) return { kind: 'bad_request', message, retryable: false }
  if (n >= 500 && n < 600) return { kind: 'unavailable', message, retryable: true }
  switch (type) {
    case 'overloaded_error':
    case 'api_error':
      return { kind: 'unavailable', message, retryable: true }
    case 'rate_limit_error':
      return { kind: 'rate_limit', message, retryable: true }
    case 'authentication_error':
    case 'permission_error':
      return { kind: 'auth', message, retryable: false }
    case 'invalid_request_error':
      return { kind: 'bad_request', message, retryable: false }
    default:
      return { kind: 'unavailable', message, retryable: false }
  }
}

interface Ev {
  type?: string
  index?: number
  message?: { usage?: Usage }
  content_block?: { type?: string; id?: string; name?: string; data?: string }
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string }
  usage?: Usage
  error?: { type?: string | number; message?: string }
}
interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

const REASONS: Record<string, 'stop' | 'length' | 'tool_calls'> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  refusal: 'stop',
}

type Block = { kind: 'thinking'; text: string; sig: string } | { kind: 'tool'; id: string } | { kind: 'other' }

export async function* decodeAnthropicStream(events: AsyncIterable<{ event?: string; data: string }>): AsyncIterable<ModelEvent> {
  const blocks = new Map<number, Block>()
  let input = 0
  let output = 0
  let cacheRead: number | undefined
  let cacheWrite: number | undefined
  let stopReason: string | undefined
  let hasCall = false
  try {
    for await (const e of events) {
      let f: Ev
      try {
        f = JSON.parse(e.data) as Ev
      } catch {
        continue
      }
      switch (f.type) {
        case 'message_start': {
          const u = f.message?.usage
          input = u?.input_tokens ?? 0
          output = u?.output_tokens ?? 0
          cacheRead = u?.cache_read_input_tokens
          cacheWrite = u?.cache_creation_input_tokens
          break
        }
        case 'content_block_start': {
          const cb = f.content_block
          const idx = f.index ?? 0
          if (cb?.type === 'thinking') blocks.set(idx, { kind: 'thinking', text: '', sig: '' })
          else if (cb?.type === 'tool_use' && cb.id) {
            hasCall = true
            blocks.set(idx, { kind: 'tool', id: cb.id })
            yield { type: 'tool_call', id: cb.id, name: cb.name ?? '', argsDelta: '' }
          } else {
            blocks.set(idx, { kind: 'other' })
            if (cb?.type === 'redacted_thinking') yield { type: 'reasoning', replay: { type: 'redacted_thinking', data: cb.data ?? '' } }
          }
          break
        }
        case 'content_block_delta': {
          const d = f.delta
          const b = blocks.get(f.index ?? 0)
          if (d?.type === 'text_delta' && d.text) yield { type: 'text', delta: d.text }
          else if (d?.type === 'thinking_delta' && d.thinking) {
            if (b?.kind === 'thinking') b.text += d.thinking
            yield { type: 'reasoning', delta: d.thinking }
          } else if (d?.type === 'signature_delta' && d.signature) {
            if (b?.kind === 'thinking') b.sig += d.signature
          } else if (d?.type === 'input_json_delta' && d.partial_json && b?.kind === 'tool') {
            yield { type: 'tool_call', id: b.id, argsDelta: d.partial_json }
          }
          break
        }
        case 'content_block_stop': {
          const b = blocks.get(f.index ?? 0)
          if (b?.kind === 'thinking' && b.sig) yield { type: 'reasoning', replay: { type: 'thinking', thinking: b.text, signature: b.sig } }
          blocks.delete(f.index ?? 0)
          break
        }
        case 'message_delta': {
          if (f.delta?.stop_reason) stopReason = f.delta.stop_reason
          if (f.usage?.output_tokens !== undefined) output = f.usage.output_tokens
          break
        }
        case 'message_stop': {
          yield { type: 'usage', input, output, ...(cacheRead !== undefined && { cacheRead }), ...(cacheWrite !== undefined && { cacheWrite }) }
          const r = REASONS[stopReason ?? 'end_turn'] ?? 'stop'
          yield { type: 'done', reason: r === 'stop' && hasCall ? 'tool_calls' : r }
          return
        }
        case 'error': {
          yield { type: 'done', reason: 'error', error: mapAnthropicError(f.error?.type !== undefined ? String(f.error.type) : undefined, f.error?.message ?? 'stream error') }
          return
        }
      }
    }
  } catch (err) {
    yield { type: 'done', reason: 'error', error: { kind: 'network', message: err instanceof Error ? err.message : String(err), retryable: true } }
    return
  }
  yield { type: 'done', reason: 'error', error: { kind: 'network', message: 'stream ended before completion', retryable: true } }
}
