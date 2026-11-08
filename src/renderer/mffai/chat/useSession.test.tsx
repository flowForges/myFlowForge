import { describe, it, expect, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { KernelEvent } from '@mffai/protocol'
import { useSession } from './useSession'
import { route } from '../route'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'
import { ev, redacted, resetSeq } from '../test/events'
import { summary } from '../test/sessions'

const S = 's1'
const e = (type: Parameters<typeof ev>[0], payload: unknown, seq?: number) => ev(type, payload, { sessionId: S, ...(seq !== undefined && { seq }) })
const state = (events: KernelEvent[], extra: object = {}) => ({ session: summary(S), events, hasMore: false, lastSeq: events.at(-1)?.seq ?? 0, ...extra })

let api: ReturnType<typeof useSession>
function Probe({ id = S }: { id?: string }) {
  api = useSession(id)
  const v = api.view
  return (
    <div data-testid="probe" data-error={api.error ?? ''}>
      {v?.turns.flatMap((t) => [...t.users.map((u) => `U:${u.text}`), ...t.steps.map((s) => `A:${s.text}`)]).join('|')}
    </div>
  )
}
const text = () => screen.getByTestId('probe').textContent

let f: FakeForge
beforeEach(() => { resetSeq(); route.set({ page: 'chat', sessionId: S }) })

describe('useSession', () => {
  it('session.state, then live events for this session; seq <= lastSeq dropped; other sessions ignored', async () => {
    const evs = [e('message.user', { turnId: 't1', text: 'hi' }), e('message.assistant.delta', { turnId: 't1', step: 1, text: 'He' })]
    f = installFakeForge({ calls: { 'session.state': state(evs, { open: { turnId: 't1', parked: false, approvalIds: [] } }) } })
    render(<Probe />)
    await waitFor(() => expect(text()).toBe('U:hi|A:He'))
    expect(f.callsOf('session.state')).toEqual([{ sessionId: S }])
    act(() => {
      f.emit(evs[1])
      f.emit(e('message.assistant.delta', { turnId: 't1', step: 1, text: 'llo' }))
      f.emit(ev('message.user', { turnId: 'tx', text: 'other' }, { sessionId: 's2' }))
    })
    expect(text()).toBe('U:hi|A:Hello')
  })

  it('live events that arrive while session.state is in flight are applied once it answers', async () => {
    let answer!: (v: unknown) => void
    f = installFakeForge({ calls: { 'session.state': () => new Promise((r) => { answer = r }) as never } })
    render(<Probe />)
    const u = e('message.user', { turnId: 't1', text: 'hi' }, 1)
    const late = e('message.assistant.delta', { turnId: 't1', step: 1, text: 'x' }, 2)
    act(() => { f.emit(u); f.emit(late) })
    await act(async () => { answer(state([u], { lastSeq: 1, open: { turnId: 't1', parked: false, approvalIds: [] } })) })
    expect(text()).toBe('U:hi|A:x')
  })

  it('a reset alert refetches session.state and replaces the view without duplicates', async () => {
    const evs = [e('message.user', { turnId: 't1', text: 'hi' })]
    f = installFakeForge({ calls: { 'session.state': state(evs) } })
    render(<Probe />)
    await waitFor(() => expect(text()).toBe('U:hi'))
    await act(async () => { f.alert({ kind: 'reset' } as never) })
    await waitFor(() => expect(f.callsOf('session.state')).toHaveLength(2))
    expect(text()).toBe('U:hi')
  })

  it('events.redacted hitting a cached seq refetches; one for other seqs does not', async () => {
    const u = e('message.user', { turnId: 't1', text: 'secret' })
    let n = 0
    f = installFakeForge({ calls: { 'session.state': () => (n++ ? state([{ ...u, payload: { turnId: 't1', text: '[已删除]' } }]) : state([u])) as never } })
    render(<Probe />)
    await waitFor(() => expect(text()).toBe('U:secret'))
    await act(async () => { f.emit(redacted({ seqs: [999] })) })
    expect(f.callsOf('session.state')).toHaveLength(1)
    await act(async () => { f.emit(redacted({ seqs: [u.seq] })) })
    await waitFor(() => expect(text()).toBe('U:[已删除]'))
  })

  it('a whole-session erase of this session routes back to the list', async () => {
    f = installFakeForge({ calls: { 'session.state': state([e('message.user', { turnId: 't1', text: 'hi' })]) } })
    render(<Probe />)
    await waitFor(() => expect(text()).toBe('U:hi'))
    act(() => f.emit(redacted({ session: 'other' })))
    expect(route.get().sessionId).toBe(S)
    act(() => f.emit(redacted({ session: S })))
    expect(route.get()).toEqual({ page: 'chat' })
    expect(text()).toBe('')
  })

  it('loadOlder pages back with session.events {beforeSeq: firstSeq}', async () => {
    const old = [e('message.user', { turnId: 't0', text: 'old' }, 5), e('turn.ended', { turnId: 't0' }, 6)]
    const cur = [e('message.user', { turnId: 't1', text: 'new' }, 10)]
    f = installFakeForge({ calls: { 'session.state': state(cur, { hasMore: true, open: { turnId: 't1', parked: false, approvalIds: [] } }), 'session.events': { events: old, hasMore: false } } })
    render(<Probe />)
    await waitFor(() => expect(text()).toBe('U:new'))
    expect(api.view!.hasMore).toBe(true)
    await act(async () => { api.loadOlder() })
    expect(f.callsOf('session.events')).toEqual([{ sessionId: S, beforeSeq: 10, limit: 300 }])
    expect(text()).toBe('U:old|U:new')
    expect(api.view!.hasMore).toBe(false)
    expect(api.view!.open).toEqual({ turnId: 't1', parked: false })
  })

  it('unknown session: error gone', async () => {
    f = installFakeForge({ calls: { 'session.state': () => fail(-32602, 'unknown session') } })
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('probe').dataset.error).toBe('gone'))
  })

  it('a reload that answers unknown session drops the cached text', async () => {
    let gone = false
    f = installFakeForge({ calls: { 'session.state': () => (gone ? fail(-32602, 'unknown session') : state([e('message.user', { turnId: 't1', text: 'secret words' })])) as never } })
    render(<Probe />)
    await waitFor(() => expect(text()).toBe('U:secret words'))
    gone = true
    await act(async () => { f.alert({ kind: 'reset' } as never) })
    await waitFor(() => expect(screen.getByTestId('probe').dataset.error).toBe('gone'))
    expect(text()).toBe('')
  })
})
