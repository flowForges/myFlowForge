import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAnthropicBody, decodeAnthropicStream } from './anthropic'
import { parseSSE } from './sse'
import type { ModelEvent, ModelRequest } from './types'

const fixture = (name: string) => readFileSync(join(__dirname, '../../../test/fixtures/sse', name), 'utf8')
function replayText(text: string): AsyncIterable<{ event?: string; data: string }> {
  const bytes = new TextEncoder().encode(text)
  return parseSSE(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7))
        c.close()
      },
    }),
  )
}
const decode = async (src: AsyncIterable<{ event?: string; data: string }>) => {
  const out: ModelEvent[] = []
  for await (const e of decodeAnthropicStream(src)) out.push(e)
  return out
}
const run = (name: string) => decode(replayText(fixture(name)))
const errEv = (type: string) => `event: error\ndata: {"type":"error","error":{"type":"${type}","message":"m"}}\n\n`

describe('decodeAnthropicStream', () => {
  it('text + usage (cache read/write)', async () => {
    expect(await run('anthropic-text.txt')).toEqual([
      { type: 'text', delta: '你好' },
      { type: 'text', delta: ', world' },
      { type: 'usage', input: 25, output: 7, cacheRead: 10, cacheWrite: 3 },
      { type: 'done', reason: 'stop' },
    ])
  })

  it('thinking deltas, replay with signature, redacted_thinking', async () => {
    expect(await run('anthropic-thinking.txt')).toEqual([
      { type: 'reasoning', delta: 'Let me ' },
      { type: 'reasoning', delta: 'think.' },
      { type: 'reasoning', replay: { type: 'thinking', thinking: 'Let me think.', signature: 'sig-abc' } },
      { type: 'reasoning', replay: { type: 'redacted_thinking', data: 'REDACTED==' } },
      { type: 'text', delta: '42' },
      { type: 'usage', input: 30, output: 20 },
      { type: 'done', reason: 'stop' },
    ])
  })

  it('tool_use with input_json deltas', async () => {
    expect(await run('anthropic-tool.txt')).toEqual([
      { type: 'text', delta: 'Reading.' },
      { type: 'tool_call', id: 'toolu_1', name: 'read_file', argsDelta: '' },
      { type: 'tool_call', id: 'toolu_1', argsDelta: '{"path":' },
      { type: 'tool_call', id: 'toolu_1', argsDelta: '"a.txt"}' },
      { type: 'usage', input: 50, output: 15 },
      { type: 'done', reason: 'tool_calls' },
    ])
  })

  it('end_turn with tool_use seen still reports tool_calls; max_tokens/refusal map', async () => {
    const t = fixture('anthropic-tool.txt').replace('"stop_reason":"tool_use"', '"stop_reason":"end_turn"')
    expect((await decode(replayText(t))).at(-1)).toEqual({ type: 'done', reason: 'tool_calls' })
    const x = (r: string) => fixture('anthropic-text.txt').replace('"end_turn"', `"${r}"`)
    expect((await decode(replayText(x('max_tokens')))).at(-1)).toEqual({ type: 'done', reason: 'length' })
    expect((await decode(replayText(x('refusal')))).at(-1)).toEqual({ type: 'done', reason: 'stop' })
    expect((await decode(replayText(x('stop_sequence')))).at(-1)).toEqual({ type: 'done', reason: 'stop' })
  })

  it('error event maps to done{error}', async () => {
    expect(await run('anthropic-error.txt')).toEqual([
      { type: 'done', reason: 'error', error: { kind: 'unavailable', message: 'Overloaded', retryable: true } },
    ])
    const k = async (t: string) => ((await decode(replayText(errEv(t))))[0] as any).error
    expect(await k('rate_limit_error')).toMatchObject({ kind: 'rate_limit', retryable: true })
    expect(await k('authentication_error')).toMatchObject({ kind: 'auth', retryable: false })
    expect(await k('permission_error')).toMatchObject({ kind: 'auth' })
    expect(await k('invalid_request_error')).toMatchObject({ kind: 'bad_request', retryable: false })
    expect(await k('api_error')).toMatchObject({ kind: 'unavailable', retryable: true })
    expect(await k('429')).toMatchObject({ kind: 'rate_limit' })
    expect(await k('503')).toMatchObject({ kind: 'unavailable', retryable: true })
  })

  it('EOF without message_stop is a retryable network error', async () => {
    const ev = await run('anthropic-cut.txt')
    expect(ev.slice(0, 2)).toEqual([
      { type: 'text', delta: 'par' },
      { type: 'text', delta: 'tial' },
    ])
    expect(ev[2]).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'network', retryable: true } })
  })

  it('empty stream is a network error', async () => {
    expect((await decode(replayText('')))[0]).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'network', retryable: true } })
  })
})

const base: ModelRequest = {
  model: 'm',
  system: 'sys',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  interactive: true,
  signal: new AbortController().signal,
}

describe('buildAnthropicBody', () => {
  it('basic shape: system, default max_tokens, tools', () => {
    const body = buildAnthropicBody({ ...base, tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }] }, {})
    expect(body).toEqual({
      model: 'm',
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 8192,
      stream: true,
      tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
    })
    expect((buildAnthropicBody({ ...base, maxOutput: 99 }, {}) as any).max_tokens).toBe(99)
  })

  it('thinking budgets and adaptive', () => {
    const b = (reasoning: ModelRequest['reasoning'], q = {}) => (buildAnthropicBody({ ...base, reasoning }, q) as any).thinking
    expect(b('low')).toEqual({ type: 'enabled', budget_tokens: 2048 })
    expect(b('medium')).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(b('high')).toEqual({ type: 'enabled', budget_tokens: 24576 })
    expect(b('high', { forceAdaptiveThinking: true })).toEqual({ type: 'adaptive' })
    expect(b('off')).toBeUndefined()
    expect(b(undefined)).toBeUndefined()
  })

  it('assistant: replay blocks first, tool_use input parsed (invalid → {}); tool results in next user message', () => {
    const req: ModelRequest = {
      ...base,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'go' }, { type: 'image', mime: 'image/png', data: 'AAA' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'text', text: 'ok' },
            { type: 'tool_call', id: 'c1', name: 'f', args: '{"a":1}' },
            { type: 'tool_call', id: 'c2', name: 'g', args: '{bad' },
            { type: 'reasoning', text: 'r', replay: { type: 'thinking', thinking: 'r', signature: 's' } },
            { type: 'reasoning', replay: { type: 'redacted_thinking', data: 'D' } },
          ],
        },
        { role: 'tool', parts: [{ type: 'tool_result', callId: 'c1', content: 'res' }, { type: 'tool_result', callId: 'c2', content: 'bad', isError: true }] },
      ],
    }
    const m = (buildAnthropicBody(req, {}) as any).messages
    expect(m[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } })
    expect(m[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'r', signature: 's' },
        { type: 'redacted_thinking', data: 'D' },
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } },
        { type: 'tool_use', id: 'c2', name: 'g', input: {} },
      ],
    })
    expect(m[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: 'res' },
        { type: 'tool_result', tool_use_id: 'c2', content: 'bad', is_error: true },
      ],
    })
  })

  it('merges consecutive same-role messages; tool_result precedes text', () => {
    const req: ModelRequest = {
      ...base,
      messages: [
        { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'f', args: '{}' }] },
        { role: 'tool', parts: [{ type: 'tool_result', callId: 'c1', content: 'r' }] },
        { role: 'user', parts: [{ type: 'text', text: 'next' }] },
      ],
    }
    const m = (buildAnthropicBody(req, {}) as any).messages
    expect(m).toHaveLength(2)
    expect(m[1].content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'r' },
      { type: 'text', text: 'next' },
    ])
    const u = (buildAnthropicBody({ ...base, messages: [{ role: 'user', parts: [{ type: 'text', text: 'a' }] }, { role: 'user', parts: [{ type: 'text', text: 'b' }] }] }, {}) as any).messages
    expect(u).toEqual([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }])
  })
})
