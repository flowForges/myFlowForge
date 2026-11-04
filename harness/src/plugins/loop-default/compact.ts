// 上下文压缩(spec §8.4):只改发给模型的消息,不改事件。纯函数、确定性:同样的输入折叠同样的结果,
// 前缀尽量逐字节不变;只折工具结果,用户消息(含第一条里的 <environment>)永不动
// dropOldest(06 spec §12)是折叠之后的最后一道:同样只改发送的消息
import { posix } from 'node:path'
import { clipOpening } from '../../lib/memory/checkpoint'
import type { Message, Part } from '../../lib/models/types'

export { contextWindow, DEFAULT_CONTEXT } from '../../lib/models/contextWindow'
const CHARS_PER_TOKEN = 3.5
/** 图片按约 1000 token 计 */
const IMAGE_CHARS = 3_500
const SUMMARY_MAX = 80

const partChars = (p: Part): number => {
  switch (p.type) {
    case 'text':
      return p.text.length
    case 'tool_call':
      return p.name.length + p.args.length
    case 'tool_result':
      return p.content.length
    case 'reasoning':
      return (p.text?.length ?? 0) + (p.replay === undefined ? 0 : (JSON.stringify(p.replay)?.length ?? 0))
    case 'image':
      return IMAGE_CHARS
  }
}

const messageChars = (m: Message) => m.parts.reduce((n, p) => n + partChars(p), 0)

export const charsToTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN)

/** 估算 token = 字符数 / 3.5 */
export function estimateTokens(messages: Message[]): number {
  return charsToTokens(messages.reduce((n, m) => n + messageChars(m), 0))
}

export interface CompactOpts {
  /** 模型上下文(token) */
  context: number
  /** 最近这么多 token 内的工具结果永不折叠;默认 min(24 000, context × 0.3)(小上下文的模型也能折) */
  keepRecentTokens?: number
  /** 超过 context × high 才压缩 */
  high?: number
  /** 第二遍折到 context × low 以下 */
  low?: number
  /** 解析 read 的相对路径(同一文件不同写法算同一个) */
  cwd?: string
}

const parseArgs = (args: string): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(args)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const SUMMARY_KEYS = ['path', 'command', 'pattern', 'url', 'query']

/** 占位里的参数摘要:优先常见的单个字段,否则压缩后的 JSON;单行、截断 */
function summary(args: string): string {
  const a = parseArgs(args)
  const key = a && SUMMARY_KEYS.find(k => typeof a[k] === 'string')
  const s = key ? String(a[key]) : a ? JSON.stringify(a) : args
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX)}…` : line
}

const placeholder = (name: string, args: string) => `[已折叠:${name} ${summary(args)},需要时重新读取]`

/** 同一次 read 的键:解析后的路径 + offset + limit(分页读的不同段不互相顶替) */
function readKey(args: string, cwd: string | undefined): string | undefined {
  const a = parseArgs(args)
  const p = a?.path
  if (typeof p !== 'string' || !p) return undefined
  const slashed = p.replace(/\\/g, '/')
  const path = cwd ? posix.resolve(cwd.replace(/\\/g, '/'), slashed) : posix.normalize(slashed)
  return JSON.stringify([path, a.offset ?? null, a.limit ?? null])
}

interface Slot { msg: number; part: number; name: string; args: string; chars: number; isError: boolean }

export function compact(messages: Message[], opts: CompactOpts): Message[] {
  const high = opts.context * (opts.high ?? 0.7)
  const low = opts.context * (opts.low ?? 0.5)
  const keepRecent = opts.keepRecentTokens ?? Math.min(24_000, Math.floor(opts.context * 0.3))
  const out = messages.slice()
  let chars = messages.reduce((n, m) => n + messageChars(m), 0)
  if (charsToTokens(chars) <= high) return out

  // 每个工具结果配上它之前最近的同 id 调用
  const slots: Slot[] = []
  const lastCall = new Map<string, { name: string; args: string }>()
  messages.forEach((m, mi) =>
    m.parts.forEach((p, pi) => {
      if (p.type === 'tool_call') lastCall.set(p.id, { name: p.name, args: p.args })
      else if (p.type === 'tool_result') {
        const c = lastCall.get(p.callId)
        if (c) slots.push({ msg: mi, part: pi, ...c, chars: p.content.length, isError: p.isError === true })
      }
    }),
  )

  const folded = new Set<Slot>()
  const fold = (s: Slot, text: string) => {
    const m = out[s.msg]
    const parts = m.parts.slice()
    const p = parts[s.part] as Extract<Part, { type: 'tool_result' }>
    parts[s.part] = { ...p, content: text }
    out[s.msg] = { ...m, parts }
    chars += text.length - s.chars
    folded.add(s)
  }

  // 第一遍:同一文件同一段被 read 多次,只留最近一次成功的(失败的新结果不顶替旧内容)
  const latest = new Map<string, Slot>()
  for (const s of slots) {
    if (s.name !== 'read' || s.isError) continue
    const key = readKey(s.args, opts.cwd)
    if (!key) continue
    const prior = latest.get(key)
    if (prior) fold(prior, placeholder(prior.name, prior.args))
    latest.set(key, s)
  }
  if (charsToTokens(chars) <= high) return out

  // 第二遍:从最旧的工具结果开始折,直到低于低水位;最近 keepRecentTokens 内(与之重叠的)不折
  const after: number[] = new Array(messages.length + 1).fill(0)
  for (let i = messages.length - 1; i >= 0; i--) after[i] = after[i + 1] + messageChars(messages[i])
  for (const s of slots) {
    if (charsToTokens(chars) <= low) break
    if (folded.has(s)) continue
    if (charsToTokens(after[s.msg + 1]) < keepRecent) break // 往后的都更近
    const text = placeholder(s.name, s.args)
    if (text.length < s.chars) fold(s, text)
  }
  return out
}

export interface DropOpts {
  /** 模型上下文(token) */
  context: number
  /** 降到 context × target 以下 */
  target: number
  /** 尾部至少留这么多 token:再丢就少于它时停下,哪怕还没到 target */
  keepRecent: number
  /** 当前轮开场消息的下标;没有给负数。不截、不丢 */
  currentOpening: number
}

const DROPPED = /^\[已省略较早的 (\d+) 条消息,事件日志里还在\]$/
const droppedNote = (n: number): Message => ({ role: 'user', parts: [{ type: 'text', text: `[已省略较早的 ${n} 条消息,事件日志里还在]` }] })
const onlyText = (m: Message | undefined): string | undefined => {
  const p = m?.role === 'user' && m.parts.length === 1 ? m.parts[0] : undefined
  return p?.type === 'text' ? p.text : undefined
}

/** 正文是最后一个文本 part;环境块和会话块不动 */
function clipFirst(m: Message): Message {
  const i = m.parts.map(p => p.type).lastIndexOf('text')
  const p = m.parts[i]
  if (p?.type !== 'text') return m
  const text = clipOpening(p.text)
  return text === p.text ? m : { ...m, parts: m.parts.map((x, j) => (j === i ? { ...p, text } : x)) }
}

/** 尾部从这里开始合法:user,或者一个完整的 assistant 步。工具结果不能打头 */
function startsTail(messages: Message[], i: number): boolean {
  const m = messages[i]
  if (m.role === 'user') return true
  if (m.role !== 'assistant') return false
  return !m.parts.some(p => p.type === 'tool_call') || messages[i + 1]?.role === 'tool'
}

/**
 * 确定性地丢最旧的消息:留第一条(正文截到 4000 字,否则第一条就是大段粘贴的会话永远卡死)和当前轮的开场消息(不截),
 * 从第二条往后整段丢,放一条占位。紧跟第一条的检查点也留:它盖住的内容只剩它了。
 * 最后一个合法的尾部总留下,所以到不了 target 时交给 03 的失败
 */
export function dropOldest(messages: Message[], opts: DropOpts): Message[] {
  const limit = opts.context * opts.target
  const out = messages.slice()
  if (estimateTokens(out) <= limit || !out.length) return out
  if (opts.currentOpening !== 0) out[0] = clipFirst(out[0])
  if (estimateTokens(out) <= limit) return out

  const pinned = onlyText(out[1])?.startsWith('<checkpoint through=') ? 2 : 1
  const opening = opts.currentOpening >= pinned ? opts.currentOpening : -1
  const head = out.slice(0, pinned).reduce((n, m) => n + messageChars(m), 0)
  const openingChars = opening < 0 ? 0 : messageChars(out[opening])
  const after: number[] = new Array(out.length + 1).fill(0)
  for (let i = out.length - 1; i >= 0; i--) after[i] = after[i + 1] + messageChars(out[i])

  let cut = pinned
  for (let c = pinned + 1; c < out.length; c++) {
    if (!startsTail(out, c)) continue
    if (charsToTokens(after[c]) < opts.keepRecent) break
    cut = c
    const kept = head + after[c] + (opening >= 0 && opening < c ? openingChars : 0) + droppedNote(0).parts.reduce((n, p) => n + partChars(p), 0)
    if (charsToTokens(kept) <= limit) break
  }
  const keepsOpening = opening >= pinned && opening < cut
  const removed = cut - pinned - (keepsOpening ? 1 : 0)
  if (removed <= 0) return out
  const earlier = out.slice(pinned, cut).reduce((n, m) => n + Number(DROPPED.exec(onlyText(m) ?? '')?.[1] ?? 0), 0)
  const notes = out.slice(pinned, cut).filter(m => DROPPED.test(onlyText(m) ?? '')).length
  return [...out.slice(0, pinned), droppedNote(removed - notes + earlier), ...(keepsOpening ? [out[opening]] : []), ...out.slice(cut)]
}
