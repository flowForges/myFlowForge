import type { ChatMessage, PendingAction, ChatConfirm } from '@shared/types'

// tsconfig.node.json 未设 --jsx,即使是 `import type` 也会因模块解析到 .tsx 而触发 TS6142。
// 因此无法直接 import PlanCard.PlanReq,改用结构等价的本地定义;TypeScript 鸭子类型保证运行时兼容。
export interface PlanReq {
  id: string
  approach: string
  stages: { key: string; name: string; agents: number; perProject: boolean; projects: string[] }[]
  allProjects: string[]
  task?: string
  ts?: string
  workflowId?: string
  workflowName?: string
  workflowOptions?: { id: string; name: string }[]
}

export type TimelineEntry =
  | { kind: 'message'; ts: number; msg: ChatMessage; index: number }
  | { kind: 'pending'; ts: number; action: PendingAction }
  | { kind: 'confirm'; ts: number; confirm: ChatConfirm }
  | { kind: 'plan'; ts: number; plan: PlanReq }
  // 相邻两条 ai 消息 provider 不同时插入的分割线,携带 provider id(而非显示名——显示名映射复用
  // 现有 agent label 机制,在渲染处按 providers 列表解析,保持 timeline.ts 纯粹/易测)。
  | { kind: 'provider-switch'; ts: number; from: string; to: string }

// 卡片(pending/confirm/plan)排序键:缺失/不可解析 → +Infinity 排末尾;否则用毫秒时间戳。
function key(ts?: string): number {
  if (!ts) return Infinity
  const n = Date.parse(ts)
  return Number.isNaN(n) ? Infinity : n
}

// 消息排序键 —— 与卡片不同,消息在数组里已按追加顺序=时序排列,必须保持其相对次序:
//  · 空 ts('') = 尚未定时的在途流式助手消息。沿用前一条真实消息的时间键(carry-forward),使其紧随触发它的
//    用户消息之后。关键:不能用 +Infinity——否则本轮流式中途产生的卡片(plan/confirm,ts=now 为有限值)会
//    排到这条流式消息*上方*,被顶出视口(方案审批「批准/拒绝」按钮看不见的根因)。承接前值后,now 时间戳的
//    卡片自然落在流式消息之后(下方),用户在底部即可看到。
//  · 非空但不可解析(旧会话的时钟制 "09:58:01",Date.parse=NaN)= 真实历史消息,不能顶到末尾;
//    沿用前一条消息的有效时间(carry-forward),从而留在原位。开头连续的此类消息落 -Infinity(顶部)。
//  · 可解析 ISO → 毫秒值。
// 若统一按 key() 把不可解析 ts 当 +Infinity,旧会话历史会被顶到底部,而本轮带真实 ts 的回复反排到其上方、
// 滚动到底看不见("有思考没结果")。carry-forward 修复该回归。
function messageKeys(messages: ChatMessage[]): number[] {
  let last = -Infinity
  return messages.map(m => {
    if (m.ts === '') return last                   // 在途流式消息:承接前值,紧随用户消息(不推进 last)
    const n = Date.parse(m.ts)
    if (!Number.isNaN(n)) { last = n; return n }   // 真实 ISO
    return last                                    // 遗留不可解析:沿用前值,保持原位
  })
}

// 把消息与三类卡片按时间戳归并成单一时间线。Array.prototype.sort 稳定(ES2019+):相同 ts 保持
// 传入顺序(消息 → pending → confirm → plan),使同刻卡片有确定次序。
// 遍历消息,记录"上一条 ai 消息的 provider"(不限于连续,跨用户消息也保留)。当某条 ai 消息与
// 上一条 ai 消息都携带 provider 且二者不同 → 在这条消息前插入 provider-switch 分割线。
//   · 旧消息(Task 17 之前,无 provider 字段)、user 消息、以及运行时产生的无 provider ai 消息
//     (「系统」note、尚未 done 的在途流式占位)都不参与判定,只是被跳过——且【不清空】已知的
//     prevAiProvider(粘滞)。若清空,一条无 provider 的 ai 消息夹在 codex 末条与切换总结之间时,
//     总结上方本应出现的 provider-switch 分割线会消失(切模型丢分割线的根因)。粘滞不会误插:第一段
//     provider 出现前 prevAiProvider 恒为 undefined,`prevAiProvider &&` 守卫保证无 provider 的纯旧
//     会话不会补插分割线。
//   · 第一条 ai 消息(prevAiProvider 尚为 undefined)必然不插。
// 分割线与其触发消息共享同一 ts key,且在展开为 message 条目之前紧邻插入(而非整体作为独立前置
// 数组块)——若整体前置,一旦分割线 ts 恰好与*更早*的一条消息(如流式承接前值的 carry-forward ts)
// 相等,稳定排序会把它误排到那条无关消息前面。紧邻插入保证同 ts 平局时只影响它自己触发的那条消息。
function messageEntries(messages: ChatMessage[], mk: number[]): TimelineEntry[] {
  const out: TimelineEntry[] = []
  let prevAiProvider: string | undefined
  messages.forEach((msg, index) => {
    if (msg.who === 'ai' && msg.provider) {
      if (prevAiProvider && msg.provider !== prevAiProvider) {
        out.push({ kind: 'provider-switch', ts: mk[index], from: prevAiProvider, to: msg.provider })
      }
      prevAiProvider = msg.provider // 仅在真带 provider 时推进;无 provider 的 ai 消息不清空(粘滞)
    }
    out.push({ kind: 'message', ts: mk[index], msg, index })
  })
  return out
}

export function buildTimeline(
  messages: ChatMessage[],
  pending: PendingAction[],
  confirms: ChatConfirm[],
  plans: PlanReq[],
): TimelineEntry[] {
  const mk = messageKeys(messages)
  const entries: TimelineEntry[] = [
    ...messageEntries(messages, mk),
    ...pending.map((action): TimelineEntry => ({ kind: 'pending', ts: key(action.ts), action })),
    ...confirms.map((confirm): TimelineEntry => ({ kind: 'confirm', ts: key(confirm.ts), confirm })),
    ...plans.map((plan): TimelineEntry => ({ kind: 'plan', ts: key(plan.ts), plan })),
  ]
  return entries.sort((a, b) => a.ts - b.ts)
}
