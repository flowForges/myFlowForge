import { it, expect, vi } from 'vitest'
import { ChatQueue } from './chatQueue'
import type { ChatSendPayload } from '@shared/types'

const mk = (text: string, sid = 's1'): ChatSendPayload =>
  ({ workspacePath: '/w', sessionId: sid, agent: 'codex', agentLabel: 'Codex', model: 'm', text, attachments: [] })
const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }

it('a turn refused because the official app holds the session goes back to the head of the queue and the lane waits for 重试', async () => {
  let busy = true
  const calls: string[] = []
  const runTurn = vi.fn(async (p: ChatSendPayload) => { calls.push(p.text); return busy ? { busyElsewhere: 'Codex' } : undefined })
  const events: any[] = []
  const q = new ChatQueue(runTurn, (_ch, e) => events.push(e))
  q.enqueue(mk('A'), '你')
  q.enqueue(mk('B'), '你')
  await tick()
  expect(calls).toEqual(['A'])                       // B does not run behind a refused A
  const last = events[events.length - 1]
  expect(last.blocked).toEqual({ s1: 'Codex' })
  expect(last.queue.map((x: any) => x.text)).toEqual(['A', 'B'])
  expect(last.busy).toBe(false)
  // other sessions are unaffected
  q.enqueue(mk('X', 's2'), '你')
  await tick()
  expect(calls).toEqual(['A', 'X'])
  busy = false
  q.retry('/w', 's1')
  await tick()
  expect(calls).toEqual(['A', 'X', 'A', 'B'])
  expect(events[events.length - 1].blocked).toEqual({ s2: 'Codex' })   // s2's own refusal is still held
})

it('sending again while blocked retries; withdrawing the held messages or clearing the queue lifts the block', async () => {
  const calls: string[] = []
  const q = new ChatQueue(async (p) => { calls.push(p.text); return { busyElsewhere: 'Claude' } }, () => {})
  q.enqueue(mk('A'), '你')
  await tick()
  q.enqueue(mk('B'), '你')
  await tick()
  expect(calls).toEqual(['A', 'A'])                  // the new send re-tried the held one first
  expect(q.snapshot('/w').queue.map(x => x.text)).toEqual(['A', 'B'])
  for (const item of q.snapshot('/w').queue) q.cancel('/w', item.id)
  expect(q.snapshot('/w').blocked).toEqual({})
  q.enqueue(mk('C'), '你')
  await tick()
  expect(q.snapshot('/w').blocked).toEqual({ s1: 'Claude' })
  q.clear('/w')
  expect(q.snapshot('/w').blocked).toEqual({})
})
