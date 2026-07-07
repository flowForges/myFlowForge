import { describe, it, expect, vi } from 'vitest'
import { makeIdleWatchdog } from './idleWatchdog'

// A controllable fake timer so we can test the countdown deterministically.
function fakeTimers() {
  let seq = 0
  const jobs = new Map<number, () => void>()
  return {
    set: (fn: () => void, _ms: number) => { const id = ++seq; jobs.set(id, fn); return id },
    clear: (h: unknown) => { jobs.delete(h as number) },
    fire: (h: unknown) => { const fn = jobs.get(h as number); if (fn) fn() },
    // fire whatever single job is currently armed
    fireArmed: () => { const [id, fn] = [...jobs.entries()][0] ?? []; if (fn) { jobs.delete(id as number); fn() } },
    pending: () => jobs.size,
  }
}

describe('makeIdleWatchdog', () => {
  it('fires onIdle after the idle window with no beats', () => {
    const t = fakeTimers()
    const onIdle = vi.fn()
    const wd = makeIdleWatchdog(1000, onIdle, t)
    expect(wd.firedFlag).toBe(false)
    t.fireArmed()                     // simulate the timer elapsing with no activity
    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(wd.firedFlag).toBe(true)
  })

  it('a beat re-arms the timer, so a progressing turn is never killed', () => {
    const t = fakeTimers()
    const onIdle = vi.fn()
    const wd = makeIdleWatchdog(1000, onIdle, t)
    wd.beat(); wd.beat(); wd.beat()   // activity keeps resetting
    expect(t.pending()).toBe(1)       // exactly one armed timer at a time
    wd.clear()                        // process exited normally
    expect(t.pending()).toBe(0)
    t.fireArmed()                     // nothing armed → no fire
    expect(onIdle).not.toHaveBeenCalled()
    expect(wd.firedFlag).toBe(false)
  })

  it('clear() after firing does not double-fire; beats after clear are ignored', () => {
    const t = fakeTimers()
    const onIdle = vi.fn()
    const wd = makeIdleWatchdog(1000, onIdle, t)
    wd.clear()
    wd.beat()                         // ignored — already done
    expect(t.pending()).toBe(0)
    expect(onIdle).not.toHaveBeenCalled()
  })
})
