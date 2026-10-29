// 监管进程的纯函数:重启间隔、熔断判断、OOM 识别

const MAX_DELAY_MS = 60_000
const CRASH_WINDOW_MS = 5 * 60_000
const CRASH_LIMIT = 10
const OOM_WINDOW_MS = 30 * 60_000
const OOM_LIMIT = 2

export interface Failure {
  at: number
  oom: boolean
}

export type TripDecision = { trip: false } | { trip: true; reason: 'crash-loop' | 'oom' }

/** 第 n 次连续失败后的等待:1 s 起翻倍,60 s 封顶(n ≥ 1) */
export function nextDelayMs(consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures)
  return Math.min(1000 * 2 ** (n - 1), MAX_DELAY_MS)
}

export function shouldTrip(history: Failure[], now: number): TripDecision {
  const oom = history.filter(f => f.oom && f.at > now - OOM_WINDOW_MS).length
  if (oom >= OOM_LIMIT) return { trip: true, reason: 'oom' }
  const recent = history.filter(f => f.at > now - CRASH_WINDOW_MS).length
  if (recent >= CRASH_LIMIT) return { trip: true, reason: 'crash-loop' }
  return { trip: false }
}

export function isOom(exit: { code: number | null; signal: string | null; stderrTail: string }): boolean {
  return exit.code === 134 || exit.stderrTail.includes('heap out of memory')
}
