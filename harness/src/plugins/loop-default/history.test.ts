import { describe, expect, it } from 'vitest'
import { buildAnthropicBody } from '../../lib/models/anthropic'
import { buildChatBody } from '../../lib/models/chat'
import { buildResponsesBody } from '../../lib/models/responses'
import type { KernelEvent } from '../../protocol/index'
import { checkpointBlock } from '../../lib/memory/wrap'
import { estimateTokens } from './compact'
import { buildMessages, followUpMessage, INTERRUPTED, noticeMessage, rebuildHistory, type ReplayOrigin } from './history'

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

describe('buildMessages: rebuild from a checkpoint (06 spec §12)', () => {
  const OPTS = { environment: 'ENV', reminder: (ts: number) => `R${ts}` }
  const texts = (m: { parts: unknown[] }) => (m.parts as { text: string }[]).map(p => p.text)
  const say = (turnId: string, text: string, step = 1) => ev('message.assistant', { turnId, step, text, parts: [{ type: 'text', text }] })
  const injected = (turnId: string, kind: 'session' | 'turn', text: string) => ev('memory.injected', { turnId, kind, text, items: [] })
  const cpEvent = (throughSeq: number, text = 'SUMMARY', extra: object = {}) => ev('memory.checkpoint', { throughSeq, asOfSeq: throughSeq, text, model: 'm', tokens: 1, covers: 1, ...extra })
  const markerOf = (cp: KernelEvent, throughSeq: number) => ev('context.rebuilt', { turnId: 'tm', step: 1, checkpointSeq: cp.seq, throughSeq, before: 100, after: 50 })
  const block = (throughSeq: number, text = 'SUMMARY') => checkpointBlock(throughSeq, text)

  /** t1 问答、t2 问答(带轮块和工具)、t3 问答 */
  function log() {
    const u1 = ev('message.user', { turnId: 't1', text: 'q1' })
    const s = injected('t1', 'session', 'SESSION')
    const b1 = injected('t1', 'turn', 'BLOCK1')
    const a1 = say('t1', 'a1')
    const e1 = ev('turn.ended', { turnId: 't1' })
    const u2 = ev('message.user', { turnId: 't2', text: 'q2' })
    const b2 = injected('t2', 'turn', 'BLOCK2')
    const a2 = ev('message.assistant', { turnId: 't2', step: 1, text: '', parts: [call('c1')] })
    const r2 = ended('t2', 'c1', 'body')
    const a2b = say('t2', 'a2', 2)
    const e2 = ev('turn.ended', { turnId: 't2' })
    const u3 = ev('message.user', { turnId: 't3', text: 'q3' })
    const b3 = injected('t3', 'turn', 'BLOCK3')
    const a3 = say('t3', 'a3')
    const e3 = ev('turn.ended', { turnId: 't3' })
    return { u1, s, b1, a1, e1, u2, b2, a2, r2, a2b, e2, u3, b3, a3, e3, all: [u1, s, b1, a1, e1, u2, b2, a2, r2, a2b, e2, u3, b3, a3, e3] }
  }

  it('a boundary between turns: first message, checkpoint, then the rest whole; covered turns are gone', () => {
    const l = log()
    const cp = cpEvent(l.e2.seq)
    const out = buildMessages([...l.all, cp, markerOf(cp, l.e2.seq)], 'tn', 'next', OPTS)
    expect(out.map(texts)).toEqual([
      ['ENV', 'SESSION', `R${l.u1.ts}`, 'q1'],
      [block(l.e2.seq)],
      [`R${l.u3.ts}`, 'BLOCK3', 'q3'],
      ['a3'],
      [expect.stringMatching(/^R/), 'next'],
    ])
  })

  it('straddling turn: opening with its reminder and no block, then only the steps above throughSeq, every call paired', () => {
    const l = log()
    const cp = cpEvent(l.r2.seq)
    const out = buildMessages([...l.all, cp, markerOf(cp, l.r2.seq)], 'tn', 'next', OPTS)
    expect(out.map(texts)).toEqual([
      ['ENV', 'SESSION', `R${l.u1.ts}`, 'q1'],
      [block(l.r2.seq)],
      [`R${l.u2.ts}`, 'q2'],
      ['a2'],
      [`R${l.u3.ts}`, 'BLOCK3', 'q3'],
      ['a3'],
      [expect.stringMatching(/^R/), 'next'],
    ])
  })

  it('the first turn straddling: no second opening', () => {
    const u = ev('message.user', { turnId: 't1', text: 'q1' })
    const a = say('t1', 'a1')
    const a2 = say('t1', 'a2', 2)
    const cp = cpEvent(a.seq)
    const out = buildMessages([u, a, a2, cp, markerOf(cp, a.seq)], 'tn', 'next', OPTS)
    expect(out.map(texts)).toEqual([['ENV', `R${u.ts}`, 'q1'], [block(a.seq)], ['a2'], [expect.stringMatching(/^R/), 'next']])
  })

  it('opts.rebuild overrides with no marker in the log; the output equals a log that has the marker', () => {
    const l = log()
    const cp = cpEvent(l.a1.seq, 'OVERRIDE')
    const viaOpt = buildMessages([...l.all, cp], 'tn', 'next', { ...OPTS, now: 1, rebuild: { throughSeq: l.a1.seq, text: 'OVERRIDE' } })
    const viaLog = buildMessages([...l.all, cp, markerOf(cp, l.a1.seq)], 'tn', 'next', { ...OPTS, now: 1 })
    expect(viaOpt).toEqual(viaLog)
    expect(texts(viaOpt[1])).toEqual([block(l.a1.seq, 'OVERRIDE')])
  })

  it('a checkpoint with no marker changes nothing', () => {
    const l = log()
    const cp = cpEvent(l.e2.seq)
    expect(buildMessages([...l.all, cp], 'tn', 'next', { ...OPTS, now: 1 })).toEqual(buildMessages(l.all, 'tn', 'next', { ...OPTS, now: 1 }))
  })

  it('first and straddling openings clip the text to 4000, whatever comes first in them', () => {
    const u1 = ev('message.user', { turnId: 't1', text: 'A'.repeat(9000) })
    const e1 = ev('turn.ended', { turnId: 't1' })
    const u2 = ev('message.user', { turnId: 't2', text: 'B'.repeat(9000) })
    const a2 = say('t2', 'a2')
    const a2b = say('t2', 'a2b', 2)
    const cp = cpEvent(a2.seq)
    const out = buildMessages([u1, e1, u2, a2, a2b, cp, markerOf(cp, a2.seq)], 'tn', 'next', OPTS)
    const first = texts(out[0])
    expect(first.slice(0, 2)).toEqual(['ENV', `R${u1.ts}`])
    expect(first[2].length).toBeLessThanOrEqual(4000)
    expect(first[2].length).toBeGreaterThan(3900)
    const opening = texts(out[2])
    expect(opening[0]).toBe(`R${u2.ts}`)
    expect(opening[1].startsWith('BBB')).toBe(true)
    expect(opening[1].length).toBeLessThanOrEqual(4000)
  })

  it('the turn blocks of covered turns are reclaimed, which compact never does: ~2k chars a turn', () => {
    const blockText = 'R'.repeat(2000)
    const events: KernelEvent[] = []
    for (let i = 0; i < 30; i++) {
      events.push(ev('message.user', { turnId: `t${i}`, text: `q${i}` }), injected(`t${i}`, 'turn', `${i}:${blockText}`), say(`t${i}`, `a${i}`), ev('turn.ended', { turnId: `t${i}` }))
    }
    const through = events[events.length - 1].seq
    const last = ev('message.user', { turnId: 'tail', text: 'tail' })
    events.push(last, injected('tail', 'turn', `tail:${blockText}`), say('tail', 'at'), ev('turn.ended', { turnId: 'tail' }))
    const before = buildMessages(events, 'tn', 'next', OPTS)
    const cp = cpEvent(through)
    const after = buildMessages([...events, cp, markerOf(cp, through)], 'tn', 'next', OPTS)
    expect(estimateTokens(before) - estimateTokens(after)).toBeGreaterThan((60_000 - 3000) / 3.5)
    const body = JSON.stringify(after)
    expect(body.match(/RRRR/g)?.length).toBeGreaterThan(0)
    expect(body).not.toContain(`0:${blockText}`)
    expect(body).not.toContain(`29:${blockText}`)
    expect(body).toContain(`tail:${blockText}`)
  })
})

describe('buildMessages: includeCurrent (06 spec §12)', () => {
  const OPTS = { environment: 'ENV', reminder: (ts: number) => `R${ts}` }
  const texts = (m: { parts: unknown[] }) => (m.parts as { text?: string; type: string }[]).map(p => p.text ?? p.type)
  const say = (turnId: string, text: string, step = 1) => ev('message.assistant', { turnId, step, text, parts: [{ type: 'text', text }] })

  it('the current turn is treated like any other, currentText is not appended', () => {
    const u = ev('message.user', { turnId: 't1', text: 'q1' })
    const b = ev('memory.injected', { turnId: 't1', kind: 'turn', text: 'BLOCK', items: [] })
    const a = ev('message.assistant', { turnId: 't1', step: 1, text: '', parts: [call('c1')] })
    const r = ended('t1', 'c1', 'body')
    const out = buildMessages([u, b, a, r], 't1', 'IGNORED', { ...OPTS, includeCurrent: true })
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(texts(out[0])).toEqual(['ENV', `R${u.ts}`, 'BLOCK', 'q1'])
    expect(JSON.stringify(out)).not.toContain('IGNORED')
  })

  it('includeCurrent over a finished log equals the next turn minus its own message', () => {
    const u = ev('message.user', { turnId: 't1', text: 'q1' })
    const a = say('t1', 'a1')
    const n = ev('executor.notice', { turnId: 't1', runId: 'r', text: 'N' })
    const f = ev('message.user', { turnId: 't1', text: 'F', followUp: true })
    const events = [u, a, n, f]
    const next = buildMessages(events, 'later', 'x', { ...OPTS, now: 1 })
    expect(buildMessages(events, 't1', 'q1', { ...OPTS, includeCurrent: true })).toEqual(next.slice(0, -1))
  })

  it('no message.user for the current turn in the log: the text is still sent', () => {
    const out = buildMessages([], 't1', 'q1', { ...OPTS, now: 7, includeCurrent: true })
    expect(out.map(texts)).toEqual([['ENV', 'R7', 'q1']])
  })

  it('without includeCurrent the current turn never comes from the log (03 rule)', () => {
    const u = ev('message.user', { turnId: 't1', text: 'q1' })
    const a = say('t1', 'a1')
    expect(buildMessages([u, a], 't1', 'q1', OPTS).map(texts)).toEqual([['ENV', `R${u.ts}`, 'q1']])
  })

  it('the current turn covered mid-way keeps its opening even with nothing above throughSeq', () => {
    const u1 = ev('message.user', { turnId: 't1', text: 'q1' })
    const u2 = ev('message.user', { turnId: 't2', text: 'q2' })
    const a2 = say('t2', 'a2')
    const out = buildMessages([u1, u2, a2], 't2', 'q2', { ...OPTS, includeCurrent: true, rebuild: { throughSeq: a2.seq, text: 'S' } })
    expect(out.map(texts)).toEqual([['ENV', `R${u1.ts}`, 'q1'], [checkpointBlock(a2.seq, 'S')], [`R${u2.ts}`, 'q2']])
  })

  it('rebuildHistory reports where the current opening is', () => {
    const u1 = ev('message.user', { turnId: 't1', text: 'q1' })
    const u2 = ev('message.user', { turnId: 't2', text: 'q2' })
    const a2 = say('t2', 'a2')
    const a3 = say('t2', 'a3', 2)
    const rebuilt = rebuildHistory([u1, u2, a2, a3], 't2', 'q2', { ...OPTS, includeCurrent: true, rebuild: { throughSeq: a2.seq, text: 'S' } })
    expect(rebuilt.opening).toBe(2)
    expect(texts(rebuilt.messages[2])).toEqual([`R${u2.ts}`, 'q2'])
    expect(rebuildHistory([u1, u2], 't2', 'q2', OPTS).opening).toBe(1)
    expect(rebuildHistory([u1], 't1', 'q1', OPTS).opening).toBe(0)
  })
})

describe('the plugin index block', () => {
  const REMIND = { environment: '<environment/>', reminder: () => '<reminder/>' }
  const injected = (text: string) => ev('plugins.injected', { turnId: 't1', text, skill: true, mcp: false })
  const texts = (m: { parts: { type: string; text?: string }[] }) => m.parts.map(p => p.text)

  it('goes after the environment and memory session block, before the reminder, on the first message only', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('memory.injected', { turnId: 't1', kind: 'session', text: '<memory/>' }),
      ev('memory.injected', { turnId: 't1', kind: 'turn', text: '<recall/>' }),
      injected('<plugin-index/>'),
      ev('message.assistant', { turnId: 't1', step: 1, text: 'a', parts: [{ type: 'text', text: 'a' }] }),
      ev('message.user', { turnId: 't2', text: 'q2' }),
    ]
    const [first, , second] = buildMessages(events, 't2', 'q2', REMIND)
    expect(texts(first)).toEqual(['<environment/>', '<memory/>', '<plugin-index/>', '<reminder/>', '<recall/>', 'q1'])
    expect(texts(second)).toEqual(['<reminder/>', 'q2'])
  })

  it('absent: parts unchanged', () => {
    const events = [ev('message.user', { turnId: 't1', text: 'q1' })]
    expect(texts(buildMessages(events, 't1', 'q1', { ...REMIND, includeCurrent: true })[0])).toEqual(['<environment/>', '<reminder/>', 'q1'])
  })

  it('the first in the log counts, its turn rolled back or not; a later or malformed one does not', () => {
    const events = [
      ev('message.user', { turnId: 't1', text: 'q1' }),
      ev('plugins.injected', { turnId: 't1', text: 42, skill: true, mcp: false }),
      injected('<first/>'),
      injected('<second/>'),
      ev('turn.rolledBack', { turnId: 't1' }),
      ev('message.user', { turnId: 't2', text: 'q2' }),
    ]
    expect(texts(buildMessages(events, 't2', 'q2', REMIND)[0])).toEqual(['<environment/>', '<first/>', '<reminder/>', 'q2'])
  })

  it('the checkpoint branch keeps it', () => {
    const q1 = ev('message.user', { turnId: 't1', text: 'q1' })
    const block = injected('<plugin-index/>')
    const a1 = ev('message.assistant', { turnId: 't1', step: 1, text: 'a', parts: [{ type: 'text', text: 'a' }] })
    const q2 = ev('message.user', { turnId: 't2', text: 'q2' })
    const events = [q1, block, a1, q2]
    const { messages } = rebuildHistory(events, 't2', 'q2', { ...REMIND, rebuild: { throughSeq: a1.seq, text: 'CP' } })
    expect(texts(messages[0])).toEqual(['<environment/>', '<plugin-index/>', '<reminder/>', 'q1'])
    expect(JSON.stringify(messages[1])).toContain('CP')
    expect(JSON.stringify(messages.slice(2))).not.toContain('plugin-index')
  })
})
