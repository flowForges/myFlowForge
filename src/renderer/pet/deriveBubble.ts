import type { PopupActiveAgent } from './derivePopupData'

export interface BubbleData { greet: string; stage: string }

// 人格化陪伴语小池。不用 Math.random(该环境禁用)——按 seed 字符和取模,保证同一 run 内稳定。
const GREETS = ['我在帮你盯着这个任务 👀', '交给我,你去忙别的', '进度我看着呢', '正在推进,稍等片刻']

export function deriveBubble(active: PopupActiveAgent[], seed: string): BubbleData | null {
  if (active.length === 0) return null
  const sum = [...(seed || 'x')].reduce((n, c) => n + c.charCodeAt(0), 0)
  const greet = GREETS[sum % GREETS.length]
  const first = active[0]
  const stage = active.length === 1
    ? `正在执行:${first.stage} · ${first.name}`
    : `${first.stage} · ${active.length} 个代理`
  return { greet, stage }
}
