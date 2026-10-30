import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildResponsesBody, decodeResponsesStream } from './responses'
import { parseSSE } from './sse'
import type { ModelEvent, ModelRequest } from './types'

// 夹具 → ReadableStream → 真实 parseSSE → 解码器;每个夹具拆成小块以覆盖跨块
const fixture = (name: string) => readFileSync(join(__dirname, '../../../test/fixtures/sse', name), 'utf8')
function replay(name: string): AsyncIterable<{ event?: string; data: string }> {
  const bytes = new TextEncoder().encode(fixture(name))
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
  for await (const e of decodeResponsesStream(src)) out.push(e)
  return out
}

describe('decodeResponsesStream', () => {
  it('text + usage with cached tokens', async () => {
    expect(await decode(replay('responses-text.txt'))).toEqual([
      { type: 'text', delta: '你好' },
      { type: 'text', delta: ', world' },
      { type: 'usage', input: 12, output: 5, cacheRead: 4 },
      { type: 'done', reason: 'stop' },
    ])
  })

  it('reasoning summary deltas then replay item', async () => {
    expect(await decode(replay('responses-reasoning.txt'))).toEqual([
      { type: 'reasoning', delta: 'Thinking ' },
      { type: 'reasoning', delta: 'hard.' },
      { type: 'reasoning', replay: { id: 'rs_1', encrypted_content: 'ENC==', summary: [{ type: 'summary_text', text: 'Thinking hard.' }] } },
      { type: 'text', delta: '42' },
      { type: 'usage', input: 20, output: 30 },
      { type: 'done', reason: 'stop' },
    ])
  })

  it('function calls: streamed deltas, and full arguments when none streamed', async () => {
    expect(await decode(replay('responses-tool.txt'))).toEqual([
      { type: 'tool_call', id: 'call_1', name: 'read_file', argsDelta: '' },
      { type: 'tool_call', id: 'call_1', argsDelta: '{"path":' },
      { type: 'tool_call', id: 'call_1', argsDelta: '"a.txt"}' },
      { type: 'tool_call', id: 'call_2', name: 'list_dir', argsDelta: '' },
      { type: 'tool_call', id: 'call_2', argsDelta: '{}' },
      { type: 'usage', input: 8, output: 9, cacheRead: 0 },
      { type: 'done', reason: 'tool_calls' },
    ])
  })

  it('response.failed maps rate_limit_exceeded', async () => {
    expect(await decode(replay('responses-failed.txt'))).toEqual([
      { type: 'done', reason: 'error', error: { kind: 'rate_limit', message: 'Slow down', retryable: true } },
    ])
  })

  it('stream cut mid-response: partial text then done{network}', async () => {
    const out = await decode(replay('responses-cut.txt'))
    expect(out.slice(0, 2)).toEqual([
      { type: 'text', delta: 'partial ' },
      { type: 'text', delta: 'answer' },
    ])
    expect(out).toHaveLength(3)
    expect(out[2]).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'network' } })
  })

  it('socket reset (iterator throws) after deltas → done{network}', async () => {
    async function* boom() {
      yield { data: JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }) }
      throw new Error('ECONNRESET')
    }
    const out = await decode(boom())
    expect(out[0]).toEqual({ type: 'text', delta: 'hi' })
    expect(out[1]).toMatchObject({ type: 'done', reason: 'error', error: { kind: 'network', message: 'ECONNRESET' } })
  })

  it('incomplete max_output_tokens → length; error event code mapping', async () => {
    const mk = (o: object) => [{ event: (o as { type: string }).type, data: JSON.stringify(o) }]
    const toIter = async function* (xs: { event?: string; data: string }[]) {
      yield* xs
    }
    expect(
      await decode(toIter(mk({ type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 2 } } }))),
    ).toEqual([
      { type: 'usage', input: 1, output: 2 },
      { type: 'done', reason: 'length' },
    ])
    const kinds = async (code: string) =>
      ((await decode(toIter(mk({ type: 'error', code, message: 'm' })))).at(-1) as { error: unknown }).error
    expect(await kinds('insufficient_quota')).toMatchObject({ kind: 'quota', retryable: false })
    expect(await kinds('chatgpt_usage_limit_reached')).toMatchObject({ kind: 'quota' })
    expect(await kinds('invalid_prompt')).toMatchObject({ kind: 'bad_request' })
    expect(await kinds('server_error')).toMatchObject({ kind: 'unavailable', retryable: true })
    expect(await kinds('weird')).toMatchObject({ kind: 'unavailable', retryable: false })
  })
})

describe('buildResponsesBody', () => {
  const req: ModelRequest = {
    model: 'gpt-5',
    system: 'be brief',
    reasoning: 'medium',
    maxOutput: 100,
    interactive: true,
    signal: new AbortController().signal,
    tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'hi' }, { type: 'image', mime: 'image/png', data: 'AAAA' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', replay: { id: 'rs_1', encrypted_content: 'ENC', summary: [] } },
          { type: 'text', text: 'checking' },
          { type: 'tool_call', id: 'call_1', name: 'read_file', args: '{"path":"a"}' },
        ],
      },
      { role: 'tool', parts: [{ type: 'tool_result', callId: 'call_1', content: 'file body' }] },
    ],
  }

  it('maps history, tools, reasoning and include', () => {
    expect(buildResponsesBody(req, { store: false, includeEncryptedReasoning: true })).toEqual({
      model: 'gpt-5',
      instructions: 'be brief',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'medium', summary: 'auto' },
      max_output_tokens: 100,
      tools: [{ type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object' } }],
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
      ],
    })
  })

  it('omits reasoning replay/include, effort and max tokens when not applicable', () => {
    const body = buildResponsesBody({ ...req, reasoning: 'off', maxOutput: undefined }, { store: true, includeEncryptedReasoning: false }) as Record<string, unknown>
    expect(body.include).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.store).toBe(true)
    expect((body.input as { type: string }[]).some((i) => i.type === 'reasoning')).toBe(false)
  })

  it('toolChoice: unset → no field; "none" / "auto" map directly', () => {
    expect((buildResponsesBody(req, { store: false, includeEncryptedReasoning: true }) as Record<string, unknown>).tool_choice).toBeUndefined()
    expect((buildResponsesBody({ ...req, toolChoice: 'none' }, { store: false, includeEncryptedReasoning: true }) as Record<string, unknown>).tool_choice).toBe('none')
    expect((buildResponsesBody({ ...req, toolChoice: 'auto' }, { store: false, includeEncryptedReasoning: true }) as Record<string, unknown>).tool_choice).toBe('auto')
  })

  it('multi-round snapshot: text → assistant[reasoning, text, 2 tool_calls] → tool[result, result(isError)] → assistant text → user text', () => {
    const multi: ModelRequest = {
      model: 'gpt-5',
      interactive: true,
      signal: new AbortController().signal,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'first user text' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', replay: { id: 'rs_9', encrypted_content: 'ENC9', summary: [] } },
            { type: 'text', text: 'assistant text' },
            { type: 'tool_call', id: 'call_A', name: 'toolA', args: '{"a":1}' },
            { type: 'tool_call', id: 'call_B', name: 'toolB', args: '{"b":2}' },
          ],
        },
        {
          role: 'tool',
          parts: [
            { type: 'tool_result', callId: 'call_A', content: 'result A' },
            { type: 'tool_result', callId: 'call_B', content: 'result B', isError: true },
          ],
        },
        { role: 'assistant', parts: [{ type: 'text', text: 'final assistant text' }] },
        { role: 'user', parts: [{ type: 'text', text: 'final user text' }] },
      ],
    }
    const body = buildResponsesBody(multi, { store: false, includeEncryptedReasoning: true }) as Record<string, unknown>
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first user text' }] },
      { type: 'reasoning', id: 'rs_9', encrypted_content: 'ENC9', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'assistant text' }] },
      { type: 'function_call', call_id: 'call_A', name: 'toolA', arguments: '{"a":1}' },
      { type: 'function_call', call_id: 'call_B', name: 'toolB', arguments: '{"b":2}' },
      { type: 'function_call_output', call_id: 'call_A', output: 'result A' },
      { type: 'function_call_output', call_id: 'call_B', output: 'result B' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'final assistant text' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'final user text' }] },
    ])
  })
})
