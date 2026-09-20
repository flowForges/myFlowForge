import { attentionOf, type Presence, type PushTarget } from '../../../src/shared/push/attention'
import { buildPush, NEEDS_YOU, type PushMessage } from '../../../src/shared/push/message'
import { pushEventFrom } from '../../../src/shared/push/fromEvent'

/**
 * 手机这一侧的「要不要自己弹一条本地通知」。
 *
 * ★★分工:app 开着但**没在看那件事**时,由手机自己弹(`inapp`);
 *  app 被切走 / 被系统挂起时,由那台机器发远程推送(`away`)。
 *  两档互斥,所以同一件事不会弹两条 —— 判据(`attentionOf`)和事件映射(`pushEventFrom`)
 *  都是**和 daemon 共用的同一份**。
 *
 * ★为什么 app 开着还要弹:手机屏幕就这么大,你在 A 会话里打字的时候 B 会话升起了一道门 ——
 *  它在别的屏上,你根本看不见。这正是「门卡了一夜」的手机版。
 */

export type LocalPushPrefs = {
  /** 手机上的总开关。跟设备走,和那台机器上的推送开关是两回事。 */
  enabled: boolean
  gate: boolean
  done: boolean
}

export const DEFAULT_LOCAL_PUSH: LocalPushPrefs = { enabled: true, gate: true, done: false }

export function parseLocalPushPrefs(v: unknown): LocalPushPrefs {
  const o = (v ?? {}) as Record<string, unknown>
  const b = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d)
  return {
    enabled: b(o.enabled, DEFAULT_LOCAL_PUSH.enabled),
    gate: b(o.gate, DEFAULT_LOCAL_PUSH.gate),
    done: b(o.done, DEFAULT_LOCAL_PUSH.done),
  }
}

export type DecideDeps = {
  presence: Presence | null
  prefs: LocalPushPrefs
  workspaceName: (path: string) => string
  now: number
}

/** 一条广播事件 → 要不要弹、弹什么。不弹就是 null。 */
export function localNotificationFor(channel: string, payload: unknown, d: DecideDeps): PushMessage | null {
  if (!d.prefs.enabled) return null
  const src = pushEventFrom(channel, payload)
  if (!src) return null
  if (NEEDS_YOU.has(src.kind) ? !d.prefs.gate : !d.prefs.done) return null
  if (attentionOf(d.presence, src.target, d.now) !== 'inapp') return null
  return buildPush({ ...src, workspaceName: d.workspaceName(src.target.workspacePath) })
}

/**
 * 在场上报要不要发出去。
 *
 * ★不加节流的话,每切一次会话、每次 app 回到前台都是一次网络往返 —— 而它在**每条连接**上
 *  都会发生。状态没变就别发;真变了立刻发(延迟上报等于让那台机器在一段时间里以为你还在看)。
 *
 * ★心跳:状态没变也要定期发一次。那台机器上的在场判定有 180 秒的过期窗口,
 *  不续期的话你盯着同一条会话看三分钟之后就会被当成「不在」,然后被推一条。
 */
export const PRESENCE_HEARTBEAT_MS = 60_000

const sameAt = (a: PushTarget | null, b: PushTarget | null): boolean => {
  if (!a || !b) return a === b
  return a.workspacePath === b.workspacePath && (a.sessionId ?? null) === (b.sessionId ?? null)
}

export function shouldReportPresence(last: Presence | null, next: Presence): boolean {
  if (!last) return true
  if (last.visible !== next.visible) return true
  if (!sameAt(last.at, next.at)) return true
  return next.reportedAt - last.reportedAt >= PRESENCE_HEARTBEAT_MS
}
