import { describe, expect, it } from 'vitest'
import { CLOSE_GRACE_MS, CLOSE_MARGIN_MS, DRAIN_MS, WORKER_KILL_MS } from './shutdown'

describe('shutdown budget', () => {
  it('drain + close grace + margin fits before the supervisor SIGKILL', () => {
    expect(DRAIN_MS).toBeGreaterThan(0)
    expect(CLOSE_MARGIN_MS).toBeGreaterThanOrEqual(1_000)
    expect(DRAIN_MS + CLOSE_GRACE_MS + CLOSE_MARGIN_MS).toBeLessThanOrEqual(WORKER_KILL_MS)
    // shell 的 SIGTERM → SIGKILL(2 s)+ 管道宽限(1 s)要在 close 的等待里完成
    expect(CLOSE_GRACE_MS).toBeGreaterThan(3_000)
  })
})
