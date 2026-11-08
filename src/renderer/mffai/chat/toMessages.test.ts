import { describe, it, expect, beforeEach } from 'vitest'
import type { KernelEvent } from '@mffai/protocol'
import { emptyView, reduce } from './reduce'
import { toMessages, TRUNCATED_MARK } from './toMessages'
import { ev, resetSeq } from '../test/events'

const S = 's1'
const e = (type: Parameters<typeof ev>[0], payload: unknown) => ev(type, payload, { sessionId: S })
const fold = (events: KernelEvent[]) => events.reduce(reduce, emptyView())
const user = (turnId = 't1', text = 'hi', extra: object = {}) => e('message.user', { turnId, text, ...extra })
const say = (turnId: string, step: number | undefined, text: string) => e('message.assistant', { turnId, ...(step !== undefined && { step }), text })

beforeEach(() => resetSeq())

describe('toMessages', () => {
  it('user lines: no via on app sessions, Telegram on IM, 转发 on external', () => {
    const v = fold([user('t1', 'a'), e('turn.ended', { turnId: 't1' }), user('t2', 'b', { external: true }), e('turn.ended', { turnId: 't2' })])
    expect(toMessages(v, 'app').messages.map((m) => [m.who, m.text, m.via])).toEqual([['user', 'a', undefined], ['user', 'b', '转发']])
    expect(toMessages(v, 'im').messages.map((m) => m.via)).toEqual(['Telegram', '转发'])
  })

  it('one assistant message per step, reasoning as think, tools inline, never outputOmitted; truncated gets the mark', () => {
    const v = fold([
      user(), e('message.reasoning.delta', { turnId: 't1', step: 1, text: 'hmm' }), say('t1', 1, 'look'),
      e('tool.started', { turnId: 't1', callId: 'c1', name: 'read', argsPreview: 'a' }),
      e('tool.ended', { turnId: 't1', callId: 'c1', name: 'read', ok: true, ms: 1, content: 'body', truncated: true }),
      say('t1', 2, 'done'), e('turn.ended', { turnId: 't1' }),
    ])
    const { messages } = toMessages(v, 'app')
    expect(messages.map((m) => [m.who, m.text])).toEqual([['user', 'hi'], ['ai', 'look'], ['ai', 'done']])
    expect(messages[1].think).toEqual({ label: '思考', steps: ['hmm'] })
    expect(messages[1].tools).toEqual([{ id: 'c1', title: 'read a', name: 'read', status: 'ok', output: `body${TRUNCATED_MARK}` }])
    expect(messages[1].tools!.some((t) => 'outputOmitted' in t || 'outputLines' in t)).toBe(false)
    expect(new Set(messages.map((m) => m.id)).size).toBe(3)
  })

  it('an empty assistant step is hidden', () => {
    const v = fold([user(), e('turn.usage', { turnId: 't1', step: 1, input: 1, output: 1 }), say('t1', 1, ''), e('turn.ended', { turnId: 't1' })])
    expect(toMessages(v, 'app').messages.map((m) => m.who)).toEqual(['user'])
  })

  it('a followUp line sits between steps by seq', () => {
    const v = fold([user('t1', 'a'), say('t1', 1, 'one'), e('turn.parked', { turnId: 't1', step: 1, active: 1, pending: 0 }), user('t1', 'b', { followUp: true }), say('t1', 2, 'two')])
    expect(toMessages(v, 'app').messages.map((m) => m.text)).toEqual(['a', 'one', 'b', 'two'])
  })

  it('streaming: the last assistant message of the open turn until a terminal event', () => {
    const evs = [user(), e('message.assistant.delta', { turnId: 't1', step: 1, text: 'Hel' })]
    let v = fold(evs)
    let r = toMessages(v, 'app')
    expect([...r.streamingIds]).toEqual([r.messages[1].id])
    v = reduce(v, e('turn.ended', { turnId: 't1' }))
    expect(toMessages(v, 'app').streamingIds.size).toBe(0)
  })

  it('an open turn with only the user line gets a streaming placeholder; a parked turn streams nothing', () => {
    let v = fold([user()])
    let r = toMessages(v, 'app')
    expect(r.messages.map((m) => [m.who, m.text])).toEqual([['user', 'hi'], ['ai', '']])
    expect(r.streamingIds.has(r.messages[1].id)).toBe(true)
    v = reduce(v, e('turn.parked', { turnId: 't1', step: 1, active: 1, pending: 0 }))
    r = toMessages(v, 'app')
    expect(r.streamingIds.size).toBe(0)
    expect(r.messages).toHaveLength(1)
  })

  it('groups carry each turn with its messages', () => {
    const v = fold([user('t1'), say('t1', 1, 'x'), e('turn.ended', { turnId: 't1' }), user('t2'), e('turn.ended', { turnId: 't2' })])
    expect(toMessages(v, 'app').groups.map((g) => [g.turnId, g.messages.length])).toEqual([['t1', 2], ['t2', 1]])
  })
})
