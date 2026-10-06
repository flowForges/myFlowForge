import type { TapTarget } from './tapTarget'

/**
 * 「点了这条通知,该去哪一屏」。**零运行时 import**(只有 type),好让 mobile 那套 node 环境的 vitest 收进去。
 *
 * ★★为什么单拎出来(2026-10-06 iOS 崩溃):点通知无限跳转期间 app 崩了。循环是主因(notify.ts 的重播
 *  去重 + PushProvider 的稳定订阅已修),**放大器是 `router.push`** —— 它每次都新压一屏,十几屏聊天
 *  同时活着,每屏都挂着自己的订阅和消息列表,内存就爆了。用户亲手点按钮下钻(chat → 工作流/变更)
 *  用 push 没问题,一次点一屏;通知不一样 —— 它会在任何一屏、任何时候到达,同一个目的地可能来好几次。
 *  PushProvider 现在只负责执行这里给出的决定,而执行一律用 navigate(同一屏复用,不叠)。
 */
export type TapNav =
  | { select: { wsPath: string; sessionId: string }; route: 'chat' | 'exec' }
  | { route: 'home' }

type GroupLike = { ws: { path: string }; sessions: { id: string }[] }

export function tapNav(t: TapTarget, groups: readonly GroupLike[]): TapNav {
  // 通知点名了会话:照去。★不校验它在不在本地列表里 —— 通知可能比本地列表新,挡掉就是「点了没反应」。
  if (t.sessionId) return { select: { wsPath: t.wsPath, sessionId: t.sessionId }, route: 'chat' }
  // 工作区级(工作流的门)。`/exec` 吃的是 `selected`,得先给它选一条会话;选不出来就回列表,别推一屏空的。
  const first = groups.find((g) => g.ws.path === t.wsPath)?.sessions[0]
  if (first) return { select: { wsPath: t.wsPath, sessionId: first.id }, route: 'exec' }
  return { route: 'home' }
}
