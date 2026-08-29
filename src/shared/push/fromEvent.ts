import type { PushTarget } from './attention'
import type { PushKind } from './message'

/**
 * 广播事件 → 「这是一件要告诉人的事吗」。
 *
 * ★★**两端共用同一份映射**。daemon 拿它决定发不发远程推送,手机拿它决定弹不弹本地通知 ——
 *  各写一套的话,某一路信号(比如工作流泳道里的 `auth`)会在一端漏掉,而症状是
 *  「有时候有提醒有时候没有」,复现要靠恰好跑到那条分支。
 *
 * ★形状照着 `botBridge.observe` 来 —— 那份已经把这四路的边角踩完了。
 */

type ChatEventLike = { workspacePath?: string; sessionId?: string | null; type?: string; id?: string }
type Run2EventLike = { workspacePath?: string; event?: { id?: string; kind?: string } }

/** 工作流泳道里「它自己定不了,等你」的那几种。 */
const LANE_KINDS = new Set(['question', 'auth', 'doubt', 'failure'])

export type PushSource = { kind: PushKind; target: PushTarget; eventId?: string }

export function pushEventFrom(channel: string, payload: unknown): PushSource | null {
  if (!payload || typeof payload !== 'object') return null

  if (channel === 'chat:event') {
    const p = payload as ChatEventLike
    const target: PushTarget = { workspacePath: p.workspacePath ?? '', sessionId: p.sessionId ?? null }
    if (!target.workspacePath) return null
    if (p.type === 'confirm-request') return { kind: 'confirm', target, eventId: p.id }
    if (p.type === 'ask-request') return { kind: 'ask', target, eventId: p.id }
    if (p.type === 'done') return { kind: 'done', target }
    return null
  }

  if (channel === 'run2:event') {
    const p = payload as Run2EventLike
    const e = p.event
    if (!e || typeof e !== 'object') return null
    // ★工作流的门挂在**工作区**上,没有会话。必须是 null 而不是 undefined ——
    //  在场判定拿它跟「你正看着哪儿」比,两边得是同一种空。
    const target: PushTarget = { workspacePath: p.workspacePath ?? '', sessionId: null }
    if (!target.workspacePath) return null
    if (e.kind === 'gate') return { kind: 'gate', target, eventId: e.id }
    if (e.kind && LANE_KINDS.has(e.kind)) return { kind: 'question', target, eventId: e.id }
    return null
  }

  return null
}
