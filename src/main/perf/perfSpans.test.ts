import { describe, it, expect, vi } from 'vitest'
import { perfSpan, activeSpans, activeCount, __setPerfNow } from './perfSpans'
import { setAppLogEventSink } from '../log/appLog'

describe('perfSpans', () => {
  it('tracks an active span while fn runs and removes it after', () => {
    let clock = 0
    __setPerfNow(() => clock)
    let snapshotDuringRun: number | null = null
    const r = perfSpan('git', 'readChanges', () => {
      clock = 30
      snapshotDuringRun = activeCount()
      return 'ok'
    })
    expect(r).toBe('ok')
    expect(snapshotDuringRun).toBe(1)
    expect(activeCount()).toBe(0) // removed after
  })

  it('activeSpans reports elapsed for in-flight spans', () => {
    let clock = 0
    __setPerfNow(() => clock)
    let snap: ReturnType<typeof activeSpans> = []
    perfSpan('watcher', 'onChange', () => { clock = 40; snap = activeSpans() })
    expect(snap).toEqual([{ scope: 'watcher', label: 'onChange', elapsedMs: 40 }])
  })

  it('logs a perf entry only when duration >= OP_LOG_MS (50ms)', () => {
    let clock = 0
    __setPerfNow(() => clock)
    const entries: string[] = []
    setAppLogEventSink(e => { if (e.scope === 'perf') entries.push(e.msg) })
    perfSpan('a', 'fast', () => { clock = 10 })   // 10ms — below threshold
    perfSpan('b', 'slow', () => { clock = 10 + 60 }) // 60ms — logged
    setAppLogEventSink(null)
    expect(entries).toEqual(['b.slow 60ms'])
  })

  it('removes the span and rethrows when fn throws', () => {
    __setPerfNow(() => 0)
    expect(() => perfSpan('x', 'boom', () => { throw new Error('nope') })).toThrow('nope')
    expect(activeCount()).toBe(0)
  })

  it('awaits and removes the span for an async fn that rejects', async () => {
    __setPerfNow(() => 0)
    await expect(perfSpan('x', 'async', () => Promise.reject(new Error('bad')))).rejects.toThrow('bad')
    expect(activeCount()).toBe(0)
  })
})
