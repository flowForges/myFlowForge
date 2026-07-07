import { describe, it, expect, vi } from 'vitest'
import { EventLoopMonitor } from './eventLoopMonitor'

function harness() {
  let tick: (() => void) | null = null
  let clock = 0
  const deps = {
    setInterval: (cb: () => void) => { tick = cb; return 1 as unknown as ReturnType<typeof setInterval> },
    clearInterval: vi.fn(),
    now: () => clock,
  }
  return { deps, fire: () => tick?.(), setClock: (n: number) => { clock = n } }
}

describe('EventLoopMonitor', () => {
  it('fires onStall when a sample drifts >= STALL_MS, with the drift and active snapshot', () => {
    const h = harness()
    const onStall = vi.fn()
    const m = new EventLoopMonitor(h.deps)
    m.start(onStall)                 // last = 0
    h.setClock(50); h.fire()         // gap 50, expected 50, drift 0 → no stall
    expect(onStall).not.toHaveBeenCalled()
    h.setClock(50 + 220); h.fire()   // gap 220, expected 50, drift 170 → stall
    expect(onStall).toHaveBeenCalledTimes(1)
    expect(onStall.mock.calls[0][0]).toBe(170)
    expect(Array.isArray(onStall.mock.calls[0][1])).toBe(true)
  })

  it('does not fire for sub-threshold drift', () => {
    const h = harness()
    const onStall = vi.fn()
    const m = new EventLoopMonitor(h.deps)
    m.start(onStall)
    h.setClock(50 + 80); h.fire()    // drift 80 (< 100) → no stall
    expect(onStall).not.toHaveBeenCalled()
  })

  it('stop() clears the interval', () => {
    const h = harness()
    const m = new EventLoopMonitor(h.deps)
    m.start(vi.fn())
    m.stop()
    expect(h.deps.clearInterval).toHaveBeenCalledWith(1)
  })

  it('never throws if onStall throws', () => {
    const h = harness()
    const m = new EventLoopMonitor(h.deps)
    m.start(() => { throw new Error('boom') })
    h.setClock(50 + 300)
    expect(() => h.fire()).not.toThrow()
  })
})
