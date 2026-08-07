// 进程级的计数器引用。chatService 在很深的调用链里,不方便把计数器一路透传下去。
// 同款做法见 src/main/plugins/pluginSchedulerRef.ts。
import type { createDailyTokenCounter, GrowthSignal } from './dailyTokenCounter'

type DailyTokenCounter = ReturnType<typeof createDailyTokenCounter>

let counter: DailyTokenCounter | null = null

export function setDailyTokenCounter(c: DailyTokenCounter | null): void { counter = c }

/** 每轮对话结束调一次。计数器还没建起来(启动早期)时静默丢弃,绝不能因此炸掉聊天。 */
export function addDailyTokens(n: number): void { counter?.add(n) }

export function currentGrowthSignal(): GrowthSignal | null { return counter?.signal() ?? null }

export function setGrowthGoalOverride(g: number | undefined): void { counter?.setGoalOverride(g) }
