import { describe, expect, it } from 'vitest'
import { buildAnthropicBody } from '../../lib/models/anthropic'
import { buildChatBody } from '../../lib/models/chat'
import { buildResponsesBody } from '../../lib/models/responses'
import type { KernelEvent } from '../../protocol/index'
import { buildMessages, followUpMessage, INTERRUPTED, noticeMessage, type ReplayOrigin } from './history'

const ORIGIN: ReplayOrigin = { accountId: 'acc', protocol: 'anthropic', modelId: 'claude-x' }

let seq = 0
const ev = (type: KernelEvent['type'], payload: object): KernelEvent => ({ seq: ++seq, ts: seq, type, sessionId: 's', payload })
const call = (id: string, name = 'read', args = '{"path":"a"}') => ({ type: 'tool_call', id, name, args })
const ended = (turnId: string, callId: string, content: string, isError?: boolean) =>
  ev('tool.ended', { turnId, callId, name: 'read', ok: !isError, ms: 1, content, ...(isError && { isError }) })

describe('buildMessages', () => {
  it('rebuilds steps with parts, tool results as tool messages, current prompt last', () => {
    const events = [
      ev('session.created', { approvalMode: 'ask' }),
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('turn.started', { turnId: 't1' }),
      ev('message.assistant', { turnId: 't1', step: 1, text: 'look', parts: [{ type: 'reasoning', replay: { r: 1 }, ...ORIGIN }, { type: 'text', text: 'look' }, call('c1'), call('c2', 'grep')] }),
      ev('tool.started', { turnId: 't1', callId: 'c1', name: 'read', argsPreview: '' }),
      ended('t1', 'c1', 'file body'),
      ended('t1', 'c2', 'bad', true),
      ev('message.assistant', { turnId: 't1', step: 2, text: 'done', parts: [{ type: 'text', text: 'done' }] }),
      ev('turn.ended', { turnId: 't1' }),
      ev('message.user', { turnId: 't2', text: 'q2' }),
    ]
    expect(buildMessages(events, 't2', 'q2', { origin: ORIGIN })).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', parts: [{ type: 'reasoning', replay: { r: 1 } }, { type: 'text', text: 'look' }, call('c1'), call('c2', 'grep')] },
      { role: 'tool', parts: [{ type: 'tool_result', callId: 'c1', content: 'file body' }, { type: 'tool_result', callId: 'c2', content: 'bad', isError: true }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
      { role: 'user', parts: [{ type: 'text', text: 'q2' }] },
    ])
  })

  it('plain-text message.assistant (loop-direct / loop-echo) is a text part', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'hi' }),
      ev('message.assistant', { turnId: 't1', text: 'echo: hi' }),
      ev('turn.ended', { turnId: 't1' }),
    ]
    expect(buildMessages(events, 't2', 'next')).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'echo: hi' }] },
      { role: 'user', parts: [{ type: 'text', text: 'next' }] },
    ])
  })

  it('an interrupted turn keeps its written steps and pads unpaired calls with 已中断', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('message.assistant', { turnId: 't1', step: 1, text: '', parts: [call('c1'), call('c2')] }),
      ended('t1', 'c1', 'ok'),
      ev('turn.failed', { turnId: 't1', reason: 'interrupted' }),
    ]
    const out = buildMessages(events, 't2', 'q2')
    expect(out[2]).toEqual({
      role: 'tool',
      parts: [{ type: 'tool_result', callId: 'c1', content: 'ok' }, { type: 'tool_result', callId: 'c2', content: INTERRUPTED, isError: true }],
    })
    expect(INTERRUPTED).toBe('已中断')
  })

  it('rolled-back turns and the current turn are skipped', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('message.assistant', { turnId: 't1', step: 1, text: 'a1', parts: [{ type: 'text', text: 'a1' }] }),
      ev('turn.ended', { turnId: 't1' }),
      ev('message.user', { turnId: 't2', text: 'q2' }),
      ev('message.assistant', { turnId: 't2', step: 1, text: 'a2', parts: [{ type: 'text', text: 'a2' }] }),
      ev('turn.ended', { turnId: 't2' }),
      ev('turn.rolledBack', { turnId: 't2', files: 1 }),
      ev('message.user', { turnId: 't3', text: 'q3' }),
      ev('message.assistant.delta', { turnId: 't3', text: 'x' }),
    ]
    expect(buildMessages(events, 't3', 'q3').map(m => m.parts.map(p => (p.type === 'text' ? p.text : p.type)).join())).toEqual(['q1', 'a1', 'q3'])
  })

  it('a failed turn without any step keeps the user message; empty steps and malformed parts are dropped', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('turn.failed', { turnId: 't1', reason: 'network' }),
      ev('message.user', { turnId: 't2', text: 'q2' }),
      ev('message.assistant', { turnId: 't2', step: 1, text: '', parts: [] }),
      ev('message.assistant', { turnId: 't2', step: 2, text: '', parts: [{ type: 'tool_call', id: 7 }, { type: 'image' }, null, { type: 'text', text: 'ok' }] }),
      ev('turn.ended', { turnId: 't2' }),
    ]
    expect(buildMessages(events, 't3', 'q3')).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'q1' }] },
      { role: 'user', parts: [{ type: 'text', text: 'q2' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
      { role: 'user', parts: [{ type: 'text', text: 'q3' }] },
    ])
  })

  it('reused call ids across steps pair in order', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('message.assistant', { turnId: 't1', step: 1, text: '', parts: [call('c')] }),
      ended('t1', 'c', 'first'),
      ev('message.assistant', { turnId: 't1', step: 2, text: '', parts: [call('c')] }),
      ended('t1', 'c', 'second'),
      ev('turn.ended', { turnId: 't1' }),
    ]
    const out = buildMessages(events, 't2', 'q2')
    expect(out[2].parts).toEqual([{ type: 'tool_result', callId: 'c', content: 'first' }])
    expect(out[4].parts).toEqual([{ type: 'tool_result', callId: 'c', content: 'second' }])
  })

  it('replay parts from another account / protocol / model, or without provenance, are dropped', () => {
    const step = (parts: object[]) => ev('message.assistant', { turnId: 't1', step: 1, text: 'a', parts: [...parts, { type: 'text', text: 'a' }] })
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      step([{ type: 'reasoning', replay: { keep: 1 }, ...ORIGIN }, { type: 'reasoning', replay: { other: 1 }, ...ORIGIN, protocol: 'openai-responses' }, { type: 'reasoning', replay: { bare: 1 } }]),
      ev('turn.ended', { turnId: 't1' }),
    ]
    const replays = (o?: ReplayOrigin) => buildMessages(events, 't2', 'q2', { origin: o })[1].parts.filter(p => p.type === 'reasoning')
    expect(replays(ORIGIN)).toEqual([{ type: 'reasoning', replay: { keep: 1 } }])
    expect(replays({ ...ORIGIN, modelId: 'claude-y' })).toEqual([])
    expect(replays({ ...ORIGIN, accountId: 'other' })).toEqual([])
    expect(replays(undefined)).toEqual([])
  })

  it('a reasoning-only step is not rebuilt (a lone reasoning item is rejected by Responses)', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('message.assistant', { turnId: 't1', step: 1, text: '', parts: [{ type: 'reasoning', replay: { r: 1 }, ...ORIGIN }] }),
      ev('turn.ended', { turnId: 't1' }),
    ]
    expect(buildMessages(events, 't2', 'q2', { origin: ORIGIN }).map(m => m.role)).toEqual(['user', 'user'])
  })

  it('environment goes before the first user message, the reminder before every user message, both from stable inputs', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('message.assistant', { turnId: 't1', text: 'a1' }),
      ev('turn.ended', { turnId: 't1' }),
      ev('message.user', { turnId: 't2', text: 'q2' }),
    ]
    const opts = { environment: '<environment>E</environment>', reminder: (ts: number) => `<r>${ts}</r>`, now: 999 }
    const t1 = events[0].ts
    const t2 = events[3].ts
    const out = buildMessages(events, 't2', 'q2', opts)
    expect(out[0].parts).toEqual([{ type: 'text', text: '<environment>E</environment>' }, { type: 'text', text: `<r>${t1}</r>` }, { type: 'text', text: 'q1' }])
    expect(out[2].parts).toEqual([{ type: 'text', text: `<r>${t2}</r>` }, { type: 'text', text: 'q2' }])
    // 第一轮本身:当前消息就是第一条,带环境块;不在 events 里时用 now
    expect(buildMessages([], 't1', 'q1', opts)[0].parts).toEqual([{ type: 'text', text: '<environment>E</environment>' }, { type: 'text', text: '<r>999</r>' }, { type: 'text', text: 'q1' }])
  })
})

describe('buildMessages: notices and follow-ups', () => {
  const opts = { environment: '<environment>E</environment>', reminder: (ts: number) => `<r>${ts}</r>` }
  const notice = (turnId: string, text: string, step?: number) => ev('executor.notice', { turnId, ...(step !== undefined && { step }), runId: 'run_a', text })
  const texts = (m: { parts: { type: string; text?: string }[] }) => m.parts.map(p => p.text ?? p.type)

  it('a notice is a bare user message: no reminder, no environment', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('message.assistant', { turnId: 't1', step: 1, text: 'a', parts: [{ type: 'text', text: 'a' }] }),
      notice('t1', '<executor-notice>n</executor-notice>', 2),
      ev('turn.ended', { turnId: 't1' }),
    ]
    const out = buildMessages(events, 't2', 'q2', opts)
    expect(out[2]).toEqual({ role: 'user', parts: [{ type: 'text', text: '<executor-notice>n</executor-notice>' }] })
    expect(out[2]).toEqual(noticeMessage('<executor-notice>n</executor-notice>'))
  })

  it('a follow-up renders with its own reminder and no environment; a plain second message.user is still ignored', () => {
    const first = ev('message.user', { turnId: 't1', text: 'q1' })
    const stray = ev('message.user', { turnId: 't1', text: 'not a follow-up' })
    const follow = ev('message.user', { turnId: 't1', text: 'q1b', followUp: true })
    const out = buildMessages([first, stray, follow, ev('turn.ended', { turnId: 't1' })], 't2', 'q2', opts)
    expect(out.map(texts)).toEqual([
      ['<environment>E</environment>', `<r>${first.ts}</r>`, 'q1'],
      [`<r>${follow.ts}</r>`, 'q1b'],
      [expect.stringMatching(/^<r>/), 'q2'],
    ])
    expect(out[1]).toEqual(followUpMessage('q1b', follow.ts, opts))
  })

  it('a follow-up of the current turn is not rebuilt, and the current message keeps the first ts', () => {
    const first = ev('message.user', { turnId: 't1', text: 'q1' })
    const out = buildMessages([first, ev('message.user', { turnId: 't1', text: 'later', followUp: true })], 't1', 'q1', opts)
    expect(out.map(texts)).toEqual([['<environment>E</environment>', `<r>${first.ts}</r>`, 'q1']])
  })

  it('a tool.ended after a notice or a follow-up pairs with the last assistant step, and the tool message stays right after its call', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('message.assistant', { turnId: 't1', step: 1, text: '', parts: [call('c1'), call('c2')] }),
      ended('t1', 'c1', 'one'),
      notice('t1', 'N'),
      ev('message.user', { turnId: 't1', text: 'F', followUp: true }),
      ended('t1', 'c2', 'two'),
      ev('turn.ended', { turnId: 't1' }),
    ]
    const out = buildMessages(events, 't2', 'q2')
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'user', 'user'])
    expect(out[2].parts).toEqual([{ type: 'tool_result', callId: 'c1', content: 'one' }, { type: 'tool_result', callId: 'c2', content: 'two' }])
    expect(out[3]).toEqual(noticeMessage('N'))
    expect(texts(out[4])).toEqual(['F'])
  })

  it('a recovery notice after an unpaired call: the call is padded and the notice follows', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('message.assistant', { turnId: 't1', step: 1, text: '', parts: [call('c1')] }),
      notice('t1', 'interrupted run'),
      ev('turn.failed', { turnId: 't1', reason: 'interrupted' }),
    ]
    const out = buildMessages(events, 't2', 'q2')
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'user'])
    expect(out[2].parts).toEqual([{ type: 'tool_result', callId: 'c1', content: INTERRUPTED, isError: true }])
    expect(out[3]).toEqual(noticeMessage('interrupted run'))
  })

  it('a notice written after the terminal event is still in the next turn', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('turn.failed', { turnId: 't1', reason: 'cancelled' }),
      notice('t1', 'late'),
    ]
    expect(buildMessages(events, 't2', 'q2').map(texts)).toEqual([['q1'], ['late'], ['q2']])
  })

  it('a rolled-back turn drops its notices and both user messages; a notice with no known turn or no text is ignored', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('message.user', { turnId: 't1', text: 'q1b', followUp: true }),
      notice('t1', 'N'),
      ev('turn.ended', { turnId: 't1' }),
      ev('turn.rolledBack', { turnId: 't1', files: 1 }),
      notice('ghost', 'G'),
      ev('message.user', { turnId: 't3', text: 'q3' }),
      ev('executor.notice', { turnId: 't3', runId: 'r' }),
      ev('turn.ended', { turnId: 't3' }),
    ]
    expect(buildMessages(events, 't4', 'q4').map(texts)).toEqual([['q3'], ['q4']])
  })
})

describe('request bodies: tool result, then a notice, then the next user message', () => {
  const events = [
    ev('message.user', { turnId: 't1', text: 'q1' }),
    ev('message.assistant', { turnId: 't1', step: 1, text: '', parts: [call('c1')] }),
    ended('t1', 'c1', 'body'),
    ev('executor.notice', { turnId: 't1', step: 2, runId: 'run_a', text: 'NOTICE' }),
    ev('message.assistant', { turnId: 't1', step: 2, text: 'ok', parts: [{ type: 'text', text: 'ok' }] }),
    ev('turn.ended', { turnId: 't1' }),
  ]
  // 工具结果紧接通知,再接下一条用户消息:去掉第 2 步的回答才是这个形状
  const messages = buildMessages(events.filter(e => (e.payload as { step?: number }).step !== 2 || e.type === 'executor.notice'), 't2', 'NEXT')
  const req = { model: { accountId: 'a', modelId: 'm' }, system: 's', messages }

  it('the shape under test', () => {
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'user'])
  })

  it('Anthropic merges them into one user message with tool_result first', () => {
    const body = buildAnthropicBody(req as never, {}) as { messages: { role: string; content: { type: string; text?: string; tool_use_id?: string; content?: unknown }[] }[] }
    expect(body.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(body.messages[2].content.map(b => b.type)).toEqual(['tool_result', 'text', 'text'])
    expect(body.messages[2].content[0].tool_use_id).toBe('c1')
    expect(body.messages[2].content.slice(1).map(b => b.text)).toEqual(['NOTICE', 'NEXT'])
  })

  it('Chat gives a tool message, then the user messages', () => {
    const body = buildChatBody(req as never, {}) as { messages: { role: string; tool_call_id?: string; content?: unknown }[] }
    const rest = body.messages.filter(m => m.role !== 'system' && m.role !== 'developer')
    expect(rest.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'user'])
    expect(rest[2].tool_call_id).toBe('c1')
    expect(JSON.stringify(rest[3].content)).toContain('NOTICE')
    expect(JSON.stringify(rest[4].content)).toContain('NEXT')
  })

  it('Responses gives function_call_output, then messages', () => {
    const body = buildResponsesBody(req as never, { store: false, includeEncryptedReasoning: true }) as { input: { type?: string; role?: string; call_id?: string; content?: unknown }[] }
    const kinds = body.input.map(i => i.type ?? i.role)
    const at = kinds.indexOf('function_call_output')
    expect(body.input[at].call_id).toBe('c1')
    expect(body.input.slice(at + 1).map(i => i.role)).toEqual(['user', 'user'])
    expect(JSON.stringify(body.input[at + 1].content)).toContain('NOTICE')
    expect(JSON.stringify(body.input[at + 2].content)).toContain('NEXT')
  })
})

describe('buildMessages: memory blocks (06 spec §7)', () => {
  const injected = (turnId: string, kind: 'session' | 'turn', text: string) => ev('memory.injected', { turnId, kind, text, items: [] })
  const OPTS = { environment: 'ENV', reminder: (ts: number) => `R${ts}` }
  const texts = (m: { parts: unknown[] }) => (m.parts as { text: string }[]).map(p => p.text)

  it('first message: environment, session block, reminder, turn block, text; later ones: reminder, turn block, text', () => {
    const u1 = ev('message.user', { turnId: 't1', text: 'q1' })
    const events = [
      u1,
      injected('t1', 'session', 'SESSION'),
      injected('t1', 'turn', 'RECALL1'),
      ev('message.assistant', { turnId: 't1', step: 1, text: 'a1', parts: [{ type: 'text', text: 'a1' }] }),
      ev('turn.ended', { turnId: 't1' }),
    ]
    const u2 = ev('message.user', { turnId: 't2', text: 'q2' })
    events.push(u2, injected('t2', 'turn', 'RECALL2'))
    const out = buildMessages(events, 't2', 'q2', OPTS)
    expect(texts(out[0])).toEqual(['ENV', 'SESSION', `R${u1.ts}`, 'RECALL1', 'q1'])
    expect(texts(out[2])).toEqual([`R${u2.ts}`, 'RECALL2', 'q2'])
  })

  it('the current turn takes its own blocks from the log, not from an argument', () => {
    const u = ev('message.user', { turnId: 't1', text: 'q' })
    const out = buildMessages([u, injected('t1', 'session', 'S'), injected('t1', 'turn', 'T')], 't1', 'q', OPTS)
    expect(texts(out[0])).toEqual(['ENV', 'S', `R${u.ts}`, 'T', 'q'])
  })

  it('the first turn rolled back: its session block moves with "first", its turn block leaves with the turn', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      injected('t1', 'session', 'S'),
      injected('t1', 'turn', 'GONE'),
      ev('turn.ended', { turnId: 't1' }),
      ev('turn.rolledBack', { turnId: 't1' }),
    ]
    const u2 = ev('message.user', { turnId: 't2', text: 'q2' })
    events.push(u2)
    const out = buildMessages(events, 't2', 'q2', OPTS)
    expect(out).toHaveLength(1)
    expect(texts(out[0])).toEqual(['ENV', 'S', `R${u2.ts}`, 'q2'])
  })

  it('a follow-up and a notice carry no block, live or rebuilt', () => {
    const u = ev('message.user', { turnId: 't1', text: 'q1' })
    const follow = ev('message.user', { turnId: 't1', text: 'more', followUp: true })
    const events = [
      u,
      injected('t1', 'turn', 'T'),
      ev('message.assistant', { turnId: 't1', step: 1, text: 'a', parts: [{ type: 'text', text: 'a' }] }),
      follow,
      ev('executor.notice', { turnId: 't1', runId: 'r', text: 'note' }),
    ]
    const out = buildMessages(events, 't2', 'next', OPTS)
    expect(texts(out[0])).toEqual(['ENV', `R${u.ts}`, 'T', 'q1'])
    expect(out[2]).toEqual(followUpMessage('more', follow.ts, OPTS))
    expect(texts(out[2])).toEqual([`R${follow.ts}`, 'more'])
    expect(out[3]).toEqual(noticeMessage('note'))
  })

  it('without memory events the message is what it always was', () => {
    const u = ev('message.user', { turnId: 't1', text: 'q' })
    expect(texts(buildMessages([u], 't1', 'q', OPTS)[0])).toEqual(['ENV', `R${u.ts}`, 'q'])
    expect(texts(buildMessages([u], 't1', 'q')[0])).toEqual(['q'])
  })
})
