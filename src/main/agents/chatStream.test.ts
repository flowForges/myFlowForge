import { describe, it, expect } from 'vitest'
import { parseChatStreamObj, parseChatStreamActions, buildChatPrompt, extractContextTokens, contextWindowFor, splitThinkLines } from './chatStream'

describe('parseChatStreamObj', () => {
  it('extracts session id from a system/init event', () => {
    expect(parseChatStreamObj({ type: 'system', session_id: 's1' })).toEqual({ kind: 'session', id: 's1' })
  })
  it('maps assistant text to an assistant delta', () => {
    expect(parseChatStreamObj({ type: 'assistant', text: 'hello' })).toEqual({ kind: 'assistant', text: 'hello' })
  })
  it('maps thinking text to a think delta', () => {
    expect(parseChatStreamObj({ type: 'thinking', text: 'pondering' })).toEqual({ kind: 'think', text: 'pondering' })
  })
  it('maps a result event to result', () => {
    expect(parseChatStreamObj({ type: 'result', text: 'done' })).toEqual({ kind: 'result', text: 'done' })
  })
  it('ignores unknown events', () => {
    expect(parseChatStreamObj({ type: 'whatever' })).toEqual({ kind: 'ignore' })
  })
})

describe('parseChatStreamActions (real Claude CLI nested format)', () => {
  it('extracts text + thinking from message.content[] of a real assistant event', () => {
    const obj = {
      type: 'assistant',
      session_id: 's9',
      message: { role: 'assistant', content: [
        { type: 'thinking', thinking: '先看依赖' },
        { type: 'text', text: '我来修复布局' },
      ] },
    }
    expect(parseChatStreamActions(obj)).toEqual([
      { kind: 'session', id: 's9' },
      { kind: 'think', text: '先看依赖' },
      { kind: 'assistant', text: '我来修复布局' },
    ])
  })
  it('routes narration + tool calls of a "working" message to the thinking trace', () => {
    const obj = { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: '让我读一下入口文件' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'pkg/main.go' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'go build ./...' } },
    ] } }
    expect(parseChatStreamActions(obj)).toEqual([
      { kind: 'think', text: '让我读一下入口文件' },
      { kind: 'tool', text: '调用 Read pkg/main.go', name: 'Read' },
      { kind: 'tool', text: '调用 Bash: go build ./...', name: 'Bash' },
    ])
  })
  it('keeps a tool-less message as the final answer (reply body)', () => {
    const obj = { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: '## 总结\n两个项目都是 Go 写的。' },
    ] } }
    expect(parseChatStreamActions(obj)).toEqual([
      { kind: 'assistant', text: '## 总结\n两个项目都是 Go 写的。' },
    ])
  })
  it('reads the real result event `result` field', () => {
    expect(parseChatStreamActions({ type: 'result', subtype: 'success', result: '完成', session_id: 's9' }))
      .toEqual([{ kind: 'session', id: 's9' }, { kind: 'result', text: '完成' }])
  })
  it('still handles the flat test-fixture shape', () => {
    expect(parseChatStreamActions({ type: 'assistant', text: 'hello' })).toEqual([{ kind: 'assistant', text: 'hello' }])
  })
  it('returns no actions for unrelated events (e.g. tool-result user turns)', () => {
    expect(parseChatStreamActions({ type: 'user', message: { content: [] } })).toEqual([])
  })
})

describe('parseChatStreamActions (partial stream_event deltas)', () => {
  it('maps a text_delta to an assistant delta', () => {
    expect(parseChatStreamActions({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } }))
      .toEqual([{ kind: 'assistant', text: 'Hel' }])
  })
  it('maps a thinking_delta to a think delta', () => {
    expect(parseChatStreamActions({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '先分析' } } }))
      .toEqual([{ kind: 'think', text: '先分析' }])
  })
  it('maps a tool_use content_block_start to a tool step', () => {
    expect(parseChatStreamActions({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } } } }))
      .toEqual([{ kind: 'tool', text: '调用 Read a.ts', name: 'Read' }])
  })
  it('ignores empty deltas and unrelated stream events', () => {
    expect(parseChatStreamActions({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } } })).toEqual([])
    expect(parseChatStreamActions({ type: 'stream_event', event: { type: 'message_stop' } })).toEqual([])
  })
})

describe('parseChatStreamActions (built-in Task sub-agents)', () => {
  it('maps a Task tool_use in a full assistant message to subagent-start with its input', () => {
    const obj = { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Task', input: { subagent_type: 'Explore', description: '探查鉴权', prompt: '摸清鉴权模块' } },
    ] } }
    expect(parseChatStreamActions(obj)).toEqual([
      { kind: 'subagent-start', id: 'toolu_1', subagentType: 'Explore', description: '探查鉴权', prompt: '摸清鉴权模块' },
    ])
  })
  it('maps a Task content_block_start to subagent-start (empty input is fine)', () => {
    expect(parseChatStreamActions({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_2', name: 'Task', input: {} } } }))
      .toEqual([{ kind: 'subagent-start', id: 'toolu_2', subagentType: undefined, description: undefined, prompt: undefined }])
  })
  it('does NOT turn a Task into a plain tool step (no 调用 Task line)', () => {
    const acts = parseChatStreamActions({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Task', input: {} }] } })
    expect(acts.some(a => a.kind === 'tool')).toBe(false)
  })
  it('maps a user tool_result to subagent-result, flattening array content', () => {
    const obj = { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '鉴权走 src/auth/*' }], is_error: false },
    ] } }
    expect(parseChatStreamActions(obj)).toEqual([
      { kind: 'subagent-result', id: 'toolu_1', result: '鉴权走 src/auth/*', isError: false },
    ])
  })
  it('carries is_error through on a failed tool_result', () => {
    const obj = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'boom', is_error: true }] } }
    expect(parseChatStreamActions(obj)).toEqual([{ kind: 'subagent-result', id: 'x', result: 'boom', isError: true }])
  })
})

describe('extractContextTokens', () => {
  it('sums the prompt tiers of a per-turn assistant message.usage (input + both cache tiers)', () => {
    const obj = { type: 'assistant', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 } } }
    expect(extractContextTokens(obj)).toBe(1700)
  })
  it('excludes output_tokens — generated text is not context occupancy', () => {
    const obj = { type: 'assistant', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 9999 } } }
    expect(extractContextTokens(obj)).toBe(1500)
  })
  it('ignores the cumulative result event (its usage sums every internal tool-loop call)', () => {
    // The CLI `result` event reports usage cumulatively across every internal model call in one
    // run, so its cache_read tier alone can dwarf the window — counting it maxed the bar on tiny
    // tasks. Only per-turn assistant usage reflects live context occupancy.
    const obj = { type: 'result', usage: { input_tokens: 800, cache_creation_input_tokens: 100, cache_read_input_tokens: 500000, output_tokens: 50 } }
    expect(extractContextTokens(obj)).toBeNull()
  })
  it('returns null when there is no usage object', () => {
    expect(extractContextTokens({ type: 'assistant', message: { content: [] } })).toBeNull()
    expect(extractContextTokens({ type: 'whatever' })).toBeNull()
    expect(extractContextTokens(null)).toBeNull()
  })
  it('ignores non-positive token fields and returns null when total is 0', () => {
    expect(extractContextTokens({ usage: { input_tokens: 0, output_tokens: 0 } })).toBeNull()
  })
})

describe('contextWindowFor', () => {
  it('defaults to 200K for a normal model', () => {
    expect(contextWindowFor('opus-4.8')).toBe(200_000)
    expect(contextWindowFor('')).toBe(200_000)
  })
  it('returns 1M for a *-1m model', () => {
    expect(contextWindowFor('claude-opus-4-8[1m]')).toBe(1_000_000)
    expect(contextWindowFor('sonnet-1M')).toBe(1_000_000)
  })
})

describe('buildChatPrompt', () => {
  it('returns the bare prompt when there are no attachments', () => {
    expect(buildChatPrompt({ id: 'a', prompt: 'do x', model: 'm', cwd: '/w' })).toBe('do x')
  })
  it('appends attachment paths so the CLI can read them', () => {
    const out = buildChatPrompt({ id: 'a', prompt: 'do x', model: 'm', cwd: '/w',
      attachments: [{ name: 'spec.pdf', path: '/w/spec.pdf', size: 1 }, { name: 't.css', path: '/w/t.css', size: 2 }] })
    expect(out).toBe('do x\n\n附件:\n- /w/spec.pdf\n- /w/t.css')
  })
})

describe('splitThinkLines (coalesce word-level reasoning)', () => {
  it('accumulates word fragments until a newline, carrying the partial forward', () => {
    let buf = ''
    const emitted: string[] = []
    for (const frag of ['I ', 'think ', 'the ', 'code', ' is fine.\n', 'Next ', 'step.']) {
      const { lines, rest } = splitThinkLines(buf + frag)
      emitted.push(...lines)
      buf = rest
    }
    expect(emitted).toEqual(['I think the code is fine.'])   // one line flushed at the newline
    expect(buf).toBe('Next step.')                            // trailing partial still buffered
  })

  it('splits multi-line buffers and drops blank lines', () => {
    expect(splitThinkLines('a\n\nb\nc')).toEqual({ lines: ['a', 'b'], rest: 'c' })
  })

  it('holds a fragment with no newline entirely in rest', () => {
    expect(splitThinkLines('partial')).toEqual({ lines: [], rest: 'partial' })
  })
})
