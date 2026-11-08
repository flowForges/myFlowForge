import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { useSessions, REFRESH_MS } from './useSessions'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'
import { summary } from '../test/sessions'

let latest: ReturnType<typeof useSessions>
function Probe() {
  latest = useSessions()
  return <div data-testid="ids">{latest.sessions.map((s) => s.id).join(',')}</div>
}

const telegram = {
  chats: { chats: [{ chatId: '42', accountId: '42', sessionId: 'im1', queued: 0, running: false }], worktrees: [] },
  status: {
    state: 'online' as const, enabled: true, tokenSet: true, secretsBackend: 'keychain' as const, proxy: 'none' as const,
    paired: [{ accountId: '42', name: 'Alice', pairedAt: 1 }], pairing: { active: false },
    dropped: { unpaired: 0, stale: 0, group: 0, attachment: 0, badUpdate: 0 }, undelivered: 0, problems: [] as string[],
  },
}

let f: FakeForge
beforeEach(() => { resetSeq() })
afterEach(() => vi.useRealTimers())

describe('useSessions', () => {
  it('loads on mount, newest first', async () => {
    f = installFakeForge({ calls: { 'session.list': { sessions: [summary('old', { updatedAt: 1 }), summary('new', { updatedAt: 9 }), summary('mid', { updatedAt: 5 })] } } })
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('new,mid,old'))
    expect(latest.unsupported).toBe(false)
  })

  it('five events within 300 ms cause one session.list', async () => {
    vi.useFakeTimers()
    f = installFakeForge({ calls: { 'session.list': { sessions: [] } } })
    render(<Probe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(f.callsOf('session.list')).toHaveLength(1)
    act(() => {
      f.emit(ev('session.created', { approvalMode: 'ask' }, { sessionId: 'a' }))
      f.emit(ev('turn.started', { turnId: 't' }, { sessionId: 'a' }))
      f.emit(ev('approval.requested', { approvalId: 'x', turnId: 't', callId: 'c', tool: 'shell', summary: 'ls' }, { sessionId: 'a' }))
      f.emit(ev('turn.parked', { turnId: 't', step: 1, active: 1, pending: 0 }, { sessionId: 'a' }))
      f.emit(ev('session.renamed', { title: 'z' }, { sessionId: 'a' }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS - 10) })
    expect(f.callsOf('session.list')).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(f.callsOf('session.list')).toHaveLength(2)
    // 不相干的事件不拉
    act(() => { f.emit(ev('message.assistant.delta', { turnId: 't', text: 'x' }, { sessionId: 'a' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS * 2) })
    expect(f.callsOf('session.list')).toHaveLength(2)
  })

  it('every spec §7.1 trigger refreshes', async () => {
    vi.useFakeTimers()
    f = installFakeForge({ calls: { 'session.list': { sessions: [] } } })
    render(<Probe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const evs = [
      ev('session.created', { approvalMode: 'ask' }, { sessionId: 'a' }),
      ev('session.renamed', { title: 'z' }, { sessionId: 'a' }),
      ev('session.deleted', {}, { sessionId: 'a' }),
      ev('turn.started', { turnId: 't' }, { sessionId: 'a' }),
      ev('turn.ended', { turnId: 't' }, { sessionId: 'a' }),
      ev('turn.failed', { turnId: 't', reason: 'x' }, { sessionId: 'a' }),
      ev('turn.parked', { turnId: 't', step: 1, active: 1, pending: 0 }, { sessionId: 'a' }),
      ev('turn.resumed', { turnId: 't', step: 1, cause: 'notice' }, { sessionId: 'a' }),
      ev('approval.requested', { approvalId: 'x', turnId: 't', callId: 'c', tool: 'shell', summary: 'ls' }, { sessionId: 'a' }),
      ev('approval.resolved', { approvalId: 'x', decision: 'allow', by: 'user' }, { sessionId: 'a' }),
    ]
    for (const [i, e] of evs.entries()) {
      act(() => f.emit(e))
      await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS + 1) })
      expect(f.callsOf('session.list'), e.type).toHaveLength(i + 2)
    }
  })

  it('a reset alert refetches at once', async () => {
    f = installFakeForge({ calls: { 'session.list': { sessions: [] } } })
    render(<Probe />)
    await waitFor(() => expect(f.callsOf('session.list')).toHaveLength(1))
    f.script({ 'session.list': { sessions: [summary('b')] } })
    act(() => f.alert({ kind: 'reset' }))
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('b'))
  })

  it('-32601 marks unsupported', async () => {
    f = installFakeForge({ calls: { 'session.list': () => fail(-32601, 'method not found') } })
    render(<Probe />)
    await waitFor(() => expect(latest.unsupported).toBe(true))
    expect(latest.sessions).toEqual([])
  })

  it('imNames: Telegram name by sessionId from channel.telegram.chats and the paired names', async () => {
    f = installFakeForge({ calls: {
      'session.list': { sessions: [summary('im1', { origin: 'im' }), summary('a')] },
      'channel.telegram.chats': telegram.chats,
      'channel.telegram.status': telegram.status,
    } })
    render(<Probe />)
    await waitFor(() => expect(latest.imNames.get('im1')).toBe('Alice'))
    expect(latest.imNames.size).toBe(1)
  })

  it('imNames: no paired name falls back to the account id; -32601 from chats is ignored', async () => {
    f = installFakeForge({ calls: {
      'session.list': { sessions: [summary('im1', { origin: 'im' })] },
      'channel.telegram.chats': telegram.chats,
      'channel.telegram.status': () => fail(-32601),
    } })
    render(<Probe />)
    await waitFor(() => expect(latest.imNames.get('im1')).toBe('42'))

    f = installFakeForge({ calls: { 'session.list': { sessions: [summary('im1', { origin: 'im' })] } } })
    render(<Probe />)
    await waitFor(() => expect(f.callsOf('channel.telegram.chats')).toHaveLength(1))
    expect(latest.imNames.size).toBe(0)
    expect(latest.sessions.map((s) => s.id)).toEqual(['im1'])
  })

  it('no IM session: Telegram is not asked', async () => {
    f = installFakeForge({ calls: { 'session.list': { sessions: [summary('a')] } } })
    render(<Probe />)
    await waitFor(() => expect(latest.sessions).toHaveLength(1))
    expect(f.callsOf('channel.telegram.chats')).toHaveLength(0)
  })

  it('a stale answer never overwrites a newer one', async () => {
    let release!: (v: unknown) => void
    let n = 0
    f = installFakeForge({ calls: {
      'session.list': () => (++n === 1 ? new Promise((r) => { release = r }) as never : { sessions: [summary('fresh')] }),
    } })
    render(<Probe />)
    await waitFor(() => expect(n).toBe(1))
    act(() => latest.reload())
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('fresh'))
    await act(async () => { release({ sessions: [summary('stale')] }) })
    expect(screen.getByTestId('ids').textContent).toBe('fresh')
  })
})
