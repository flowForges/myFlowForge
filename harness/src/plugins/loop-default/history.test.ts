import { describe, expect, it } from 'vitest'
import type { KernelEvent } from '../../protocol/index'
import { buildMessages, INTERRUPTED, type ReplayOrigin } from './history'

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
