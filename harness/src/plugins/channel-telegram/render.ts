// 内核事件 → Telegram 消息块(07 spec §9)。纯函数:同样的事件给出同样的块,重启后能从事件重算。
// 令牌不进这里:mask 由调用方给(scrub + 令牌字面值)。
import type { KernelEvent } from '../../protocol/index'
import { capEntities, splitChunks, toEntities, type Entity } from './markdown'
import { stableText } from './holdback'

export interface Chunk {
  text: string
  entities: Entity[]
  /** 一段的第一块:带手机提醒。编辑不提醒,后面的块静音 */
  notify?: boolean
}

export interface RenderOptions {
  turnId: string
  /** 轮已经结束:全部文字都发,不再留尾巴 */
  final: boolean
  /** 排队等这轮结束的消息数 */
  queued: number
  mask(s: string): string
  /** 会话的工作目录;没给就取 session.created 里的 */
  cwd?: string
}

export const CHUNK_MAX = 3900
export const SEGMENT_CHUNKS = 12
export const TRUNCATED = '已截断,完整内容在 app 里'
/** 成功结束却什么都没说(空回复、被过滤、只有思考):不能让他干等 */
export const NO_OUTPUT = '这轮没有输出'
/** 连打码都做不了:不打码的字不能出门 */
export const RENDER_FAILED = '这轮的内容显示不了,完整内容在 app 里'
/** 只为限住后面的解析和切块;在打码之后截,切不开密钥。截过的一定带截断提示 */
const TEXT_CLIP = 50_000
const TOOL_LINES = 5
const ARG_CLIP = 80
const PROGRESS_CLIP = 60
const CODE = /^[a-z_]{1,32}$/
const NAME = /^[A-Za-z0-9_.-]{1,40}$/
const EXECUTOR = /^[a-z0-9_-]{1,20}$/

const ARG_KEY: Record<string, string> = { read: 'path', write: 'path', edit: 'path', list: 'path', glob: 'pattern', grep: 'pattern', shell: 'command' }

function clip(s: string, n: number): string {
  if (s.length <= n) return s
  let cut = n
  const c = s.charCodeAt(cut - 1)
  if (c >= 0xd800 && c <= 0xdbff) cut--
  return s.slice(0, cut) + '…'
}

// 绝对路径:前面不能是单词字符、`.`、`:`、`/`(URL 里的 `//` 和相对路径里的 `/` 都不算)
const ABS_PATH = /(?<![A-Za-z0-9_.~\-:/\\$%@*{}\[\]])(?:[A-Za-z]:[\\/]|~\/|\/)[^\s"'`<>|;,()&]*/g

/** cwd 内的写成相对路径,其余只留文件名:worktree 路径带用户名 */
export function rewritePaths(s: string, roots: readonly string[]): string {
  return s.replace(ABS_PATH, p => {
    for (const root of roots) {
      if (p === root) return '.'
      if (p.startsWith(root + '/') || p.startsWith(root + '\\')) return p.slice(root.length + 1) || '.'
    }
    return p.split(/[\\/]/).filter(Boolean).pop() ?? '/'
  })
}

/** 一行字:先打码,再改路径,折叠空白,最后截 */
function cleanLine(s: string, roots: readonly string[], mask: (s: string) => string, n: number): string {
  return clip(rewritePaths(mask(s), roots).replace(/\s+/g, ' ').trim(), n)
}

function field(preview: string, key: string): string | undefined {
  try {
    const v = (JSON.parse(preview) as Record<string, unknown> | null)?.[key]
    return typeof v === 'string' && v !== '' ? v : undefined
  } catch {
    // argsPreview 可能被截断:从中间读出这个键
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(preview)
    if (!m?.[1]) return undefined
    try {
      return JSON.parse(`"${m[1].replace(/\\$/, '')}"`) as string
    } catch {
      return m[1]
    }
  }
}

/** 工具行的参数。read、write、edit、list 取路径,glob、grep 取模式,shell 取命令;其余(检索词可能是私事)和解析不了的只有名字 */
export function argOf(toolName: string, argsPreview: string, roots: readonly string[], mask: (s: string) => string): string {
  const key = ARG_KEY[toolName]
  if (!key) return ''
  const v = field(argsPreview, key)
  return v === undefined ? '' : cleanLine(v, roots, mask, ARG_CLIP)
}

interface TextBlock { k: 'text'; key: string; parts: string[]; full?: string }
interface ToolsBlock { k: 'tools'; ids: string[] }
interface RunBlock { k: 'run'; id: string }
interface LineBlock { k: 'line'; text: string }
interface BreakBlock { k: 'break' }
type Block = TextBlock | ToolsBlock | RunBlock | LineBlock | BreakBlock

interface Call { name: string; preview: string; failed: boolean }
interface Run { executor: string; phase: 'queued' | 'running' | 'ended'; progress?: string; status?: string; reason?: string; files?: number }

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** 失败的那一行。`message` 不发:厂商报错里可能有 URL 和账号(§9.3) */
export function failureLine(reason: unknown): string {
  if (reason === 'interrupted') return '后台重启,这轮中断了'
  return `失败(${typeof reason === 'string' && CODE.test(reason) ? reason : 'error'})`
}

function runLine(r: Run, roots: readonly string[], mask: (s: string) => string): string {
  if (r.phase === 'queued') return `⧗ ${r.executor} 排队中`
  if (r.phase === 'running') return `⧗ ${r.executor} 运行中${r.progress ? ` · ${cleanLine(r.progress, roots, mask, PROGRESS_CLIP)}` : ''}`
  if (r.status === 'ok') return `✓ ${r.executor} 完成${r.files ? `,改了 ${r.files} 个文件` : ''}`
  const code = r.reason !== undefined ? (CODE.test(r.reason) ? r.reason : 'error') : r.status !== undefined && CODE.test(r.status) ? r.status : 'error'
  return `✗ ${r.executor} 失败(${code})`
}

export function renderTurn(events: readonly KernelEvent[], o: RenderOptions): Chunk[] {
  const segments: Block[][] = [[]]
  const calls = new Map<string, Call>()
  const runs = new Map<string, Run>()
  const roots = new Set<string>()
  const addRoot = (p: unknown) => {
    if (typeof p === 'string' && p.length > 1) roots.add(p.replace(/[\\/]+$/, ''))
  }
  addRoot(o.cwd)
  let parked = false
  let assistants = 0
  let ended = false

  for (const e of events) {
    const p = obj(e.payload)
    if (e.type === 'session.created') {
      addRoot(p.cwd)
      continue
    }
    if (p.turnId !== o.turnId) continue
    const seg = segments[segments.length - 1]!
    switch (e.type) {
      case 'message.user':
        if (p.followUp === true) segments.push([])
        break
      case 'message.assistant.delta': {
        const t = str(p.text)
        if (!t) break
        const key = p.step !== undefined ? String(p.step) : `a${assistants}`
        const last = seg[seg.length - 1]
        if (last?.k === 'text' && last.key === key && last.full === undefined) last.parts.push(t)
        else seg.push({ k: 'text', key, parts: [t] })
        break
      }
      case 'message.assistant': {
        const key = p.step !== undefined ? String(p.step) : `a${assistants}`
        assistants++
        const full = str(p.text) ?? ''
        const at = seg.findIndex(b => b.k === 'text' && b.key === key)
        if (at >= 0) {
          ;(seg[at] as TextBlock).full = full
          for (let i = seg.length - 1; i > at; i--) if (seg[i]!.k === 'text' && (seg[i] as TextBlock).key === key) seg.splice(i, 1)
        } else if (full) seg.push({ k: 'text', key, parts: [], full })
        break
      }
      case 'tool.started': {
        const id = str(p.callId) ?? `c${e.seq}`
        calls.set(id, { name: str(p.name) ?? '', preview: str(p.argsPreview) ?? '', failed: false })
        const last = seg[seg.length - 1]
        if (last?.k === 'tools') last.ids.push(id)
        else seg.push({ k: 'tools', ids: [id] })
        break
      }
      case 'tool.ended': {
        const c = calls.get(str(p.callId) ?? '')
        if (c && p.ok === false) c.failed = true
        break
      }
      case 'approval.requested':
        seg.push({ k: 'break' })
        break
      case 'turn.parked':
        parked = true
        break
      case 'turn.resumed':
        parked = false
        break
      case 'turn.ended':
        ended = true
        break
      case 'turn.failed':
        ended = true
        seg.push({ k: 'line', text: failureLine(p.reason) })
        break
      case 'executor.run.queued':
      case 'executor.run.started':
      case 'executor.run.progress':
      case 'executor.run.ended': {
        const id = str(p.runId)
        if (!id) break
        let r = runs.get(id)
        if (!r) {
          const ex = str(p.executor)
          r = { executor: ex && EXECUTOR.test(ex) ? ex : 'executor', phase: 'queued' }
          runs.set(id, r)
          seg.push({ k: 'run', id })
        }
        if (e.type === 'executor.run.started') {
          r.phase = 'running'
          addRoot(p.worktree)
          addRoot(p.cwd)
        } else if (e.type === 'executor.run.progress') {
          if ((p.kind === 'tool' || p.kind === 'file') && r.phase !== 'ended') {
            if (r.phase === 'queued') r.phase = 'running'
            r.progress = str(p.text)
          }
        } else if (e.type === 'executor.run.ended') {
          r.phase = 'ended'
          r.status = str(p.status)
          r.reason = str(p.reason)
          const files = obj(p.changed).files
          r.files = Array.isArray(files) ? files.length : 0
        }
        break
      }
    }
  }

  const rootList = [...roots].sort((a, b) => b.length - a.length)
  const last = segments[segments.length - 1]!
  if (parked && !ended) {
    const waiting = [...runs.values()].filter(r => r.phase !== 'ended').map(r => r.executor)
    last.push({ k: 'line', text: `等 ${waiting.length > 0 ? [...new Set(waiting)].join('、') : 'executor'} 跑完,可以接着发消息` })
  }
  if (o.queued > 0) last.push({ k: 'line', text: `已收到 ${o.queued} 条` })

  const lineOf = (c: Call) => (c.failed ? `✗ ${NAME.test(c.name) ? c.name : 'tool'}` : `▸ ${NAME.test(c.name) ? c.name : 'tool'}`)

  const out: Chunk[] = []
  for (const blocks of segments) {
    const chunks: Chunk[] = []
    let text = ''
    let entities: Entity[] = []
    let prev: Block['k'] | undefined
    let clipped = false
    const flush = () => {
      if (text !== '') for (const part of splitChunks(text, entities, CHUNK_MAX)) chunks.push({ text: part.text, entities: capEntities(part.entities) })
      text = ''
      entities = []
      prev = undefined
    }
    const add = (piece: string, ents: Entity[], kind: Block['k']) => {
      if (piece === '') return
      if (text !== '') text += prev === 'text' && kind === 'text' ? '\n\n' : '\n'
      for (const en of ents) entities.push({ ...en, offset: en.offset + text.length })
      text += piece
      prev = kind
    }
    blocks.forEach((b, i) => {
      switch (b.k) {
        case 'break':
          flush()
          break
        case 'text': {
          const raw = b.full ?? b.parts.join('')
          // 还在写的最后一块只发稳定的部分;后面已经有别的内容,或步骤、轮结束了,就是完整的
          const complete = b.full !== undefined || o.final || i < blocks.length - 1
          const masked = o.mask(complete ? raw : stableText(raw, false))
          if (masked.length > TEXT_CLIP) clipped = true
          const md = clip(masked, TEXT_CLIP).trim()
          if (md === '') break
          const r = toEntities(md)
          // 去掉记号后可能拼出整个密钥(`sk-ab**cd**ef`):再打一次码,变了就只发纯文字,偏移对不上了
          const remasked = o.mask(r.text)
          if (remasked === r.text) add(r.text, r.entities, 'text')
          else add(remasked, [], 'text')
          break
        }
        case 'tools': {
          const shown = b.ids.slice(-TOOL_LINES)
          const rows = shown.map(id => {
            const c = calls.get(id)!
            if (c.failed) return lineOf(c)
            const arg = argOf(c.name, c.preview, rootList, o.mask)
            return arg ? `${lineOf(c)} ${arg}` : lineOf(c)
          })
          if (b.ids.length > shown.length) rows.unshift(`…还有 ${b.ids.length - shown.length} 个`)
          add(rows.join('\n'), [], 'tools')
          break
        }
        case 'run':
          add(runLine(runs.get(b.id)!, rootList, o.mask), [], 'run')
          break
        case 'line':
          add(b.text, [], 'line')
          break
      }
    })
    flush()
    // 最后一段没有东西:没有输出的那一轮,或者后续消息之后什么都没说
    if (chunks.length === 0 && o.final && ended && blocks === last) chunks.push({ text: NO_OUTPUT, entities: [] })
    if (chunks.length > SEGMENT_CHUNKS) {
      chunks.length = SEGMENT_CHUNKS
      clipped = true
    }
    if (clipped && chunks.length > 0) chunks[chunks.length - 1]!.text += `\n${TRUNCATED}`
    if (chunks.length > 0) chunks[0]!.notify = true
    out.push(...chunks)
  }
  return out
}

/**
 * renderTurn 抛错时的退路:最终回复不能因此丢。只取正文和失败那一行,纯文本,不解析 Markdown。
 * 还是先打码再切;打码本身也抛错就只发固定的一句
 */
export function renderPlain(events: readonly KernelEvent[], o: Pick<RenderOptions, 'turnId' | 'mask'>): Chunk[] {
  const parts: string[] = []
  let streaming = ''
  let failure: string | undefined
  for (const e of events) {
    const p = obj(e.payload)
    if (p.turnId !== o.turnId) continue
    if (e.type === 'message.assistant.delta') streaming += str(p.text) ?? ''
    else if (e.type === 'message.assistant') {
      parts.push(str(p.text) ?? streaming)
      streaming = ''
    } else if (e.type === 'turn.failed') failure = failureLine(p.reason)
  }
  if (streaming) parts.push(streaming)
  if (failure) parts.push(failure)
  let text: string
  try {
    text = o.mask(parts.filter(Boolean).join('\n\n')).trim() || NO_OUTPUT
  } catch {
    text = RENDER_FAILED
  }
  const chunks: Chunk[] = splitChunks(text, [], CHUNK_MAX).map(c => ({ text: c.text, entities: [] }))
  if (chunks.length > SEGMENT_CHUNKS) {
    chunks.length = SEGMENT_CHUNKS
    chunks[chunks.length - 1]!.text += `\n${TRUNCATED}`
  }
  if (chunks[0]) chunks[0].notify = true
  return chunks
}
