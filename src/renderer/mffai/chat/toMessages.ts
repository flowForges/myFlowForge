// 视图 → app 的 ChatMessage(08 §8.2),用现有的 Message 渲染。工具输出总是内联在 output 里,从不设 outputOmitted:
// 这里没有 ToolOutputCtx,ToolBlock 取不回省略的输出。
import type { SessionOrigin } from '@mffai/protocol'
import type { ChatMessage, ToolActivity } from '@shared/types'
import { isEnded, type SessionView, type TurnView } from './reduce'

/** 截断过的工具输出,块尾的标记 */
export const TRUNCATED_MARK = '\n… 已截断'

const iso = (ms: number) => new Date(ms).toISOString()

export interface MessageGroup { turnId: string; messages: ChatMessage[] }

/**
 * 每条用户行、每一步各自缓存成 ChatMessage:reduce 只换掉变了的那一步 / 那一轮,别的对象原样留着,
 * 于是没变的消息对象不变,memo(Message) 不重渲染(流式时每个 delta 一次)
 */
const memo = new WeakMap<object, { key: string; msg: ChatMessage }>()
function cached(src: object, key: string, make: () => ChatMessage): ChatMessage {
  const hit = memo.get(src)
  if (hit && hit.key === key) return hit.msg
  const msg = make()
  memo.set(src, { key, msg })
  return msg
}

function turnMessages(v: SessionView, t: TurnView, origin: SessionOrigin): { messages: ChatMessage[]; streaming?: string } {
  const via = (external: boolean) => (external ? '转发' : origin === 'im' ? 'Telegram' : undefined)
  const items: { seq: number; msg: ChatMessage }[] = []
  t.users.forEach((u, i) => {
    const w = via(u.external)
    const msg = cached(u, `${t.turnId}|${i}|${w ?? ''}`, () => {
      const m: ChatMessage = { id: `${t.turnId}:u${i}`, who: 'user', text: u.text, ts: iso(u.ts) }
      if (w) m.via = w
      return m
    })
    items.push({ seq: u.seq, msg })
  })
  for (const s of t.steps) {
    if (!s.text && !s.reasoning && !s.tools.length) continue
    const msg = cached(s, s.key, () => {
      const m: ChatMessage = { id: s.key, who: 'ai', text: s.text, ts: iso(s.ts) }
      if (s.reasoning) m.think = { label: '思考', steps: [s.reasoning] }
      if (s.tools.length) {
        m.tools = s.tools.map(({ truncated, ...tool }): ToolActivity => (truncated ? { ...tool, output: `${tool.output ?? ''}${TRUNCATED_MARK}` } : tool))
      }
      return m
    })
    items.push({ seq: s.seq, msg })
  }
  items.sort((a, b) => a.seq - b.seq)
  const messages = items.map((x) => x.msg)
  const live = !isEnded(v, t) && !v.open?.parked
  if (!live) return { messages }
  const last = messages.at(-1)
  if (last?.who === 'ai') return { messages, streaming: last.id }
  const pending = cached(t.users, `${t.turnId}:live|${last?.ts ?? ''}`, () => ({ id: `${t.turnId}:live`, who: 'ai', text: '', ts: last?.ts ?? '' }))
  return { messages: [...messages, pending], streaming: pending.id }
}

/** 每一轮的消息;流式的是开着(没挂起)的那一轮最后一条助手消息,直到终态事件 */
export function toMessages(v: SessionView, origin: SessionOrigin): {
  messages: ChatMessage[]; streamingIds: Set<string>; groups: MessageGroup[]
} {
  const streamingIds = new Set<string>()
  const groups = v.turns.map((t) => {
    const r = turnMessages(v, t, origin)
    if (r.streaming) streamingIds.add(r.streaming)
    return { turnId: t.turnId, messages: r.messages }
  })
  return { messages: groups.flatMap((g) => g.messages), streamingIds, groups }
}
