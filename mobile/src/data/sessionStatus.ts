/**
 * 会话的四档状态阶梯:**等你答话 > 执行中 > 未读 > 歇着**。
 *
 * ★「等你答话」是 `confirm`(允许/拒绝)和 `questions`/`ask`(回答/输入)**合并**的一档。
 *  电脑端 `src/renderer/shell/wsBadge.ts` 把这两者分开并排成「待输入 > 待确认」,
 *  合并是本次拍板的决定 —— 对人来说两者都是「它停在那儿等我」,而且合并顺带消掉了
 *  两端顺序相反这个矛盾。
 *
 * ★这个文件刻意**不 import 任何东西**。它只吃普通布尔值,所以能在 node 环境里单测
 *  (vitest 的 mobile project 跑不了 import react-native 的文件)。
 */

export type SessionTier = 'gate' | 'running' | 'unread' | 'idle'

export type TierInput = {
  /** 这条会话上挂着门(confirm / questions / ask 都算) */
  hasGate: boolean
  /** 这条会话的 id 在它所属工作区的 runningSessionIds 里 */
  running: boolean
  /** 上一轮结束时(done 或 error)你没在看这条 */
  unread: boolean
}

/**
 * 一条会话只显示**最高的那一档**。
 *
 * ★注意「在跑的不冒未读」:正在跑的会话已经在「执行中」那一档了,再让它同时算未读没有意义 ——
 *  界面上只有一个位置,而且「在跑」比「有新内容」更能说明现在的状况。
 */
export function tierOf(input: TierInput): SessionTier {
  if (input.hasGate) return 'gate'
  if (input.running) return 'running'
  if (input.unread) return 'unread'
  return 'idle'
}

export type TierCounts = { gate: number; running: number; unread: number }

/** 数各档的条数。歇着的不数 —— 没人关心「有多少条没事」。 */
export function countTiers(tiers: SessionTier[]): TierCounts {
  const out: TierCounts = { gate: 0, running: 0, unread: 0 }
  for (const t of tiers) if (t !== 'idle') out[t] += 1
  return out
}

/**
 * 气泡该显示哪一档。
 *
 * ★全空返回 **null** 而不是 `'idle'`:调用方靠这个 null 决定**整个气泡不出现**。
 *  返回 'idle' 会让它画出一个「0 条歇着」的气泡 —— 那正是要避免的噪音,
 *  「没有气泡 = 没你的事」是这一屏的核心承诺。
 */
export function topTier(counts: TierCounts): Exclude<SessionTier, 'idle'> | null {
  if (counts.gate > 0) return 'gate'
  if (counts.running > 0) return 'running'
  if (counts.unread > 0) return 'unread'
  return null
}

export const TIER_LABEL: Record<Exclude<SessionTier, 'idle'>, string> = {
  gate: '等你答话',
  running: '执行中',
  unread: '未读',
}
