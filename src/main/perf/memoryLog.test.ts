import { describe, it, expect, vi } from 'vitest'
import { formatMemoryLog, startMemoryLog, type MemoryProcessMetric } from './memoryLog'
import { MEMORY_LOG_INITIAL_DELAY_MS, MEMORY_LOG_INTERVAL_MS } from './perfConstants'

describe('formatMemoryLog', () => {
  it('formats each process type + workingSetSize (MB) plus the main heap (MB)', () => {
    const metrics: MemoryProcessMetric[] = [
      { type: 'Browser', memory: { workingSetSize: 204800 } }, // 200MB
      { type: 'Tab', memory: { workingSetSize: 51200 } },      // 50MB
    ]
    expect(formatMemoryLog(metrics, 104857600 /* 100MB */))
      .toBe('Browser 200MB, Tab 50MB | main heapUsed 100MB')
  })

  it('handles an empty metrics array', () => {
    expect(formatMemoryLog([], 1048576 /* 1MB */)).toBe(' | main heapUsed 1MB')
  })
})

function harness() {
  let timeoutCb: (() => void) | null = null
  let intervalCb: (() => void) | null = null
  const deps = {
    getAppMetrics: vi.fn(() => [] as MemoryProcessMetric[]),
    getMainHeapUsedBytes: vi.fn(() => 0),
    log: vi.fn(),
    setTimeout: vi.fn((cb: () => void, _ms: number) => { timeoutCb = cb; return 1 as unknown as ReturnType<typeof setTimeout> }),
    clearTimeout: vi.fn(),
    setInterval: vi.fn((cb: () => void, _ms: number) => { intervalCb = cb; return 2 as unknown as ReturnType<typeof setInterval> }),
    clearInterval: vi.fn(),
  }
  return { deps, fireTimeout: () => timeoutCb?.(), fireInterval: () => intervalCb?.() }
}

describe('startMemoryLog', () => {
  it('schedules the first line after the initial delay, then recurs on the interval', () => {
    const h = harness()
    startMemoryLog(h.deps)
    expect(h.deps.setTimeout).toHaveBeenCalledWith(expect.any(Function), MEMORY_LOG_INITIAL_DELAY_MS)
    expect(h.deps.log).not.toHaveBeenCalled()
    h.fireTimeout()
    expect(h.deps.log).toHaveBeenCalledTimes(1)
    expect(h.deps.setInterval).toHaveBeenCalledWith(expect.any(Function), MEMORY_LOG_INTERVAL_MS)
    h.fireInterval()
    expect(h.deps.log).toHaveBeenCalledTimes(2)
  })

  it('stop() clears both the initial timeout and the recurring interval', () => {
    const h = harness()
    const stop = startMemoryLog(h.deps)
    h.fireTimeout() // start the interval
    stop()
    expect(h.deps.clearTimeout).toHaveBeenCalledWith(1)
    expect(h.deps.clearInterval).toHaveBeenCalledWith(2)
  })

  it('never throws if the logger or metrics getter throws', () => {
    const h = harness()
    h.deps.getAppMetrics.mockImplementation(() => { throw new Error('boom') })
    startMemoryLog(h.deps)
    expect(() => h.fireTimeout()).not.toThrow()
  })
})
