// 历史重建(spec §8.3):从事件日志还原发给模型的 Message[]
// message.user → user;message.assistant(按 step,有 parts 用 parts,否则按纯文本)→ assistant;
// 该步之后的 tool.ended → 一条 role:'tool' 消息。未配对的调用补"已中断";已回滚的轮与当前轮跳过。
// executor.notice、followUp 的 message.user → 同一轮里按 seq 排的 user 消息(本轮的循环用同样的构造,逐字节相同)
// memory.injected(06 §7):会话块进第一条,轮块进它那一轮的开场消息。只读事件,不读文件
// context.rebuilt(06 §12):第一条 + 检查点 + 盖不住的部分。字节只由事件和标记决定,事件一条不删
import { activeRebuild, clipOpening, isCovered } from '../../lib/memory/checkpoint'
import { blocksOf } from '../../lib/memory/inject'
import { checkpointBlock } from '../../lib/memory/wrap'
import type { Message, Part } from '../../lib/models/types'
import type { KernelEvent } from '../../protocol/index'

export const INTERRUPTED = '已中断'

/** 推理 replay 的来源:只有同一账号 / 协议 / 模型产出的 replay 才能原样回传 */
export interface ReplayOrigin {
  accountId?: string
  protocol?: string
  modelId?: string
}

export interface BuildOpts {
  /** 当前请求的模型;缺省 = 不回传任何 replay */
  origin?: ReplayOrigin
  /** 会话的 <environment> 块:放在第一条用户消息最前 */
  environment?: string
  /** 每条用户消息前的提醒(按那条 message.user 的时间) */
  reminder?(ts: number): string
  /** 当前轮的 message.user 不在 events 里时用的时间 */
  now?: number
  /** 当前轮也按事件还原,currentText 不再追加(日志里没有这一轮时才用它) */
  includeCurrent?: boolean
  /** 按这个检查点算,不看日志里的标记:判断一个候选值不值得切换 */
  rebuild?: { throughSeq: number; text: string }
}

type Call = Extract<Part, { type: 'tool_call' }>
type Result = Extract<Part, { type: 'tool_result' }>
interface AssistantStep { kind: 'assistant'; parts: Part[]; results: (Result | undefined)[] }
type Step = AssistantStep | { kind: 'notice'; text: string } | { kind: 'followUp'; text: string; ts: number }
interface Turn { user: string; ts: number; firstSeq: number; steps: Step[] }

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined)
const str = (v: unknown): v is string => typeof v === 'string'

const sameOrigin = (p: Record<string, unknown>, o: ReplayOrigin | undefined) =>
  !!o && p.accountId === o.accountId && p.protocol === o.protocol && p.modelId === o.modelId

/** message.assistant.parts 里只认文本 / 推理 / 工具调用;形状不对的丢掉;来源不同的 replay 丢掉 */
function partOf(raw: unknown, origin: ReplayOrigin | undefined): Part | undefined {
  const p = obj(raw)
  if (!p) return undefined
  if (p.type === 'text' && str(p.text)) return p.text ? { type: 'text', text: p.text } : undefined
  if (p.type === 'tool_call' && str(p.id) && str(p.name) && str(p.args)) return { type: 'tool_call', id: p.id, name: p.name, args: p.args }
  if (p.type === 'reasoning' && p.replay !== undefined && sameOrigin(p, origin)) return { type: 'reasoning', replay: p.replay }
  return undefined
}

function stepParts(payload: Record<string, unknown>, origin: ReplayOrigin | undefined): Part[] {
  const parts = Array.isArray(payload.parts)
    ? payload.parts.map(x => partOf(x, origin)).filter((p): p is Part => p !== undefined)
    : str(payload.text) && payload.text ? [{ type: 'text' as const, text: payload.text }] : []
  // 只有推理、没有文本和调用的步(length 截断等):单独一条推理在 Responses 上会被拒,整步不进历史
  return parts.some(p => p.type === 'text' || p.type === 'tool_call') ? parts : []
}

function userMessage(text: string, ts: number, opts: BuildOpts, first: boolean, memory: { session?: string; turn?: string } = {}): Message {
  const parts: Part[] = []
  if (first && opts.environment) parts.push({ type: 'text', text: opts.environment })
  if (first && memory.session) parts.push({ type: 'text', text: memory.session })
  if (opts.reminder) parts.push({ type: 'text', text: opts.reminder(ts) })
  if (memory.turn) parts.push({ type: 'text', text: memory.turn })
  parts.push({ type: 'text', text })
  return { role: 'user', parts }
}

/** 运行的完成通知:一条 user 消息,没有提醒,也没有环境块 */
export const noticeMessage = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] })

/** 挂起时收下的后续消息:带它自己时间的提醒;不是第一条,没有环境块,也不带记忆块 */
export const followUpMessage = (text: string, ts: number, opts: BuildOpts): Message => userMessage(text, ts, opts, false)

function lastAssistant(steps: Step[]): AssistantStep | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]
    if (s.kind === 'assistant') return s
  }
  return undefined
}

/** 消息,和当前轮开场消息的下标 */
export interface RebuiltHistory {
  messages: Message[]
  opening: number
}

export function rebuildHistory(events: KernelEvent[], currentTurnId: string, currentText: string, opts: BuildOpts = {}): RebuiltHistory {
  const rolledBack = new Set<string>()
  let currentTs: number | undefined
  for (const e of events) {
    const id = obj(e.payload)?.turnId
    if (e.type === 'turn.rolledBack' && str(id)) rolledBack.add(id)
    if (e.type === 'message.user' && id === currentTurnId && currentTs === undefined) currentTs = e.ts
  }
  const rebuild = opts.rebuild ?? activeRebuild(events)
  // throughSeq 及之前的步和后续消息不进:工具结果跟着它的步走,配对不会断在边界上
  const through = rebuild?.throughSeq ?? -Infinity
  // 推理的签名绑定它产生时的前缀:留在尾部、产生于换前缀之前的 replay,Anthropic 会整个请求 400(被回滚作废的标记也换过前缀)。文本和调用留着
  const replayFrom = opts.rebuild ? Infinity : events.reduce((seq, e) => (e.type === 'context.rebuilt' ? e.seq : seq), -Infinity)
  const turns = new Map<string, Turn>()
  const order: string[] = []
  for (const e of events) {
    const p = obj(e.payload)
    const id = p?.turnId
    if (!p || !str(id) || (id === currentTurnId && !opts.includeCurrent) || rolledBack.has(id)) continue
    if (e.type === 'message.user') {
      const open = turns.get(id)
      if (open) {
        if (p.followUp === true && e.seq > through) open.steps.push({ kind: 'followUp', text: str(p.text) ? p.text : '', ts: e.ts })
        continue
      }
      turns.set(id, { user: str(p.text) ? p.text : '', ts: e.ts, firstSeq: e.seq, steps: [] })
      order.push(id)
      continue
    }
    if (e.seq <= through) continue
    const t = turns.get(id)
    if (!t) continue
    if (e.type === 'message.assistant') {
      const parts = stepParts(p, e.seq < replayFrom ? undefined : opts.origin)
      if (parts.length) t.steps.push({ kind: 'assistant', parts, results: parts.filter(x => x.type === 'tool_call').map(() => undefined) })
    } else if (e.type === 'executor.notice') {
      if (str(p.text)) t.steps.push({ kind: 'notice', text: p.text })
    } else if (e.type === 'tool.ended' && str(p.callId)) {
      // 结果属于它之前最近的助手步里同 id、还没配上的调用;中间隔着的通知和后续消息不算步
      const step = lastAssistant(t.steps)
      if (!step) continue
      const calls = step.parts.filter((x): x is Call => x.type === 'tool_call')
      const i = calls.findIndex((c, j) => c.id === p.callId && !step.results[j])
      if (i < 0) continue
      step.results[i] = { type: 'tool_result', callId: p.callId, content: str(p.content) ? p.content : '', ...(p.isError === true && { isError: true }) }
    }
  }

  // 第一轮都没盖住 = 这个检查点只总结了回滚掉的内容:没有东西要换
  const firstTurn = order.length ? turns.get(order[0]) : undefined
  const checkpoint = rebuild && firstTurn && isCovered(firstTurn.firstSeq, rebuild.throughSeq) ? rebuild : undefined
  const blocks = blocksOf(events)
  const out: Message[] = []
  let opening = -1
  const user = (text: string, ts: number, turnId?: string): Message =>
    userMessage(text, ts, opts, !out.length, { session: blocks.session, turn: turnId === undefined ? undefined : blocks.turns.get(turnId) })
  for (const id of order) {
    const t = turns.get(id)!
    if (id === currentTurnId) opening = out.length
    if (checkpoint && !out.length) {
      // 第一条总在;它的轮块不带,要是更新块,lastSeen 看不见了就会补发
      out.push(userMessage(clipOpening(t.user), t.ts, opts, true, { session: blocks.session }))
      out.push(noticeMessage(checkpointBlock(checkpoint.throughSeq, checkpoint.text)))
    } else if (checkpoint && isCovered(t.firstSeq, checkpoint.throughSeq)) {
      // 落在中间的那一轮:手上的任务不能只剩摘要。整轮都盖住了就没有它的事,除非它正是当前轮
      if (!t.steps.length && id !== currentTurnId) continue
      out.push(userMessage(clipOpening(t.user), t.ts, opts, false))
    } else {
      out.push(user(t.user, t.ts, id))
    }
    for (const s of t.steps) {
      if (s.kind === 'notice') {
        out.push(noticeMessage(s.text))
        continue
      }
      if (s.kind === 'followUp') {
        out.push(user(s.text, s.ts))
        continue
      }
      out.push({ role: 'assistant', parts: s.parts })
      const calls = s.parts.filter((x): x is Call => x.type === 'tool_call')
      if (!calls.length) continue
      out.push({
        role: 'tool',
        parts: calls.map((c, j) => s.results[j] ?? { type: 'tool_result', callId: c.id, content: INTERRUPTED, isError: true }),
      })
    }
  }
  if (opening < 0) {
    opening = out.length
    out.push(user(currentText, currentTs ?? opts.now ?? Date.now(), currentTurnId))
  }
  return { messages: out, opening }
}

export function buildMessages(events: KernelEvent[], currentTurnId: string, currentText: string, opts: BuildOpts = {}): Message[] {
  return rebuildHistory(events, currentTurnId, currentText, opts).messages
}
