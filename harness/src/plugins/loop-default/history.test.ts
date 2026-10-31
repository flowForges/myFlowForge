import { describe, expect, it } from 'vitest'
import type { KernelEvent } from '../../protocol/index'
import { buildMessages, INTERRUPTED } from './history'

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
      ev('message.assistant', { turnId: 't1', step: 1, text: 'look', parts: [{ type: 'reasoning', replay: { r: 1 } }, { type: 'text', text: 'look' }, call('c1'), call('c2', 'grep')] }),
      ev('tool.started', { turnId: 't1', callId: 'c1', name: 'read', argsPreview: '' }),
      ended('t1', 'c1', 'file body'),
      ended('t1', 'c2', 'bad', true),
      ev('message.assistant', { turnId: 't1', step: 2, text: 'done', parts: [{ type: 'text', text: 'done' }] }),
      ev('turn.ended', { turnId: 't1' }),
      ev('message.user', { turnId: 't2', text: 'q2' }),
    ]
    expect(buildMessages(events, 't2', 'q2')).toEqual([
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
})
