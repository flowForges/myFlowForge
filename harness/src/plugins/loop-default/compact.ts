// 上下文压缩(spec §8.4):只改发给模型的消息,不改事件。纯函数、确定性:同样的输入折叠同样的结果,
// 前缀尽量逐字节不变;只折工具结果,用户消息(含第一条里的 <environment>)永不动
import { posix } from 'node:path'
import type { Message, ModelsService, Part } from '../../lib/models/types'
import type { ModelRef } from '../../protocol/index'

export const DEFAULT_CONTEXT = 128_000
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
  /** 最近这么多 token 内的工具结果永不折叠 */
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

function readPath(args: string, cwd: string | undefined): string | undefined {
  const p = parseArgs(args)?.path
  if (typeof p !== 'string' || !p) return undefined
  const slashed = p.replace(/\\/g, '/')
  return cwd ? posix.resolve(cwd.replace(/\\/g, '/'), slashed) : posix.normalize(slashed)
}

interface Slot { msg: number; part: number; name: string; args: string; chars: number }

export function compact(messages: Message[], opts: CompactOpts): Message[] {
  const high = opts.context * (opts.high ?? 0.7)
  const low = opts.context * (opts.low ?? 0.5)
  const keepRecent = opts.keepRecentTokens ?? 24_000
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
        if (c) slots.push({ msg: mi, part: pi, ...c, chars: p.content.length })
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

  // 第一遍:同一文件被 read 多次,只留最近一次
  const latest = new Map<string, Slot>()
  for (const s of slots) {
    if (s.name !== 'read') continue
    const path = readPath(s.args, opts.cwd)
    if (!path) continue
    const prior = latest.get(path)
    if (prior) fold(prior, placeholder(prior.name, prior.args))
    latest.set(path, s)
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

/** 模型上下文:账号自己的模型清单优先,其次目录里该预设的模型,缺省 128 000 */
export function contextWindow(models: Pick<ModelsService, 'catalog' | 'accounts'>, ref: ModelRef | 'default'): number {
  const concrete = ref === 'default' ? models.catalog().default : ref
  if (!concrete) return DEFAULT_CONTEXT
  const acc = models.accounts().find(a => a.id === concrete.accountId)
  if (!acc) return DEFAULT_CONTEXT
  const entry = acc.models?.find(m => m.id === concrete.modelId) ?? models.catalog().models[acc.presetId]?.find(m => m.id === concrete.modelId)
  return entry && entry.context > 0 ? entry.context : DEFAULT_CONTEXT
}
