// 历史重建(spec §8.3):从事件日志还原发给模型的 Message[]
// message.user → user;message.assistant(按 step,有 parts 用 parts,否则按纯文本)→ assistant;
// 该步之后的 tool.ended → 一条 role:'tool' 消息。未配对的调用补"已中断";已回滚的轮与当前轮跳过
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
}

type Call = Extract<Part, { type: 'tool_call' }>
type Result = Extract<Part, { type: 'tool_result' }>
interface Step { parts: Part[]; results: (Result | undefined)[] }
interface Turn { user: string; ts: number; steps: Step[] }

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

export function buildMessages(events: KernelEvent[], currentTurnId: string, currentText: string, opts: BuildOpts = {}): Message[] {
  const rolledBack = new Set<string>()
  let currentTs: number | undefined
  for (const e of events) {
    const id = obj(e.payload)?.turnId
    if (e.type === 'turn.rolledBack' && str(id)) rolledBack.add(id)
    if (e.type === 'message.user' && id === currentTurnId && currentTs === undefined) currentTs = e.ts
  }
  const turns = new Map<string, Turn>()
  const order: string[] = []
  for (const e of events) {
    const p = obj(e.payload)
    const id = p?.turnId
    if (!p || !str(id) || id === currentTurnId || rolledBack.has(id)) continue
    if (e.type === 'message.user') {
      if (turns.has(id)) continue
      turns.set(id, { user: str(p.text) ? p.text : '', ts: e.ts, steps: [] })
      order.push(id)
      continue
    }
    const t = turns.get(id)
    if (!t) continue
    if (e.type === 'message.assistant') {
      const parts = stepParts(p, opts.origin)
      if (parts.length) t.steps.push({ parts, results: parts.filter(x => x.type === 'tool_call').map(() => undefined) })
    } else if (e.type === 'tool.ended' && str(p.callId)) {
      // 结果属于它之前最近的那一步里同 id、还没配上的调用
      const step = t.steps.at(-1)
      if (!step) continue
      const calls = step.parts.filter((x): x is Call => x.type === 'tool_call')
      const i = calls.findIndex((c, j) => c.id === p.callId && !step.results[j])
      if (i < 0) continue
      step.results[i] = { type: 'tool_result', callId: p.callId, content: str(p.content) ? p.content : '', ...(p.isError === true && { isError: true }) }
    }
  }

  const out: Message[] = []
  const user = (text: string, ts: number): Message => {
    const parts: Part[] = []
    if (!out.length && opts.environment) parts.push({ type: 'text', text: opts.environment })
    if (opts.reminder) parts.push({ type: 'text', text: opts.reminder(ts) })
    parts.push({ type: 'text', text })
    return { role: 'user', parts }
  }
  for (const id of order) {
    const t = turns.get(id)!
    out.push(user(t.user, t.ts))
    for (const s of t.steps) {
      out.push({ role: 'assistant', parts: s.parts })
      const calls = s.parts.filter((x): x is Call => x.type === 'tool_call')
      if (!calls.length) continue
      out.push({
        role: 'tool',
        parts: calls.map((c, j) => s.results[j] ?? { type: 'tool_result', callId: c.id, content: INTERRUPTED, isError: true }),
      })
    }
  }
  out.push(user(currentText, currentTs ?? opts.now ?? Date.now()))
  return out
}
