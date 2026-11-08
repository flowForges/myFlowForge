import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { onMffaiEvent, onMffaiReset, useMffaiEvent } from './events'
import { installFakeForge, type FakeForge } from './test/fakeForge'
import { ev } from './test/events'

let f: FakeForge
beforeEach(() => { f = installFakeForge() })

describe('events fan-out', () => {
  it('one onEvent registration for N subscribers, dropped at zero, re-made on the next', () => {
    const offs = [0, 1, 2].map(() => onMffaiEvent({}, () => {}))
    expect(f.mffai.onEvent).toHaveBeenCalledTimes(1)
    expect(f.listeners()).toBe(1)
    offs[0](); offs[1]()
    expect(f.listeners()).toBe(1)
    offs[2]()
    expect(f.listeners()).toBe(0)
    offs[2]() // 重复退订无害
    const off = onMffaiEvent({}, () => {})
    expect(f.mffai.onEvent).toHaveBeenCalledTimes(2)
    off()
    expect(f.listeners()).toBe(0)
  })

  it('filters by type and session', () => {
    const all = vi.fn(), byType = vi.fn(), bySession = vi.fn()
    const offs = [
      onMffaiEvent({}, all),
      onMffaiEvent({ types: ['message.user'] }, byType),
      onMffaiEvent({ sessionId: 's2' }, bySession),
    ]
    f.emit(ev('message.user', { turnId: 't', text: 'a' }, { sessionId: 's1' }))
    f.emit(ev('turn.ended', { turnId: 't' }, { sessionId: 's2' }))
    expect(all).toHaveBeenCalledTimes(2)
    expect(byType).toHaveBeenCalledTimes(1)
    expect(byType.mock.calls[0][0].type).toBe('message.user')
    expect(bySession).toHaveBeenCalledTimes(1)
    expect(bySession.mock.calls[0][0].sessionId).toBe('s2')
    offs.forEach((o) => o())
  })

  it('a throwing subscriber does not stop the others', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = vi.fn()
    const offs = [onMffaiEvent({}, () => { throw new Error('x') }), onMffaiEvent({}, ok)]
    f.emit(ev('kernel.started', { version: '1' }))
    expect(ok).toHaveBeenCalledTimes(1)
    offs.forEach((o) => o())
    err.mockRestore()
  })

  it('a reset alert reaches each onMffaiReset subscriber once; other alerts do not', () => {
    const a = vi.fn(), b = vi.fn()
    const offA = onMffaiReset(a), offB = onMffaiReset(b)
    expect(f.mffai.onAlert).toHaveBeenCalledTimes(1)
    f.alert({ kind: 'restarting' })
    expect(a).not.toHaveBeenCalled()
    f.alert({ kind: 'reset' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA(); offB()
    expect(f.alertListeners()).toBe(0)
    f.alert({ kind: 'reset' })
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('useMffaiEvent subscribes while mounted and always calls the latest callback', () => {
    const seen: string[] = []
    function C({ tag }: { tag: string }) {
      useMffaiEvent({ types: ['message.user'] }, (e) => seen.push(`${tag}:${e.seq}`))
      return null
    }
    const r = render(<C tag="a" />)
    const e1 = ev('message.user', { turnId: 't', text: 'x' }, { sessionId: 's' })
    act(() => f.emit(e1))
    r.rerender(<C tag="b" />)
    const e2 = ev('message.user', { turnId: 't', text: 'y' }, { sessionId: 's' })
    act(() => f.emit(e2))
    expect(seen).toEqual([`a:${e1.seq}`, `b:${e2.seq}`])
    expect(f.mffai.onEvent).toHaveBeenCalledTimes(1)
    r.unmount()
    expect(f.listeners()).toBe(0)
  })
})
