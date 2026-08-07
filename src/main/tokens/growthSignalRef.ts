// 进程级的计数器引用。chatService 在很深的调用链里,不方便把计数器一路透传下去。
// 同款做法见 src/main/plugins/pluginSchedulerRef.ts。
import type { createDailyTokenCounter, GrowthSignal } from './dailyTokenCounter'
import { logWarn } from '../log/appLog'

type DailyTokenCounter = ReturnType<typeof createDailyTokenCounter>

let counter: DailyTokenCounter | null = null

export function setDailyTokenCounter(c: DailyTokenCounter | null): void { counter = c }

// 宠物的信号是纯装饰性的,任何一步都不值得拖垮它的调用方 —— 尤其 addDailyTokens 跑在
// chatService.finishOk 里 appendMessage 之后、clearLive/emit('done') 之前:那里抛一次,
// 消息已落盘但 UI 会永远停在「运行中」。计数器内部的 add/setGoalOverride 会同步走到
// onChange → registry.broadcast → webContents.send,链路上任何一环抛异常都在这里被吃掉。
// (logWarn 自身保证不抛 —— 见 appLog.ts。)
function guard(what: string, fn: () => void): void {
  try { fn() } catch (e) {
    logWarn('growth', `${what} 失败(已忽略,不影响聊天)`, String(e))
  }
}

/** 每轮对话结束调一次。计数器还没建起来(启动早期)时静默丢弃,绝不能因此炸掉聊天。 */
export function addDailyTokens(n: number): void { guard('addDailyTokens', () => counter?.add(n)) }

export function currentGrowthSignal(): GrowthSignal | null { return counter?.signal() ?? null }

export function setGrowthGoalOverride(g: number | undefined): void {
  guard('setGrowthGoalOverride', () => counter?.setGoalOverride(g))
}
