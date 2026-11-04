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
  /** 有上限地追事件日志,返回追上了没有。追上了,刚发生的回滚这一次读就算数 */
  catchUp(): boolean
  recall(): boolean
  log: Pick<Logger, 'warn'>
}

interface Shown {
  text: string
  /** 放不下 MEMORY.md 的块没有版本:这个版本不算发全了 */
  coreVersion?: string
}

const chars = (s: string) => [...s].length
const turnOf = (e: KernelEvent) => (e.payload as { turnId?: unknown } | null)?.turnId
/** 整段被删除换掉的块、只有回忆的块都不是:正文转义过,开头伪造不了 */
const holdsCore = (text: string) => text.startsWith('<memory kind=') || text.startsWith('<memory-update>')

/**
 * 模型当前历史里还看得见的核心块,按日志顺序:会话块,加上没回滚的轮块。
 * 没有 cwd 的会话(loop-direct)只留有回答、已结束的轮;会话块总在第一条消息里。
 * memory.delete 把一块整段换掉后它就不算了:版本可能没变,不补发模型就再也见不到
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
    if (visible && typeof p.text === 'string' && holdsCore(p.text)) shown.push({ text: p.text, ...(typeof p.coreVersion === 'string' && { coreVersion: p.coreVersion }) })
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

  /** MEMORY.md 该进块却一行都没放下,连"还有几行"都没有:这个版本不能算见过,否则预算变大了也不会补 */
  const dropsNotes = (text: string, memory: string | undefined) => memory !== undefined && dataText(memory).trim() !== '' && !text.includes('<notes>\n')

  const coreBlocks = (req: Parameters<MemoryService['contextFor']>[0], hasCwd: boolean): { session?: ContextBlock; update?: { text: string; items: string[]; coreVersion?: string } } => {
    const { events, turnId, contextTokens } = req
    const core = d.files.coreText()
    const budget = Math.min(SESSION_MAX, Math.floor(contextTokens * 0.1 * CHARS_PER_TOKEN))
    const firstTurn = !events.some(e => e.type === 'message.user' && turnOf(e) !== turnId)
    if (firstTurn && blocksOf(events).session === undefined) {
      const text = coreBlock(core, budget)
      if (text !== '') return { session: { kind: 'session', text, items: itemsIn(text), ...(!dropsNotes(text, core.memory) && { coreVersion: core.version }) } }
    }
    const shown = visibleCore(events, hasCwd)
    const lastSeen = [...shown].reverse().find(b => b.coreVersion !== undefined)?.coreVersion
    const empty = core.user === '' && core.memory === ''
    if (lastSeen === core.version || (empty && lastSeen === undefined)) return {}
    const changed = (body: string, tag: string) => dataText(body).trim() !== lastSection(shown, tag)
    const parts = {
      ...(changed(core.user, 'user-profile') && { user: core.user }),
      ...(changed(core.memory, 'notes') && { memory: core.memory }),
      ...(empty && { emptied: true }),
    }
    const text = updateBlock(parts, budget)
    const dropped = dropsNotes(text, parts.memory)
    if (text === '' || (dropped && parts.user === undefined)) return {} // 只有一个空壳:等放得下再说
    return { update: { text, items: itemsIn(text), ...(!dropped && { coreVersion: core.version }) } }
  }

  const recallFor = (scope: Scope, req: Parameters<MemoryService['contextFor']>[0], caughtUp: boolean): { text: string; items: string[] } | undefined => {
    const { sessionId, text, events } = req
    if (!d.recall() || chars(text.trim()) < RECALL_MIN) return undefined
    const owner = scope.read.includes('owner')
    // 接入可能还没走到这个会话的回滚,群聊笔记要跟着那一轮走
    const undone = new Set(events.filter(e => e.type === 'turn.rolledBack').map(turnOf))
    // 没追上就不读原始层:别的会话的回滚和删除墓碑可能还在后面,req.events 里也没有。笔记不受影响:来自文件或自己这个会话
    const candidates = [
      ...d.store.recallNotes({ q: text, scopes: scope.read, layers: [owner ? 'topic' : 'session'], limit: RECALL_ITEMS }).filter(n => !undone.has(n.turnId)),
      ...(owner && caughtUp ? d.store.recallUserRaw({ q: text, excludeSession: sessionId, limit: RECALL_ITEMS }).map(r => ({ ...r, id: `r_${r.seq}`, source: 'user' })) : []),
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
    const caughtUp = d.catchUp()
    const { session: sessionBlock, update } = scope.injectCore ? coreBlocks(req, session.cwd !== undefined) : {}
    let recall: ReturnType<typeof recallFor>
    try {
      recall = recallFor(scope, req, caughtUp)
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
