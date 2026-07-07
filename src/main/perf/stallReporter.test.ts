import { describe, it, expect, vi } from 'vitest'
import { attributionOf, StallReporter } from './stallReporter'
import { setAppLogEventSink } from '../log/appLog'

const span = (scope: string, label: string, elapsedMs: number) => ({ scope, label, elapsedMs })

describe('attributionOf', () => {
  it('returns idle for an empty set', () => { expect(attributionOf([])).toBe('idle') })
  it('picks the longest-running active span', () => {
    expect(attributionOf([span('watcher', 'onChange', 20), span('git', 'readChanges', 90)]))
      .toBe('git.readChanges')
  })
})

describe('StallReporter', () => {
  it('always logs a warn perf entry naming the attribution', () => {
    const entries: { msg: string }[] = []
    setAppLogEventSink(e => { if (e.scope === 'perf' && e.level === 'warn') entries.push({ msg: e.msg }) })
    const r = new StallReporter({ toast: vi.fn(), now: () => 0 })
    r.report(180, [span('git', 'readChanges', 170)])
    setAppLogEventSink(null)
    expect(entries[0].msg).toBe('stall 180ms during git.readChanges')
  })

  it('does not toast below TOAST_MS but still logs', () => {
    const toast = vi.fn()
    const r = new StallReporter({ toast, now: () => 0 })
    r.report(200, [span('git', 'readChanges', 190)]) // 200 < 500
    expect(toast).not.toHaveBeenCalled()
  })

  it('toasts at/above TOAST_MS', () => {
    const toast = vi.fn()
    const r = new StallReporter({ toast, now: () => 0 })
    r.report(620, [span('git', 'readChanges', 610)])
    expect(toast).toHaveBeenCalledWith('主进程卡顿 620ms · git.readChanges')
  })

  it('dedupes the same attribution within TOAST_DEDUP_MS, re-toasts after', () => {
    const toast = vi.fn()
    let clock = 0
    const r = new StallReporter({ toast, now: () => clock })
    r.report(600, [span('git', 'readChanges', 590)])      // toast #1
    clock = 10_000
    r.report(700, [span('git', 'readChanges', 690)])      // within 30s → suppressed
    clock = 40_000
    r.report(800, [span('git', 'readChanges', 790)])      // after 30s → toast #2
    expect(toast).toHaveBeenCalledTimes(2)
  })

  it('different attributions toast independently', () => {
    const toast = vi.fn()
    const r = new StallReporter({ toast, now: () => 0 })
    r.report(600, [span('git', 'readChanges', 590)])
    r.report(600, [span('watcher', 'onChange', 590)])
    expect(toast).toHaveBeenCalledTimes(2)
  })
})
