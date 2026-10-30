// OpenAI Responses 协议编解码(spec §6.2),model-openai 与 model-chatgpt 共用
import type { Message, ModelError, ModelEvent, ModelRequest, Part } from './types'

export interface ResponsesBodyOpts {
  store: boolean
  includeEncryptedReasoning: boolean
}

type Item = Record<string, unknown>

export function buildResponsesBody(req: ModelRequest, opts: ResponsesBodyOpts): object {
  const body: Record<string, unknown> = {
    model: req.model,
    input: req.messages.flatMap((m) => messageItems(m, opts)),
    stream: true,
    store: opts.store,
  }
  if (req.system !== undefined) body.instructions = req.system
  if (req.tools?.length)
    body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }))
  if (req.toolChoice && req.tools?.length) body.tool_choice = req.toolChoice
  if (req.reasoning && req.reasoning !== 'off') body.reasoning = { effort: req.reasoning, summary: 'auto' }
  if (opts.includeEncryptedReasoning) body.include = ['reasoning.encrypted_content']
  if (req.maxOutput !== undefined) body.max_output_tokens = req.maxOutput
  return body
}

function messageItems(m: Message, opts: ResponsesBodyOpts): Item[] {
  const items: Item[] = []
  let content: Item[] = []
  const role = m.role === 'assistant' ? 'assistant' : 'user'
  const flush = () => {
    if (content.length) items.push({ type: 'message', role, content })
    content = []
  }
  for (const p of m.parts as Part[]) {
    switch (p.type) {
      case 'text':
        content.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: p.text })
        break
      case 'image':
        content.push({ type: 'input_image', image_url: `data:${p.mime};base64,${p.data}` })
        break
      case 'tool_call':
        flush()
        items.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: p.args })
        break
      case 'tool_result':
        flush()
        items.push({ type: 'function_call_output', call_id: p.callId, output: p.content })
        break
      case 'reasoning': {
        if (!opts.includeEncryptedReasoning || !p.replay) break
        flush()
        const r = p.replay as { id?: string; encrypted_content?: string; summary?: unknown }
        items.push({ type: 'reasoning', id: r.id, encrypted_content: r.encrypted_content, summary: r.summary ?? [] })
        break
      }
    }
  }
  flush()
  return items
}

export function mapResponsesError(code: string | undefined, message: string): ModelError {
  const c = code ?? ''
  if (c === 'rate_limit_exceeded') return { kind: 'rate_limit', message, retryable: true }
  if (c === 'insufficient_quota' || c.includes('usage_limit')) return { kind: 'quota', message, retryable: false }
  if (c === 'invalid_request_error' || c === 'invalid_prompt') return { kind: 'bad_request', message, retryable: false }
  if (c === 'server_error') return { kind: 'unavailable', message, retryable: true }
  return { kind: 'unavailable', message, retryable: false }
}

interface Frame {
  type?: string
  delta?: string
  item_id?: string
  item?: { id?: string; type?: string; call_id?: string; name?: string; arguments?: string; encrypted_content?: string; summary?: unknown }
  code?: string
  message?: string
  error?: { code?: string; message?: string }
  response?: {
    status?: string
    error?: { code?: string; message?: string }
    incomplete_details?: { reason?: string }
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }
  }
}

export async function* decodeResponsesStream(events: AsyncIterable<{ event?: string; data: string }>): AsyncIterable<ModelEvent> {
  const callIds = new Map<string, string>() // item id → call_id
  const streamed = new Set<string>() // 已流出参数增量的 item id
  let hasCall = false
  try {
    for await (const e of events) {
      let f: Frame
      try {
        f = JSON.parse(e.data) as Frame
      } catch {
        continue // 非 JSON 帧(如 [DONE])忽略
      }
      const type = e.event ?? f.type
      switch (type) {
        case 'response.output_text.delta':
          if (f.delta) yield { type: 'text', delta: f.delta }
          break
        case 'response.reasoning_summary_text.delta':
          if (f.delta) yield { type: 'reasoning', delta: f.delta }
          break
        case 'response.output_item.added': {
          const it = f.item
          if (it?.type === 'function_call' && it.id && it.call_id) {
            callIds.set(it.id, it.call_id)
            hasCall = true
            yield { type: 'tool_call', id: it.call_id, name: it.name, argsDelta: '' }
          }
          break
        }
        case 'response.function_call_arguments.delta': {
          const id = f.item_id && callIds.get(f.item_id)
          if (id && f.delta) {
            streamed.add(f.item_id!)
            yield { type: 'tool_call', id, argsDelta: f.delta }
          }
          break
        }
        case 'response.output_item.done': {
          const it = f.item
          if (!it) break
          if (it.type === 'function_call' && it.call_id) {
            if (!(it.id && callIds.has(it.id))) {
              hasCall = true
              yield { type: 'tool_call', id: it.call_id, name: it.name, argsDelta: '' }
            }
            if (!(it.id && streamed.has(it.id)) && it.arguments) yield { type: 'tool_call', id: it.call_id, argsDelta: it.arguments }
          } else if (it.type === 'reasoning' && it.encrypted_content) {
            yield { type: 'reasoning', replay: { id: it.id, encrypted_content: it.encrypted_content, summary: it.summary ?? [] } }
          }
          break
        }
        case 'response.completed':
        case 'response.incomplete': {
          const r = f.response
          const u = r?.usage
          yield {
            type: 'usage',
            input: u?.input_tokens ?? 0,
            output: u?.output_tokens ?? 0,
            ...(u?.input_tokens_details?.cached_tokens !== undefined && { cacheRead: u.input_tokens_details.cached_tokens }),
          }
          const length = r?.status === 'incomplete' && r.incomplete_details?.reason === 'max_output_tokens'
          yield { type: 'done', reason: length ? 'length' : hasCall ? 'tool_calls' : 'stop' }
          return
        }
        case 'response.failed':
        case 'error': {
          const err = f.response?.error ?? f.error ?? { code: f.code, message: f.message }
          yield { type: 'done', reason: 'error', error: mapResponsesError(err.code, err.message ?? 'response failed') }
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
