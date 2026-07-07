import { describe, it, expect, vi } from 'vitest'
import { TermBatcher } from './termBatch'

// Manual scheduler: capture the flush callback so tests can fire the coalescing window on demand.
function makeManual() {
  let cb: (() => void) | null = null
  const schedule = (fn: () => void) => { cb = fn }
  const tick = () => { const c = cb; cb = null; c?.() }
  return { schedule, tick }
}

describe('TermBatcher', () => {
  it('coalesces many chunks in one window into a single flush, preserving order', () => {
    const { schedule, tick } = makeManual()
    const flush = vi.fn()
    const b = new TermBatcher({ flush, schedule })
    b.push('t1', 'a'); b.push('t1', 'b'); b.push('t1', 'c')
    expect(flush).not.toHaveBeenCalled()  // nothing until the window fires
    tick()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith('t1', 'abc')
  })

  it('schedules only one window per burst across terminals', () => {
    const schedule = vi.fn()
    const b = new TermBatcher({ flush: vi.fn(), schedule })
    b.push('t1', 'x'); b.push('t2', 'y'); b.push('t1', 'z')
    expect(schedule).toHaveBeenCalledTimes(1)
  })

  it('keeps terminals separate', () => {
    const { schedule, tick } = makeManual()
    const flush = vi.fn()
    const b = new TermBatcher({ flush, schedule })
    b.push('t1', 'one'); b.push('t2', 'two')
    tick()
    expect(flush).toHaveBeenCalledWith('t1', 'one')
    expect(flush).toHaveBeenCalledWith('t2', 'two')
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('flushes immediately when a term crosses the byte cap (bounds latency under a flood)', () => {
    const { schedule } = makeManual()
    const flush = vi.fn()
    const b = new TermBatcher({ flush, schedule, maxBytes: 4 })
    b.push('t1', 'abcd')          // reaches the cap → immediate flush, no window needed
    expect(flush).toHaveBeenCalledWith('t1', 'abcd')
  })

  it('flush(termId) emits pending trailing output (e.g. on exit)', () => {
    const { schedule } = makeManual()
    const flush = vi.fn()
    const b = new TermBatcher({ flush, schedule })
    b.push('t1', 'bye')
    b.flush('t1')
    expect(flush).toHaveBeenCalledWith('t1', 'bye')
  })

  it('drop(termId) discards pending output without emitting', () => {
    const { schedule, tick } = makeManual()
    const flush = vi.fn()
    const b = new TermBatcher({ flush, schedule })
    b.push('t1', 'gone')
    b.drop('t1')
    tick()
    expect(flush).not.toHaveBeenCalled()
  })

  it('re-arms the window for chunks arriving after a flush', () => {
    const { schedule, tick } = makeManual()
    const flush = vi.fn()
    const b = new TermBatcher({ flush, schedule })
    b.push('t1', '1'); tick()
    b.push('t1', '2'); tick()
    expect(flush).toHaveBeenNthCalledWith(1, 't1', '1')
    expect(flush).toHaveBeenNthCalledWith(2, 't1', '2')
  })
})
