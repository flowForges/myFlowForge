// 历史重建(spec §8.3):从事件日志还原发给模型的 Message[]
// message.user → user;message.assistant(按 step,有 parts 用 parts,否则按纯文本)→ assistant;
// 该步之后的 tool.ended → 一条 role:'tool' 消息。未配对的调用补"已中断";已回滚的轮与当前轮跳过
import type { Message, Part } from '../../lib/models/types'
import type { KernelEvent } from '../../protocol/index'

export const INTERRUPTED = '已中断'

type Call = Extract<Part, { type: 'tool_call' }>
type Result = Extract<Part, { type: 'tool_result' }>
interface Step { parts: Part[]; results: (Result | undefined)[] }
interface Turn { user: string; steps: Step[] }

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined)
const str = (v: unknown): v is string => typeof v === 'string'

/** message.assistant.parts 里只认文本 / 推理 / 工具调用;形状不对的丢掉 */
function partOf(raw: unknown): Part | undefined {
  const p = obj(raw)
  if (!p) return undefined
  if (p.type === 'text' && str(p.text)) return p.text ? { type: 'text', text: p.text } : undefined
  if (p.type === 'tool_call' && str(p.id) && str(p.name) && str(p.args)) return { type: 'tool_call', id: p.id, name: p.name, args: p.args }
  if (p.type === 'reasoning' && (str(p.text) || p.replay !== undefined)) {
    return { type: 'reasoning', ...(str(p.text) && { text: p.text }), ...(p.replay !== undefined && { replay: p.replay }) }
  }
  return undefined
}

function stepParts(payload: Record<string, unknown>): Part[] {
  if (Array.isArray(payload.parts)) return payload.parts.map(partOf).filter((p): p is Part => p !== undefined)
  return str(payload.text) && payload.text ? [{ type: 'text', text: payload.text }] : []
}

export function buildMessages(events: KernelEvent[], currentTurnId: string, currentText: string): Message[] {
  const rolledBack = new Set<string>()
  for (const e of events) {
    const id = obj(e.payload)?.turnId
    if (e.type === 'turn.rolledBack' && str(id)) rolledBack.add(id)
  }
  const turns = new Map<string, Turn>()
  const order: string[] = []
  for (const e of events) {
    const p = obj(e.payload)
    const id = p?.turnId
    if (!p || !str(id) || id === currentTurnId || rolledBack.has(id)) continue
    if (e.type === 'message.user') {
      if (turns.has(id)) continue
      turns.set(id, { user: str(p.text) ? p.text : '', steps: [] })
      order.push(id)
      continue
    }
    const t = turns.get(id)
    if (!t) continue
    if (e.type === 'message.assistant') {
      const parts = stepParts(p)
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
  for (const id of order) {
    const t = turns.get(id)!
    out.push({ role: 'user', parts: [{ type: 'text', text: t.user }] })
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
  out.push({ role: 'user', parts: [{ type: 'text', text: currentText }] })
  return out
}
