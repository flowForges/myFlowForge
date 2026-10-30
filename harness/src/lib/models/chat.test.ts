import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildChatBody, decodeChatStream } from './chat'
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
  for await (const e of decodeChatStream(src)) out.push(e)
  return out
}
const run = (name: string) => decode(replayText(fixture(name)))

describe('decodeChatStream', () => {
  it('text + usage with cached tokens', async () => {
    expect(await run('chat-text.txt')).toEqual([
      { type: 'text', delta: '你好' },
      { type: 'text', delta: ', world' },
      { type: 'usage', input: 12, output: 5, cacheRead: 4 },
      { type: 'done', reason: 'stop' },
    ])
  })

  it('parallel tool calls keyed by index', async () => {
    expect(await run('chat-tool.txt')).toEqual([
      { type: 'tool_call', id: 'call_1', name: 'read_file', argsDelta: '' },
      { type: 'tool_call', id: 'call_1', argsDelta: '{"path":' },
      { type: 'tool_call', id: 'call_2', name: 'list_dir', argsDelta: '' },
      { type: 'tool_call', id: 'call_1', argsDelta: '"a.txt"}' },
      { type: 'tool_call', id: 'call_2', argsDelta: '{}' },
      { type: 'usage', input: 8, output: 9 },
      { type: 'done', reason: 'tool_calls' },
    ])
  })

  it('reasoning_content deltas then replay before text/usage', async () => {
    expect(await run('chat-reasoning-content.txt')).toEqual([
      { type: 'reasoning', delta: 'Thinking ' },
      { type: 'reasoning', delta: 'hard.' },
      { type: 'text', delta: '42' },
      { type: 'reasoning', replay: { reasoning_content: 'Thinking hard.' } },
      { type: 'usage', input: 20, output: 30 },
      { type: 'done', reason: 'stop' },
    ])
  })

  it('EOF without finish_reason is a retryable network error', async () => {
    const ev = await run('chat-cut.txt')
    expect(ev.slice(0, 2)).toEqual([
      { type: 'text', delta: 'par' },
      { type: 'text', delta: 'tial' },
    ])
    expect(ev[2]).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'network', retryable: true } })
  })

  it('EOF after finish_reason without [DONE] completes; length/content_filter map', async () => {
    const mk = (r: string) => `data: {"choices":[{"delta":{"content":"x"},"finish_reason":"${r}"}]}\n\n`
    expect((await decode(replayText(mk('length')))).at(-1)).toEqual({ type: 'done', reason: 'length' })
    expect((await decode(replayText(mk('content_filter')))).at(-1)).toEqual({ type: 'done', reason: 'stop' })
    expect((await decode(replayText(mk('function_call')))).at(-1)).toEqual({ type: 'done', reason: 'tool_calls' })
  })

  it('in-stream error chunk maps to done{error}', async () => {
    const ev = await decode(replayText('data: {"error":{"code":"rate_limit_exceeded","message":"slow down"}}\n\n'))
    expect(ev).toEqual([{ type: 'done', reason: 'error', error: { kind: 'rate_limit', message: 'slow down', retryable: true } }])
    const q = await decode(replayText('data: {"error":{"type":"insufficient_quota","message":"no"}}\n\n'))
    expect(q[0]).toMatchObject({ error: { kind: 'quota', retryable: false } })
  })
})

const base: ModelRequest = {
  model: 'm',
  system: 'sys',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  interactive: true,
  signal: new AbortController().signal,
}

describe('buildChatBody', () => {
  it('basic shape: developer role, stream options, max_tokens, tools', () => {
    const body = buildChatBody({ ...base, maxOutput: 100, tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }] }, {})
    expect(body).toEqual({
      model: 'm',
      messages: [
        { role: 'developer', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }],
      max_tokens: 100,
    })
  })

  it('noDeveloperRole and maxTokensField', () => {
    const body = buildChatBody({ ...base, maxOutput: 5 }, { noDeveloperRole: true, maxTokensField: 'max_completion_tokens' }) as any
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(body.max_completion_tokens).toBe(5)
    expect(body.max_tokens).toBeUndefined()
  })

  it('thinking quirks', () => {
    const b = (reasoning: ModelRequest['reasoning'], q: object) => buildChatBody({ ...base, reasoning }, q) as any
    expect(b('off', { thinking: 'zai' }).thinking).toEqual({ type: 'disabled' })
    expect(b('high', { thinking: 'zai' }).thinking).toEqual({ type: 'enabled' })
    expect(b('off', { thinking: 'qwen' }).enable_thinking).toBe(false)
    expect(b('low', { thinking: 'qwen' }).enable_thinking).toBe(true)
    const ds = b('high', { thinking: 'deepseek' })
    expect(ds.thinking).toBeUndefined()
    expect(ds.enable_thinking).toBeUndefined()
    expect(ds.reasoning_effort).toBeUndefined()
    expect(b('medium', {}).reasoning_effort).toBe('medium')
    expect(b('off', {}).reasoning_effort).toBeUndefined()
  })

  it('images, assistant tool_calls, tool results, reasoning replay', () => {
    const req: ModelRequest = {
      ...base,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'look' }, { type: 'image', mime: 'image/png', data: 'AAA' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'r', replay: { reasoning_content: 'because' } },
            { type: 'text', text: 'ok' },
            { type: 'tool_call', id: 'c1', name: 'f', args: '{"a":1}' },
          ],
        },
        { role: 'tool', parts: [{ type: 'tool_result', callId: 'c1', content: 'res' }] },
      ],
    }
    const withReplay = (buildChatBody(req, { replayReasoningContent: true }) as any).messages
    expect(withReplay[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    })
    expect(withReplay[2]).toEqual({
      role: 'assistant',
      content: 'ok',
      reasoning_content: 'because',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
    })
    expect(withReplay[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'res' })
    expect((buildChatBody(req, {}) as any).messages[2].reasoning_content).toBeUndefined()
  })
})
