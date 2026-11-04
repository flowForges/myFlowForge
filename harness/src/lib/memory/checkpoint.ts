// 检查点的纯函数(06 spec §12):安全边界、哪个检查点有效、当前生效的重建标记。
// 循环和写手都用这里的判断,不各写一份;只读事件,所以插件不在时循环照样能重建
import type { KernelEvent } from '../../protocol/index'

export interface CheckpointFields {
  throughSeq: number
  asOfSeq: number
  text: string
  redacted?: boolean
}

export interface SelectedCheckpoint {
  seq: number
  throughSeq: number
  text: string
}

export interface ActiveRebuild {
  throughSeq: number
  text: string
}

const objectOf = (e: KernelEvent): Record<string, unknown> => (e.payload && typeof e.payload === 'object' ? (e.payload as Record<string, unknown>) : {})
const turnOf = (e: KernelEvent): unknown => objectOf(e).turnId

/** 这一轮算被检查点盖住:它的第一条 message.user 在 throughSeq 或之前 */
export function isCovered(turnFirstSeq: number, throughSeq: number): boolean {
  return turnFirstSeq <= throughSeq
}

/**
 * 写手能选的 throughSeq:每个值都是一条 message.user 或 message.assistant 紧前面那个事件的 seq,所以尾部不会以工具结果开头。
 * 一轮里重复的、不是后续消息的 message.user 不进历史,它之后可能就是工具结果,不算边界
 */
export function safeBoundaries(events: KernelEvent[], rolledBack: Set<string>): number[] {
  const out: number[] = []
  const opened = new Set<unknown>()
  events.forEach((e, i) => {
    if (e.type !== 'message.user' && e.type !== 'message.assistant') return
    const id = turnOf(e)
    const stray = e.type === 'message.user' && opened.has(id) && objectOf(e).followUp !== true
    if (e.type === 'message.user') opened.add(id)
    if (i > 0 && !stray && !rolledBack.has(id as string)) out.push(events[i - 1].seq)
  })
  return out
}

function fieldsOf(e: KernelEvent): CheckpointFields | undefined {
  const p = objectOf(e)
  if (typeof p.throughSeq !== 'number' || typeof p.asOfSeq !== 'number' || typeof p.text !== 'string') return undefined
  return { throughSeq: p.throughSeq, asOfSeq: p.asOfSeq, text: p.text, ...(typeof p.redacted === 'boolean' && { redacted: p.redacted }) }
}

/**
 * 失效条件:被删除作废,或写完之后才撤销了它包含的轮(§12"回滚")。
 * 回滚发生在 asOfSeq 之前的轮,写手已经跳过了,不算。形状不对或自相矛盾的检查点(盖住了写它时还没有的事件)也不用
 */
export function checkpointValid(cp: CheckpointFields, events: KernelEvent[]): boolean {
  if (cp.redacted === true || cp.text === '') return false
  if (!Number.isInteger(cp.throughSeq) || !Number.isInteger(cp.asOfSeq) || cp.throughSeq < 0 || cp.throughSeq > cp.asOfSeq) return false
  const firstUser = new Map<unknown, number>()
  for (const e of events) {
    if (e.type !== 'message.user') continue
    const id = turnOf(e)
    if (!firstUser.has(id)) firstUser.set(id, e.seq)
  }
  return !events.some(e => {
    if (e.type !== 'turn.rolledBack' || e.seq <= cp.asOfSeq) return false
    const first = firstUser.get(turnOf(e))
    return first !== undefined && isCovered(first, cp.throughSeq)
  })
}

/** 最新的有效检查点 */
export function selectCheckpoint(events: KernelEvent[]): SelectedCheckpoint | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type !== 'memory.checkpoint') continue
    const cp = fieldsOf(e)
    if (cp && checkpointValid(cp, events)) return { seq: e.seq, throughSeq: cp.throughSeq, text: cp.text }
  }
  return undefined
}

/** 最新的、指向有效检查点的 context.rebuilt。标记自己所在的轮回滚了不影响它:它盖住的都在回滚之前 */
export function activeRebuild(events: KernelEvent[]): ActiveRebuild | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type !== 'context.rebuilt') continue
    const target = objectOf(e).checkpointSeq
    const event = events.find(c => c.seq === target && c.type === 'memory.checkpoint')
    const cp = event && fieldsOf(event)
    if (cp && checkpointValid(cp, events)) return { throughSeq: cp.throughSeq, text: cp.text }
  }
  return undefined
}

const CLIP_MAX = 4000
const CLIP_NOTE = '\n[后面的内容已省略,事件日志里还在]'

/** 重建和兜底留下的用户正文:连说明不超过 4000。不切开代理对,孤立的代理对会让请求的 JSON 被拒 */
export function clipOpening(text: string): string {
  if (text.length <= CLIP_MAX) return text
  let end = CLIP_MAX - CLIP_NOTE.length
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return text.slice(0, end) + CLIP_NOTE
}
