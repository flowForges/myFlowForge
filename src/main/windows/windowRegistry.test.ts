import { describe, it, expect } from 'vitest'
import { WindowRegistry } from './windowRegistry'

interface FakeWc {
  sent: [string, unknown][]
  send: (ch: string, p: unknown) => void
  isDestroyed: () => boolean
  once: (ev: string, cb: () => void) => void
  kill: () => void
}

function fakeWc(): FakeWc {
  const sent: [string, unknown][] = []
  const handlers: Record<string, () => void> = {}
  let destroyed = false
  return {
    sent,
    send: (ch, p) => sent.push([ch, p]),
    isDestroyed: () => destroyed,
    once: (ev, cb) => { handlers[ev] = cb },
    kill: () => { destroyed = true; handlers['destroyed']?.() }
  }
}

describe('WindowRegistry', () => {
  it('broadcasts to every registered webContents', () => {
    const reg = new WindowRegistry()
    const a = fakeWc(); const b = fakeWc()
    reg.add(a as never); reg.add(b as never)
    reg.broadcast('engine:event', { type: 'x' })
    expect(a.sent).toEqual([['engine:event', { type: 'x' }]])
    expect(b.sent).toEqual([['engine:event', { type: 'x' }]])
  })

  it('skips and auto-removes a destroyed webContents', () => {
    const reg = new WindowRegistry()
    const a = fakeWc(); const b = fakeWc()
    reg.add(a as never); reg.add(b as never)
    a.kill()
    reg.broadcast('chat:event', { id: '1' })
    expect(a.sent).toEqual([])
    expect(b.sent).toEqual([['chat:event', { id: '1' }]])
  })

  it('guards against a webContents destroyed without firing the event', () => {
    const reg = new WindowRegistry()
    const a = fakeWc()
    reg.add(a as never)
    ;(a as { isDestroyed: () => boolean }).isDestroyed = () => true
    reg.broadcast('changes:event', { cwd: '/x', changes: [] })
    expect(a.sent).toEqual([])
  })
})
