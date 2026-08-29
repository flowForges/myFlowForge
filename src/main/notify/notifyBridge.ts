import { shouldNotify, buildNotification, type NotifyCfg, type NotifyType, type BuiltNotification } from './notifier'

/**
 * 「有一道门等着你」→ 系统通知。
 *
 * ★★2026-08-30 重写。老版本监听的是 `pending:add`,而那是**已经删掉的 orchestrator**
 *  的事件(见 `session-2026-07-21-delete-orchestrator`)—— 于是整个模块从来没有被 `index.ts`
 *  接上过,全仓库零引用。**结果是设置里那两个开关(需要确认 / 需要输入)一直摆在那儿,
 *  而门升起来时从来没弹过一条通知**。桌面端实际只有「跑完了」会弹(index.ts 的 notifyChatDone)。
 *
 * 现在改成看**活着的**那四路信号,和 `botBridge.observe` / `pushBridge.observe` 完全同一批:
 *   `chat:event`  → confirm-request(权限门)/ ask-request(代理提问)
 *   `run2:event`  → kind:'gate'(阶段门)/ question|auth|doubt|failure(泳道要你拿主意)
 *
 * ★这里**不管 done** —— 那条在 `index.ts` 里已经有人接了(notifyChatDone),
 *  两边都接就会每次回复弹两条。
 *
 * ★★和推送的区别:系统通知是**本机**弹的,正文不经过任何第三方,所以它可以带门里那句话;
 *  推送的正文要过 Expo/APNs,一个字的对话内容都不许带(决策 7)。别把两边的文案合并成一份。
 */

export interface GateNotifierDeps {
  getCfg: () => NotifyCfg
  isFocused: () => boolean
  notify: (n: BuiltNotification) => void
  /** 路径 → 工作区名。拿不到就只显示类别。 */
  workspaceName: (path: string) => string
}

type ChatEventLike = {
  workspacePath?: string
  sessionId?: string | null
  type?: string
  id?: string
  title?: string
  where?: string
  agentName?: string
}
type Run2EventLike = {
  workspacePath?: string
  event?: { id?: string; kind?: string; stageName?: string; stageKey?: string; body?: string; title?: string; note?: string; error?: string }
}

const LANE_KINDS = new Set(['question', 'auth', 'doubt', 'failure'])

/** 去重表的上限。门 id 是唯一的,不设上限的话它跟着运行时长单调增长。 */
const SEEN_MAX = 500

export function createGateNotifier(deps: GateNotifierDeps): (channel: string, payload: unknown) => void {
  const seen = new Set<string>()

  const remember = (id: string): boolean => {
    if (!id) return true                 // 没有 id 的事件不去重,宁可多弹一次也别整类漏掉
    if (seen.has(id)) return false
    seen.add(id)
    if (seen.size > SEEN_MAX) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    return true
  }

  const fire = (type: NotifyType, workspacePath: string, text: string, sessionId?: string) => {
    if (!workspacePath) return
    if (!shouldNotify(type, deps.getCfg(), deps.isFocused())) return
    deps.notify(buildNotification({ type, workspaceName: deps.workspaceName(workspacePath), workspacePath, text, sessionId }))
  }

  return function observe(channel: string, payload: unknown) {
    // 一条畸形 payload 绝不能把广播总线带崩 —— 整个界面的事件流挂在上面。
    try {
      if (channel === 'chat:event') {
        const p = (payload ?? {}) as ChatEventLike
        const ws = p.workspacePath ?? ''
        const sid = p.sessionId ?? undefined
        if (p.type === 'confirm-request') {
          if (!remember(p.id ?? '')) return
          const text = p.where ? `${p.title ?? ''} — ${p.where}` : (p.title ?? '')
          fire('confirm', ws, text, sid)
        } else if (p.type === 'ask-request') {
          if (!remember(p.id ?? '')) return
          fire('input', ws, p.title ?? '', sid)
        } else if (p.type === 'confirm-resolved' || p.type === 'ask-resolved') {
          if (p.id) seen.delete(p.id)
        }
      } else if (channel === 'run2:event') {
        const p = (payload ?? {}) as Run2EventLike
        const e = p.event
        if (!e) return
        const ws = p.workspacePath ?? ''
        if (e.kind === 'gate') {
          if (!remember(e.id ?? '')) return
          // 工作流的门是「这一段跑完了,放不放行」—— 归“需要确认”那一档。
          fire('confirm', ws, e.stageName ? `${e.stageName}:等你放行` : '工作流等你放行')
        } else if (e.kind && LANE_KINDS.has(e.kind)) {
          if (!remember(e.id ?? '')) return
          fire('input', ws, e.title ?? e.note ?? e.error ?? '工作流要你拿主意')
        }
      }
    } catch { /* 坏 payload 只丢这一条 */ }
  }
}
