import type { PushTarget } from './attention'

/**
 * 推送/本地通知的**文案组装**。两端共用。
 *
 * ★★**正文里绝不许出现任何对话内容。**
 *
 * 设计文档决策 7 写死了这条:推送正文是明文经过 Expo 和 APNs/FCM 的,那是三方服务器。
 * 所以这里只允许出现两样东西:**工作区名**(等于一个目录名,决策 7 明确接受)和一句
 * **按类别固定**的话。门里那句「要不要删掉 xxx」、代理回了什么,一个字都不许进来。
 *
 * 这不是「先这么写着」——`buildPush` 的签名里**根本没有**放正文的地方,想加得先改签名,
 * 改的时候就会看见这段话。
 */

export type PushKind =
  /** CLI 升起的权限门(chat:event / confirm-request) */
  | 'confirm'
  /** 代理在问你(chat:event / ask-request) */
  | 'ask'
  /** 工作流阶段门(run2:event / kind:'gate') */
  | 'gate'
  /** 工作流泳道里要你拿主意(run2:event / question|auth|doubt|failure) */
  | 'question'
  /** 一轮跑完了(chat:event / done) */
  | 'done'

/** 门这一类(需要你动手),和「跑完了」分开 —— 设置里是两个开关。 */
export const NEEDS_YOU: ReadonlySet<PushKind> = new Set<PushKind>(['confirm', 'ask', 'gate', 'question'])

export type PushEvent = {
  kind: PushKind
  target: PushTarget
  /** 工作区名。空着就只显示类别。 */
  workspaceName?: string
  /**
   * 去重用的稳定标识(门的 id / 一轮的 sessionId)。同一件事重复广播时只推一次。
   * ★不进正文,只进 `data`。
   */
  eventId?: string
}

export type PushMessage = {
  title: string
  body: string
  /** 点开之后往哪儿跳。★路径不是对话内容,但它确实也走明文 —— 见文件头。 */
  data: { wsPath: string; sessionId: string | null; kind: PushKind }
}

const LABEL: Record<PushKind, string> = {
  confirm: '需要你确认',
  ask: '代理在问你',
  gate: '工作流卡在门上',
  question: '工作流要你拿主意',
  done: '跑完了',
}

const BODY: Record<PushKind, string> = {
  confirm: '有一道权限门等你答。点开看看。',
  ask: '代理提了个问题,在等你回答。',
  gate: '一个阶段跑完了,等你放行。',
  question: '有一件事它自己定不了,在等你。',
  done: '这一轮结束了,点开看结果。',
}

/** 通知标题在两个平台上都会被截,超过这个长度自己收尾比让系统硬切好看。 */
const MAX_TITLE = 60

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + '…' : s)

export function buildPush(e: PushEvent): PushMessage {
  const name = (e.workspaceName ?? '').trim()
  const label = LABEL[e.kind]
  return {
    title: clip(name ? `${name} · ${label}` : `myFlowForge · ${label}`, MAX_TITLE),
    body: BODY[e.kind],
    data: { wsPath: e.target.workspacePath, sessionId: e.target.sessionId ?? null, kind: e.kind },
  }
}

/**
 * 去重键。
 *
 * ★同一道门在一次广播风暴里可能来好几遍(重连补数据、多个 sink),而**推送是不可撤回的** ——
 *  弹重了就是弹重了。有 `eventId` 就用它;没有的话退回「工作区+会话+类别」,
 *  这对「跑完了」正合适:同一条会话连着跑完两轮,本来也只该提醒一次最新的那次。
 */
export function pushKey(e: PushEvent): string {
  if (e.eventId) return `${e.kind}:${e.eventId}`
  return `${e.kind}:${e.target.workspacePath}:${e.target.sessionId ?? ''}`
}
