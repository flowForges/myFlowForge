// 视图 → app 的 ChatMessage(08 §8.2),用现有的 Message 渲染。工具输出总是内联在 output 里,从不设 outputOmitted:
// 这里没有 ToolOutputCtx,ToolBlock 取不回省略的输出。
import type { SessionOrigin } from '@mffai/protocol'
import type { ChatMessage, ToolActivity } from '@shared/types'
import { isEnded, type SessionView, type TurnView } from './reduce'

/** 截断过的工具输出,块尾的标记 */
export const TRUNCATED_MARK = '\n… 已截断'

const iso = (ms: number) => new Date(ms).toISOString()

const REMOTE_IMAGE = /!\[([^\]]*)\]\((https?:[^)\s]*)\)/gi

/**
 * 模型写的 `![x](https://…)` 改成链接:app 的 Markdown 对绝对地址的图直接加载,模型文字(可能被注入)就能不经点击
 * 把读到的东西拼进地址发出去。链接要点了才经系统浏览器打开。围栏代码块里的原样留着
 */
export function defuseImages(text: string): string {
  if (!/!\[/.test(text)) return text
  let fenced = false
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line }
    return fenced ? line : line.replace(REMOTE_IMAGE, '[$1]($2)')
  }).join('\n')
}

export interface MessageGroup { turnId: string; messages: ChatMessage[] }

function turnMessages(v: SessionView, t: TurnView, origin: SessionOrigin): { messages: ChatMessage[]; streaming?: string } {
  const via = (external: boolean) => (external ? '转发' : origin === 'im' ? 'Telegram' : undefined)
  const items: { seq: number; msg: ChatMessage }[] = []
  t.users.forEach((u, i) => {
    const m: ChatMessage = { id: `${t.turnId}:u${i}`, who: 'user', text: u.text, ts: iso(u.ts) }
    const w = via(u.external)
    if (w) m.via = w
    items.push({ seq: u.seq, msg: m })
  })
  for (const s of t.steps) {
    if (!s.text && !s.reasoning && !s.tools.length) continue
    const m: ChatMessage = { id: s.key, who: 'ai', text: defuseImages(s.text), ts: iso(s.ts) }
    if (s.reasoning) m.think = { label: '思考', steps: [s.reasoning] }
    if (s.tools.length) {
      m.tools = s.tools.map(({ truncated, ...tool }): ToolActivity => (truncated ? { ...tool, output: `${tool.output ?? ''}${TRUNCATED_MARK}` } : tool))
    }
    items.push({ seq: s.seq, msg: m })
  }
  items.sort((a, b) => a.seq - b.seq)
  const messages = items.map((x) => x.msg)
  const live = !isEnded(v, t) && !v.open?.parked
  if (!live) return { messages }
  const last = messages.at(-1)
  if (last?.who === 'ai') return { messages, streaming: last.id }
  const pending: ChatMessage = { id: `${t.turnId}:live`, who: 'ai', text: '', ts: last?.ts ?? '' }
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
