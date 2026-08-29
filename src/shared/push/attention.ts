/**
 * 在场判定 —— 「这台设备现在到底有没有在看这件事」。
 *
 * 三档策略来自 paseo 的 `agent-attention-policy.ts`(设计文档第二节那张表)。
 * ★**只借鉴公开文档描述的策略,一行代码都没抄** —— paseo 是 AGPLv3,本项目是 MIT,
 *  它的实现进了这个仓库就要整个改成 AGPL(设计文档「许可证红线」)。
 *
 * ★为什么放在 `src/shared`:daemon 侧按每台设备**上报**的在场状态算「要不要发远程推送」,
 *  手机侧拿自己的状态算「要不要弹一条本地通知」。两边算的是同一件事,判据必须是同一份 ——
 *  各写一套的结果一定是某种组合下要么静默、要么弹两条,而这类问题在真机上极难复现。
 */

/** 一件事发生在哪儿。`sessionId` 为空 = 工作区级(工作流的门就没有会话)。 */
export type PushTarget = { workspacePath: string; sessionId?: string | null }

/** 一台设备最近一次上报的在场状态。 */
export type Presence = {
  /** app 在前台可见吗 */
  visible: boolean
  /** 它正看着哪儿。没停在任何工作区上就是 null。 */
  at: PushTarget | null
  /** 上报时刻(epoch ms) */
  reportedAt: number
}

/**
 * 多久没上报就当人已经不在了。
 *
 * ★这个超时**不是**保守心理作用,它是必需的:手机被系统挂起时 socket 直接断,
 *  没有任何机会发一条「我走了」。不设超时的话,最后那条 `visible:true` 会永远压着推送 ——
 *  症状是「手机放兜里,门卡了一夜,一条推送都没有」。
 */
export const ATTENTION_WINDOW_MS = 180_000

export type Attention =
  /** 就在看这件事本身 → 什么都不做。再弹一下是纯噪音。 */
  | 'attending'
  /** app 开着,但在看别的 → 应用内提醒(手机上就是一条本地通知横幅)。 */
  | 'inapp'
  /** 不在 → 远程推送。 */
  | 'away'

const sameTarget = (a: PushTarget, b: PushTarget): boolean =>
  a.workspacePath === b.workspacePath && (a.sessionId ?? null) === (b.sessionId ?? null)

/**
 * ★`away` 是**兜底档**:presence 缺失、过期、或者 app 不可见,全都算不在。
 *
 * 「不可见就算 away」是有意的,而不是把它当成中间档:app 在后台时应用内提醒**看不见**,
 * 那一档在手机上根本不成立。而这条同时把「本地通知」和「远程推送」切得干干净净 ——
 * 手机只在 `inapp`(它自己看得见的时候)弹本地通知,daemon 只在 `away` 发远程推送,
 * 两者不可能同时成立,所以**不会出现同一件事弹两条**。
 */
export function attentionOf(p: Presence | null | undefined, target: PushTarget, now: number): Attention {
  if (!p) return 'away'
  if (now - p.reportedAt > ATTENTION_WINDOW_MS) return 'away'
  if (!p.visible) return 'away'
  if (p.at && sameTarget(p.at, target)) return 'attending'
  return 'inapp'
}
