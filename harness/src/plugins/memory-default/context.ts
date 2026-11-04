// contextFor(06 spec §7):这一轮该往消息里加什么。只决定文本;文本写进事件之后,重建再也不读文件
import type { Logger } from '../../kernel/log'
import type { SessionInfo } from '../../kernel/sessions'
import { blocksOf } from '../../lib/memory/inject'
import type { ContextBlock, MemoryService } from '../../lib/memory/types'
import { coreBlock, dataText, recallBlock, updateBlock } from '../../lib/memory/wrap'
import type { KernelEvent } from '../../protocol/events'
import { localDate, type MemoryFiles } from './files'
import { scopeOf, type Scope } from './policy'
import type { Store } from './store'

const SESSION_MAX = 9000
const CHARS_PER_TOKEN = 3.5
const RECALL_MIN = 6
const RECALL_ITEMS = 3
const RECALL_CHARS = 1500
/** 比这长的行只放命中前后的摘录,否则一条就占掉三条的预算 */
const RECALL_WHOLE = 500

export interface ContextDeps {
  store: Pick<Store, 'recallUserRaw' | 'recallNotes' | 'notesInFile'>
  files: Pick<MemoryFiles, 'coreText'>
  sessions: { get(id: string): SessionInfo | undefined }
  /** 追上事件日志:刚发生的回滚,这一次读就要算数 */
  flush(): void
  recall(): boolean
  log: Pick<Logger, 'warn'>
}

interface Shown {
  text: string
  coreVersion: string
}

const chars = (s: string) => [...s].length
const turnOf = (e: KernelEvent) => (e.payload as { turnId?: unknown } | null)?.turnId

/**
 * 模型当前历史里还看得见的带版本的块,按日志顺序:会话块,加上没回滚的轮块。
 * 没有 cwd 的会话(loop-direct)只留有回答、已结束的轮;会话块总在第一条消息里
 */
function visibleCore(events: KernelEvent[], hasCwd: boolean): Shown[] {
  const rolledBack = new Set<unknown>()
  const ended = new Set<unknown>()
  const answered = new Set<unknown>()
  for (const e of events) {
    if (e.type === 'turn.rolledBack') rolledBack.add(turnOf(e))
    else if (e.type === 'turn.ended') ended.add(turnOf(e))
    else if (e.type === 'message.assistant') answered.add(turnOf(e))
  }
  const shown: Shown[] = []
  let sessionSeen = false
  for (const e of events) {
    if (e.type !== 'memory.injected') continue
    const p = e.payload as { kind?: unknown; text?: unknown; coreVersion?: unknown }
    const session = p.kind === 'session'
    const visible = session ? !sessionSeen : !rolledBack.has(turnOf(e)) && (hasCwd || (ended.has(turnOf(e)) && answered.has(turnOf(e))))
    sessionSeen ||= session
    if (visible && typeof p.text === 'string' && typeof p.coreVersion === 'string') shown.push({ text: p.text, coreVersion: p.coreVersion })
  }
  return shown
}

/** 模型手上这个文件的文本:最新一个带这一节的块。文本都转义过,里面不会有真的结束标签 */
function lastSection(shown: Shown[], tag: string): string {
  for (let i = shown.length - 1; i >= 0; i--) {
    const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)</${tag}>`).exec(shown[i].text)
    if (m) return m[1].trim()
  }
  return ''
}

export function createContextFor(d: ContextDeps): MemoryService['contextFor'] {
  /** 块里真有的条目。预算或上限截掉的不算:memory.delete 按它找,多列一条就白白换掉整段 */
  const itemsIn = (text: string): string[] =>
    ['USER.md', 'MEMORY.md'].flatMap(file => d.store.notesInFile(file)).filter(n => text.includes(dataText(n.text))).map(n => n.id)

  const coreBlocks = (req: Parameters<MemoryService['contextFor']>[0], hasCwd: boolean): { session?: ContextBlock; update?: { text: string; items: string[]; coreVersion: string } } => {
    const { events, turnId, contextTokens } = req
    const core = d.files.coreText()
    const budget = Math.min(SESSION_MAX, Math.floor(contextTokens * 0.1 * CHARS_PER_TOKEN))
    const firstTurn = !events.some(e => e.type === 'message.user' && turnOf(e) !== turnId)
    if (firstTurn && blocksOf(events).session === undefined) {
      const text = coreBlock(core, budget)
      if (text !== '') return { session: { kind: 'session', text, items: itemsIn(text), coreVersion: core.version } }
    }
    const shown = visibleCore(events, hasCwd)
    const lastSeen = shown[shown.length - 1]?.coreVersion
    const empty = core.user === '' && core.memory === ''
    if (lastSeen === core.version || (empty && lastSeen === undefined)) return {}
    const changed = (body: string, tag: string) => dataText(body).trim() !== lastSection(shown, tag)
    const text = updateBlock(
      {
        ...(changed(core.user, 'user-profile') && { user: core.user }),
        ...(changed(core.memory, 'notes') && { memory: core.memory }),
        ...(empty && { emptied: true }),
      },
      budget,
    )
    return text === '' ? {} : { update: { text, items: itemsIn(text), coreVersion: core.version } }
  }

  const recallFor = (scope: Scope, sessionId: string, text: string): { text: string; items: string[] } | undefined => {
    if (!d.recall() || chars(text.trim()) < RECALL_MIN) return undefined
    const owner = scope.read.includes('owner')
    const candidates = [
      ...d.store.recallNotes({ q: text, scopes: scope.read, layers: [owner ? 'topic' : 'session'], limit: RECALL_ITEMS }),
      ...(owner ? d.store.recallUserRaw({ q: text, excludeSession: sessionId, limit: RECALL_ITEMS }).map(r => ({ ...r, id: `r_${r.seq}`, source: 'user' })) : []),
    ]
    const items: { id: string; source: string; date: string; text: string }[] = []
    let room = RECALL_CHARS
    for (const c of candidates) {
      if (items.length === RECALL_ITEMS) break
      const body = [chars(c.text) <= RECALL_WHOLE ? c.text : c.excerpt, c.excerpt].find(t => chars(dataText(t)) <= room)
      if (body === undefined) continue
      room -= chars(dataText(body))
      items.push({ id: c.id, source: c.source, date: localDate(c.ts), text: body })
    }
    return items.length > 0 ? { text: recallBlock(items), items: items.map(i => i.id) } : undefined
  }

  return req => {
    const session = d.sessions.get(req.sessionId)
    if (!session) return []
    const scope = scopeOf(session)
    d.flush()
    const { session: sessionBlock, update } = scope.injectCore ? coreBlocks(req, session.cwd !== undefined) : {}
    let recall: ReturnType<typeof recallFor>
    try {
      recall = recallFor(scope, req.sessionId, req.text)
    } catch (err) {
      // 索引坏了丢的只是回忆:核心记忆照发,否则它就一直发不出去
      d.log.warn('memory recall failed', { error: err instanceof Error ? err.name : 'unknown' })
    }
    const blocks: ContextBlock[] = sessionBlock ? [sessionBlock] : []
    if (update || recall) {
      blocks.push({
        kind: 'turn',
        text: [update?.text, recall?.text].filter(t => t !== undefined).join('\n'),
        items: [...(update?.items ?? []), ...(recall?.items ?? [])],
        ...(update && { coreVersion: update.coreVersion }),
      })
    }
    return blocks
  }
}
