import type { AskQuestion } from '@shared/types'
import type { ConfirmDecision } from '../agents/types'

/**
 * 权限门总线 —— 这个 app 里**所有**「要不要放这条操作过去」都从这里过。
 *
 * ★★★为什么有这个文件:用户 2026-09-18 第 **5** 次报「某条路径上的门没接上,界面一直卡在运行中」。
 *  前四次都是「哪漏补哪」,第五次普查才看清:门在这个项目里有 **5 份各自为政的抄本、3 条广播频道、
 *  2 个方向相反的缺省值**(委派缺省 deny、工作流泳道缺省 allow)。漏不是手误,是结构 ——
 *    · `AgentCallbacks.onConfirm` 是必填字段,但「填了个桩」和「真接到 UI」**类型上完全分不开**:
 *      `async () => 'deny'` 和真回调一样合法编译,编译器永远不会告诉你哪条路径的门是断的;
 *    · 新增一条执行路径要同时想起五件事(起 resolver、定事件、加渲染组件、去 notifyBridge 加 case、
 *      去 push/fromEvent 加 case),而**最后两步没有任何东西会提醒你** —— 它们恰恰决定了
 *      「用户在别处能不能知道有门在等」。
 *
 * 所以这一层的职责只有三件,但每一件都是全局唯一的:
 *   ① 谁在等 —— `list()` 是「还挂着的门」的单一事实源,任何界面都能重建(建区那条以前**没有**快照,
 *      模态框一关门就永远没人能答了,而主进程那边的 Promise 不超时、不兜底);
 *   ② 怎么让人知道 —— `subscribe()` 一条出口喂通知/推送/机器人,不再每条路径各接一遍;
 *   ③ policy 显式化 —— 不需要人答的路径(委派、蒸馏)也必须**在这里登记一次**再自动决定,
 *      而不是在调用点写一个看不见的 `async () => 'deny'`。
 *
 * ★这里没有 electron、没有 IPC、没有 UI:它只管「谁在等、等什么、谁答了」。广播和渲染在外面接。
 */

/** 门是从哪条执行路径升起来的。★新增一条路径 = 这里加一个值,而加了值就会被覆盖率守卫盯上。 */
export type GateOrigin = 'chat' | 'run2' | 'setup' | 'delegate' | 'oneshot'

export interface GateReq {
  title: string
  where?: string
  questions?: AskQuestion[]
  toolUseId?: string
  toolName?: string
  agentId?: string
  readOnly?: boolean
  /** 被权限档自动放行时,把痕迹记在那次调用自己的工具卡上(而不是往对话流里插消息)。 */
  onAutoAllow?: () => void
}

export interface GateCtx {
  origin: GateOrigin
  workspacePath: string
  sessionId?: string
  /** 给人看的来源名:「建区 Hook · 安装 skill」「工作流 · 评估」。通知和快照里用它说清是谁在等。 */
  label?: string
  /**
   * 这道门刚登记好时叫一声,带上它的 id。
   * ★给**还需要往自己那条旧频道上发一份**的调用方用(建区 Hook 要发 `hook:interact`,
   *  好让建区模态框继续显示那张卡)。id 必须是总线发的那一个 —— 两边各生成一个 id 的话,
   *  用户在模态框上答的就是另一道门,而真正挂着的那道永远没人答。
   */
  onRaised?: (gate: PendingGate) => void
}

export interface PendingGate {
  id: string
  origin: GateOrigin
  workspacePath: string
  sessionId?: string
  label?: string
  title: string
  where?: string
  questions?: AskQuestion[]
  /** ISO 时间。★用来回答「它等了多久」—— 一道等了十分钟的门和刚升起来的门不是一回事。 */
  raisedAt: string
}

export type GateChange =
  | { type: 'raised'; gate: PendingGate }
  | { type: 'resolved'; id: string; origin: GateOrigin; workspacePath: string; sessionId?: string; decision: ConfirmDecision }

/**
 * 不需要人答的路径,在这里**显式**声明自己的自动决定。
 *
 * ★★这不是为了省事,是为了把「这条路没有门」从一句藏在调用点的字面量,变成一个**列得出来**的事实:
 *  委派子代理一直是 `async () => 'deny'`(硬编码),工作流泳道的缺省是 `'allow'` —— 两个方向相反,
 *  而没有任何一个地方能同时看见这两件事。现在它们都在这张表里。
 */
export const AUTO_POLICY: Record<'delegate' | 'oneshot', { decision: ConfirmDecision; why: string }> = {
  // 委派出去的子代理跑在后台,没人守着;放行等于让一个没人看的进程做不可逆的事。
  delegate: { decision: 'deny', why: '委派的子代理在后台跑,没有人在门前 —— 不放行' },
  // 内部一次性调用(记忆蒸馏 / 运行总结 / 门回答):它们只该读给定的上下文然后吐一段文字,
  // 不该有任何工具调用。真要了权限,说明它在做别的事 —— 拒掉,并且**留下记录**。
  // ★这三处以前**一个都没传 onConfirm**,靠 provider 自己 fail-closed 静默拒 —— 一行痕迹都没有。
  //  它们是第 5 次普查都没数到的第 7、8 条路径,是覆盖率守卫在这次迁移里当场抓出来的。
  oneshot: { decision: 'deny', why: '一次性内部调用不该调用工具' },
}

export interface GateRegistry {
  /** 升一道门,等人答。★这是**唯一**产生 onConfirm 的地方。 */
  raise(ctx: GateCtx, req: GateReq): Promise<ConfirmDecision>
  /** 造一个能直接塞进 `AgentCallbacks.onConfirm` 的回调。 */
  confirmFor(ctx: GateCtx): (req: GateReq) => Promise<ConfirmDecision>
  /** 不需要人答的路径:登记 + 按 AUTO_POLICY 立刻决定。★仍然走一遍总线,所以它在日志里看得见。 */
  autoDecide(ctx: GateCtx & { origin: 'delegate' | 'oneshot' }, req: GateReq): Promise<ConfirmDecision>
  /** 有人答了。答不上(id 不在)返回 false —— 重复回答、过期回答都走这条。 */
  resolve(id: string, decision: ConfirmDecision): boolean
  /** 还挂着的门。★界面重建全靠它 —— 建区那条以前没有这个,模态框一关门就没人能答了。 */
  list(filter?: { workspacePath?: string; origin?: GateOrigin; sessionId?: string }): PendingGate[]
  /** 批量收尾(一轮结束 / 会话没了 / 建区被取消)。返回被收掉的条数。 */
  drain(pred: (g: PendingGate) => boolean, decision: ConfirmDecision): number
  /** 变更流:通知、推送、机器人桥、渲染层广播都从这一条出口接。 */
  subscribe(fn: (c: GateChange) => void): () => void
}

export function createGateRegistry(now: () => Date = () => new Date()): GateRegistry {
  const pending = new Map<string, { gate: PendingGate; resolve: (d: ConfirmDecision) => void; req: GateReq }>()
  const subs = new Set<(c: GateChange) => void>()
  let seq = 0

  const emit = (c: GateChange) => {
    // ★一个订阅者抛异常绝不能影响别人,更不能把升门这件事带崩 —— 门挂了就是界面卡住。
    for (const fn of subs) { try { fn(c) } catch { /* 订阅者自己的事 */ } }
  }

  const register = (ctx: GateCtx, req: GateReq): { id: string; gate: PendingGate } => {
    const id = `g-${ctx.origin}-${Date.now()}-${++seq}`
    const gate: PendingGate = {
      id,
      origin: ctx.origin,
      workspacePath: ctx.workspacePath,
      sessionId: ctx.sessionId,
      label: ctx.label,
      title: req.title,
      where: req.where,
      questions: req.questions,
      raisedAt: now().toISOString(),
    }
    return { id, gate }
  }

  const registry: GateRegistry = {
    raise(ctx, req) {
      const { id, gate } = register(ctx, req)
      return new Promise<ConfirmDecision>((res) => {
        pending.set(id, { gate, resolve: res, req })
        emit({ type: 'raised', gate })
        // ★放在 emit 之后:订阅者(广播/通知)先知道,调用方那条旧频道后知道。
        //  反过来的话,界面可能在总线还没登记时就收到卡片,答回来会落空。
        try { ctx.onRaised?.(gate) } catch { /* 调用方自己的事,不能带崩升门 */ }
      })
    },

    confirmFor(ctx) {
      return (req: GateReq) => registry.raise(ctx, req)
    },

    autoDecide(ctx, req) {
      const policy = AUTO_POLICY[ctx.origin]
      const { gate } = register(ctx, req)
      // ★先 raised 再 resolved:这样订阅者(日志/审计)看到的是**一次完整的门**,
      //  而不是凭空冒出来的一条决定 —— 「这条路没有门」应该是能被数出来的,不是隐形的。
      emit({ type: 'raised', gate })
      emit({ type: 'resolved', id: gate.id, origin: gate.origin, workspacePath: gate.workspacePath, sessionId: gate.sessionId, decision: policy.decision })
      return Promise.resolve(policy.decision)
    },

    resolve(id, decision) {
      const p = pending.get(id)
      if (!p) return false
      pending.delete(id)
      p.resolve(decision)
      emit({ type: 'resolved', id, origin: p.gate.origin, workspacePath: p.gate.workspacePath, sessionId: p.gate.sessionId, decision })
      return true
    },

    list(filter) {
      const out: PendingGate[] = []
      for (const { gate } of pending.values()) {
        if (filter?.workspacePath && gate.workspacePath !== filter.workspacePath) continue
        if (filter?.origin && gate.origin !== filter.origin) continue
        if (filter?.sessionId && gate.sessionId !== filter.sessionId) continue
        out.push(gate)
      }
      return out
    },

    drain(pred, decision) {
      // ★先收集再回答:resolve 会改 pending,边遍历边删是本仓库栽过的那类问题。
      const hit = [...pending.values()].filter((p) => pred(p.gate)).map((p) => p.gate.id)
      let n = 0
      for (const id of hit) if (registry.resolve(id, decision)) n++
      return n
    },

    subscribe(fn) {
      subs.add(fn)
      return () => { subs.delete(fn) }
    },
  }
  return registry
}

/**
 * 进程内唯一的那一个。
 * ★单例是故意的:门的价值在于「**所有**在等的东西都在一张表里」,每条路径建一个自己的 registry
 *  就是把今天这个问题原样换个名字再来一遍。
 */
export const gateRegistry = createGateRegistry()
