import type { ChatSession } from '@shared/types'

/**
 * 侧栏用的「每个工作区 → 会话列表」映射:以多工作区缓存(useSessionsMulti)为底,叠上当前工作区的实时列表
 * (useSessions),让当前工作区的增删改名即时反映,不用等广播回来。
 *
 * ★关键:实时列表为空时**不覆盖**缓存。useSessions 在切换工作区期间会短暂返回空(它宁可空也不显示上一个
 * 工作区的数据,见 useSessions.ts 的说明)。那一帧若让空数组盖掉已经缓存好的该工作区会话,侧栏里这一整段
 * 会话行会消失再出现 —— 既是肉眼可见的高度抖动,也让重新插入的 DOM 跳过 CSS 过渡(选中动效直接看不到)。
 * 缓存本身由同一条 onSessionsChanged 广播保持新鲜,所以这一帧用缓存不会显示过期数据。
 */
export function mergeActiveSessions(
  cached: Record<string, ChatSession[]>,
  activeWsId: string | undefined,
  live: ChatSession[],
): Record<string, ChatSession[]> {
  if (!activeWsId || live.length === 0) return cached
  return { ...cached, [activeWsId]: live }
}
