// memory.* RPC(06 spec §16)。这里只有 app 进得来(带 token),看得到全部范围,含群聊笔记。
// memory.delete 真的删:六步依次做,每步可重做;失败不留回执,记下的文本留到做完,重试才找得到要清的东西。
// session.delete(08 §4.3)也在这里:同一条流水线,外加内核的墓碑和整会话抹除
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { z } from 'zod'
import { jsonHolds, REDACTED, type RedactEdit } from '../../kernel/eventLog'
import { purgeHoldMs, type PluginContext } from '../../kernel/pluginHost'
import { RpcError } from '../../kernel/rpcError'
import type { Sessions } from '../../kernel/sessions'
import { scanInjection } from '../../lib/memory/scan'
import { scrub } from '../../lib/memory/scrub'
import { coreBlock, dataText, recallBlock, updateBlock } from '../../lib/memory/wrap'
import { clip } from '../../lib/tools/diagnostics'
import type { BackgroundRuns, SessionCommands } from '../../lib/tools/types'
import type { KernelEvent } from '../../protocol/events'
import type { MemoryHealth, MemoryItem, MemoryLayer, WorkerMethodName } from '../../protocol/rpc'
import { ERR_BUSY, MEMORY_ID, WorkerMethods } from '../../protocol/rpc'
import type { Background } from './background'
import { consolidateProblems, type Summary } from './consolidate'
import type { MemoryFiles } from './files'
import { decideHabit, listHabits } from './habits'
import { lastSeqOf, type Ingest } from './ingest'
import { scopeOf } from './policy'
import { forget, type Proposals } from './proposals'
import { damaged, type NoteRow, type RawRow, type Store } from './store'
import { interleave, NOTE_LAYERS, RAW_ID, rawSource } from './tools'

const INVALID_PARAMS = -32602
const INTERNAL = -32603
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50
const QUERY_MAX = 200
/** 列表只看个大概,全文走 memory.get */
const LIST_TEXT = 500
/** 短文本不扫:删一条 pnpm 不能清空所有提到 pnpm 的记录(spec §16) */
const LITERAL_MIN = 12
const PAGE = 500
const CATCH_UP_SLICE_MS = 25
const PENDING = 'purge:'
/** 启动时接着做:一个做不完的删除不能让每次启动都阻塞,更不能把进程拖进崩溃循环 */
const MAX_RESUMES = 3
const RESUME_BATCH = 16
const SQLITE_FULL = 13
const SPILL_MARK = '[已截断,完整输出:'
/** 删会话的原始行一片删多少:FTS 三元组的删除每行几毫秒,片之间让出事件循环(评审 I3) */
const RAW_SLICE = 100

/** 测试用:每一步开始之前,抛错 = 这一步失败 */
export type PurgeStep = 'deleted' | 'raw' | 'tombstone' | 'redact' | 'erase' | 'purge'

export interface LiveMemory {
  store: Store
  files: MemoryFiles
  ingest: Ingest
  background: Background
  proposals: Proposals
}

export interface MemoryRpcDeps {
  ctx: PluginContext
  sessions: Sessions
  live: LiveMemory | undefined
  /** 激活时就有的问题 */
  problems: string[]
  dbFile: string
  now(): number
  /** 排进后台,等它结束。库打不开时没有 */
  consolidate?(): Promise<Summary>
  /** 写 config.json 的 memory 段,并更新插件自己那份 */
  setRoutine(routine: boolean): void
  onPurgeStep?(step: PurgeStep): void
  /** 删会话时原始行一片删多少;默认 RAW_SLICE */
  rawDeleteSlice?: number
}

/** 错误信息里有路径,给 health 的只留代码 */
export function faultCode(prefix: string, err: unknown): string {
  const e = err as { code?: unknown; errstr?: unknown; name?: unknown }
  const code = [e.code, e.errstr, e.name].find(v => typeof v === 'string' && v !== '')
  return `${prefix}:${String(code ?? 'unknown').replace(/\s+/g, '_')}`
}

type ParamsOf<M extends WorkerMethodName> = z.infer<(typeof WorkerMethods)[M]['params']>

/** 删到一半的进度。text 在 memory.sqlite 的 meta 里,做完才清:这是重试能重新扫事件的唯一依据 */
/**
 * 有删除已经开始、还没把日志扫完:这时读到的事件还是原文。扫完之后(swept)日志是干净的,只差落盘。
 * 记录读不懂也算没扫完,写手那边宁可少算一份
 */
export function deleteInFlight(store: Pick<Store, 'metaWithPrefix'>): boolean {
  return store.metaWithPrefix(PENDING).some(r => {
    try {
      return (JSON.parse(r.value) as { swept?: unknown } | null)?.swept !== true
    } catch {
      return true
    }
  })
}

/** 有删除试满了次数还没扫完:deleteInFlight 一直是真,提取就一直停着,要说出来 */
export function deleteStuck(store: Pick<Store, 'metaWithPrefix'>): boolean {
  return store.metaWithPrefix(PENDING).some(r => {
    try {
      const p = JSON.parse(r.value) as { swept?: unknown; resumes?: number } | null
      return p?.swept !== true && (p?.resumes ?? 0) >= MAX_RESUMES
    } catch {
      return false
    }
  })
}

interface PendingPurge {
  id: string
  text?: string
  scope?: string
  evidence: string[]
  removedIds: string[]
  rawSeqs: number[]
  /** memory.file.set 去掉的条目:重试时按文件找回来 */
  file?: string
  tombstoneSeq?: number
  /** 要删的落盘文件。事件换掉之后才删,换之前要留着当依据;换完就只有这里记得 */
  spills?: string[]
  /** 启动时试过几次 */
  resumes?: number
  swept?: boolean
  redacted?: number
  sources?: string[]
  /** 从删掉的原始行提取出来的:已经一起删了的,和核心文件里还引用它们的 */
  derived?: string[]
  /** 删会话(08 §4.3):id 是 session:<id> */
  kind?: 'session'
  sessionId?: string
  /** 这个会话能点名的 r_ id(原始层还在的和事件里有的),第一次就记下 */
  rawIds?: string[]
  /** 原始层里这些行的文本:别的会话的召回、搜索结果按它换。做完就清 */
  rawTexts?: [number, string][]
  /** 还引用这个会话原话的核心条目,raw 那一步之前收集 */
  notes?: string[]
  /** 这个会话的轮:memory_write 写下的按它找(评审 C1) */
  turnIds?: string[]
  rawDone?: boolean
  redactDone?: boolean
  erased?: boolean
  erasedRows?: number
}

const notFound = () => new RpcError(INVALID_PARAMS, 'not found')
const capped = (limit: number | undefined) => Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT)
const codePoints = (s: string) => [...s].length
const turnOf = (e: KernelEvent) => (e.payload as { turnId?: unknown } | null)?.turnId
const nextTick = () => new Promise<void>(resolve => setImmediate(resolve))
const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 和 tools-registry 的落盘文件名同一个规则 */
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')

/** 块的外框。针落在这里面就不能按针换:前言和标签没了,块就不再声明自己是数据 */
const FRAMES = [
  coreBlock({ user: 'x', memory: 'x', topics: ['x'] }, Infinity),
  updateBlock({ user: 'x', memory: 'x', emptied: true }),
  recallBlock([{ id: 'x', source: 'user', date: 'x', text: 'x' }]),
].join('\n')

const STEP_DELTAS = new Set<string>(['message.assistant.delta', 'message.reasoning.delta'])
/** r_<seq> 能点名的事件:原始层只收这几种(ingest.ts) */
const NAMEABLE = new Set<string>(['message.user', 'message.assistant', 'tool.ended', 'executor.notice'])
const textField = (e: KernelEvent): string | undefined => {
  const p = e.payload as { text?: unknown; content?: unknown }
  const v = e.type === 'tool.ended' ? p.content : p.text
  return typeof v === 'string' ? v : undefined
}

/** 点名的这条还有没有文本。assistant 的文本在 parts 里 */
const namedText = (e: KernelEvent): string | undefined => {
  if (e.type !== 'message.assistant') return textField(e)
  const parts = ((e.payload as { parts?: { type?: string; text?: unknown }[] }).parts ?? []).flatMap(p => (p.type === 'text' && typeof p.text === 'string' ? [p.text] : []))
  return parts.length > 0 ? parts.join('') : undefined
}

/** 一个会话当前这一轮的索引:工具结果到的时候,要回头找那一步的 message.assistant 和 delta */
interface TurnIndex {
  id: unknown
  /** delta 分块到达,针跨块匹配不到:拼起来比一次,文本用完就扔 */
  open: Map<number, { seqs: number[]; texts: Map<string, string> }>
  steps: Map<number, { seqs: number[]; quotes: boolean }>
  calls: Map<string, { assistant?: number; step?: number; started?: number; quotes?: boolean }>
}

export function registerMemoryRpc(d: MemoryRpcDeps): { stop(): Promise<void> } {
  const { ctx, live } = d
  let stopped = false
  let chain: Promise<unknown> = Promise.resolve()
  let resuming: NodeJS.Immediate | undefined

  /** 一次一个删除:FTS optimize、WAL 截断、扫事件都不该交叉 */
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => {})
    return run
  }

  const alive = () => {
    if (stopped) throw new RpcError(INTERNAL, 'memory is closing')
  }

  const register = <M extends WorkerMethodName>(method: M, fn: (m: LiveMemory, params: ParamsOf<M>) => unknown) => {
    ctx.rpc.register(method, async params => {
      if (!live) throw new RpcError(INTERNAL, 'memory is unavailable')
      return fn(live, params as ParamsOf<M>)
    })
  }

  /** 读之前对账。返回原始层能不能读:没追上时这些行的回滚和删除墓碑可能还在后面 */
  const fresh = (m: LiveMemory): boolean => {
    const caughtUp = m.ingest.catchUp()
    try {
      m.files.reconcile('core')
    } catch (err) {
      ctx.log.error('memory reconcile failed', { error: err instanceof Error ? err.name : 'unknown' })
    }
    return caughtUp
  }

  const rawItem = (r: RawRow, text: string): MemoryItem => ({
    id: `r_${r.seq}`, layer: 'raw', text, source: rawSource(r), scope: r.scope, sessionId: r.sessionId, ts: r.ts, flags: scanInjection(r.text),
  })
  const noteItem = (n: NoteRow, text: string): MemoryItem => ({
    id: n.id, layer: n.layer as MemoryLayer, text, source: n.source, scope: n.scope, ...(n.file !== undefined && { file: n.file }), ts: n.ts, flags: n.flags,
  })

  register('memory.list', (m, { layer, limit, before }) => {
    const n = capped(limit)
    const rawReady = fresh(m)
    const notes = layer === 'raw' ? [] : m.store.listNotes({ layers: layer ? [layer] : NOTE_LAYERS, before, limit: n }).map(x => noteItem(x, clip(x.text, LIST_TEXT)))
    const rows = (layer === undefined || layer === 'raw') && rawReady ? m.store.listRaw({ before, limit: n }).map(r => rawItem(r, clip(r.text, LIST_TEXT))) : []
    const merged = [...notes, ...rows].sort((a, b) => (b.ts as number) - (a.ts as number))
    // 同一时刻的不拆开:下一页是 ts < before,拆开就漏了
    const floor = merged[Math.min(n, merged.length) - 1]?.ts ?? 0
    return { items: merged.filter(i => (i.ts as number) >= floor) }
  })

  register('memory.get', (m, { id }) => {
    const rawReady = fresh(m)
    const seq = RAW_ID.exec(id)?.[1]
    if (seq !== undefined) {
      const row = rawReady ? m.store.getRaw(Number(seq)) : undefined
      if (!row || row.rolledBack) throw notFound()
      return { ...rawItem(row, row.text), evidence: [] }
    }
    const note = m.store.getNote(id)
    if (!note) throw notFound()
    return { ...noteItem(note, note.text), evidence: note.file ? m.files.evidenceOf(note.file, id) : [] }
  })

  register('memory.search', (m, { query, layer = 'all', limit }) => {
    if (codePoints(query) > QUERY_MAX) throw new RpcError(INVALID_PARAMS, 'query too long')
    const n = capped(limit)
    const rawReady = fresh(m)
    const notes = layer === 'raw' ? [] : m.store.searchNotes({ q: query, scopes: 'all', layers: NOTE_LAYERS, limit: n }).map(x => noteItem(x, x.excerpt))
    const rows = layer === 'notes' || !rawReady ? [] : m.store.searchRaw({ q: query, scopes: 'all', limit: n }).map(r => rawItem(r, r.excerpt))
    return { items: interleave(notes, rows, n) }
  })

  register('memory.update', (m, { id, text }) => {
    if (RAW_ID.test(id)) throw notFound() // 对话记录不能改写,只能删
    return { ok: true, masked: m.files.updateEntry(id, text, 'user').masked }
  })

  register('memory.file.get', (m, { file }) => m.files.read(file))

  register('memory.proposals.list', (m, { status }) => ({ items: m.proposals.list(status) }))

  // 回执和进行中的去重都在内核(pluginCommand):同一个 commandId 不会跑第二次
  register('memory.consolidate', () => {
    if (!d.consolidate) throw new RpcError(INTERNAL, 'memory is unavailable')
    return d.consolidate()
  })

  register('memory.habits.list', m => ({ items: listHabits(m.store) }))

  register('memory.habits.decide', (m, { id, decision }) => {
    if (!decideHabit(m.store, id, decision, d.now())) throw notFound()
    return { ok: true }
  })

  register('memory.recommendations.set', (_m, { routine }) => {
    d.setRoutine(routine)
    return { ok: true }
  })

  register('memory.changes', (m, { limit }) => ({
    items: m.store.listChanges(capped(limit)).map(c => ({
      ts: c.ts, id: c.entry_id ?? '', ...(c.file !== null && { file: c.file }), op: c.op, before: c.before, after: c.after, source: c.source,
    })),
  }))

  ctx.rpc.register('memory.health', () => health())

  async function health(): Promise<MemoryHealth> {
    const empty = { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0 }
    if (!live) return { ...empty, problems: [...d.problems] }
    const { store, files, background } = live
    // status 自己兜住了卡住的额度读取和读不了的账本
    const spend = await background.status()
    const faults: string[] = []
    const guarded = <T>(fallback: T, read: () => T): T => {
      try {
        return read()
      } catch (err) {
        faults.push(damaged(err) ? 'db_corrupt' : faultCode('db_fault', err))
        return fallback
      }
    }
    const count = (sql: string) => guarded(0, () => (store.db.prepare(sql).get() as { n: number }).n)
    guarded(undefined, () => files.reconcile('core'))
    const lastConsolidation = guarded(undefined, () => store.getMeta('lastConsolidation'))
    const pending = guarded<{ key: string; value: string }[]>([], () => store.metaWithPrefix(PENDING))
    const pendingCode = (r: { key: string; value: string }) => {
      const stuck = ((JSON.parse(r.value) as PendingPurge).resumes ?? 0) >= MAX_RESUMES
      return `${stuck ? 'delete_stuck' : 'delete_pending'}:${r.key.slice(PENDING.length)}`
    }
    return {
      dbBytes: guarded(0, () => statSync(d.dbFile, { throwIfNoEntry: false })?.size ?? 0),
      rawRows: count('SELECT COUNT(*) AS n FROM raw'),
      noteRows: count('SELECT COUNT(*) AS n FROM notes'),
      cursorLag: guarded(0, () => Math.max(0, lastSeqOf((seq, limit) => ctx.events.after(seq, limit)) - store.cursor())),
      pendingProposals: count("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'"),
      ...(lastConsolidation !== undefined && { lastConsolidation }),
      budget: spend.budget,
      ...(spend.backgroundModel && { backgroundModel: spend.backgroundModel }),
      problems: [...new Set([...d.problems, ...store.problems, ...pending.map(pendingCode), ...guarded<string[]>([], () => consolidateProblems(store, d.now())), ...faults, ...(spend.problem ? [spend.problem] : [])])],
    }
  }

  if (live) {
    const purger = createPurger(d, live, alive)
    register('memory.delete', (_m, { id }) =>
      exclusive(async () => {
        const { redacted, sources } = await purger.purgeEntry(id)
        return { ok: true, redacted, sources }
      }),
    )
    // 08 §4.3:逐个删,一次落盘(一次 VACUUM)。查不到的就是已经没了,放进 gone,不报错
    register('memory.deleteMany', (_m, { ids }) => exclusive(() => purger.deleteMany(ids)))
    // 08 §4.3:真的删一个会话。和别的删除排在一起
    register('session.delete', (_m, { sessionId, discardUnmerged }) => exclusive(() => purger.deleteSession(sessionId, discardUnmerged ?? [])))
    register('memory.file.set', (m, { file, content, expectedHash }) =>
      exclusive(async () => {
        alive()
        const { removed } = m.files.planWrite(file, content, expectedHash)
        // 先记下再写:写完再失败,文本和证据就只能从 changes 里猜了
        for (const r of removed) purger.remember({ id: r.id, text: r.text, scope: 'owner', evidence: r.evidence, removedIds: [r.id], rawSeqs: [], file })
        let masked: number
        try {
          ;({ masked } = m.files.write(file, content, expectedHash, 'user'))
        } catch (err) {
          for (const r of removed) purger.forget(r.id)
          throw err
        }
        // 去掉几行都只重写一次事件库
        const ids = purger.pendingForFile(file)
        for (const id of ids) await purger.removeEntry(id)
        await purger.finish(ids)
        return { ok: true, hash: m.files.read(file).hash, masked }
      }),
    )
    // 和删除排在一起:删除扫到一半时批准同样的文本,就把刚删的又写回去了
    register('memory.proposals.decide', (m, { id, decision, text }) =>
      exclusive(async () => {
        alive()
        // 没追上时证据可能已经回滚或删除,这里还看不到。不留回执,可以重试
        if (!m.ingest.catchUp()) throw new RpcError(INTERNAL, 'memory is still indexing')
        m.proposals.decide(id, decision, text)
        return { ok: true }
      }),
    )
    // 上次没做完的:客户端可能永远不会重试,而文本还在库里。让激活先走完
    resuming = setImmediate(() => {
      exclusive(() => purger.resumeAll()).catch((err: unknown) => {
        if (!stopped) ctx.log.error('memory delete resume failed', { error: err instanceof Error ? err.name : 'unknown' })
      })
    })
  } else {
    for (const method of ['memory.delete', 'memory.deleteMany', 'session.delete', 'memory.file.set', 'memory.proposals.decide'] as const) register(method, () => undefined)
  }

  return {
    async stop() {
      stopped = true
      if (resuming) clearImmediate(resuming)
      await chain
    },
  }
}

function createPurger(d: MemoryRpcDeps, m: LiveMemory, alive: () => void) {
  const { ctx, sessions } = d
  const { store, files, ingest } = m
  const step = (name: PurgeStep) => d.onPurgeStep?.(name)
  const keyOf = (id: string) => `${PENDING}${id}`

  const load = (id: string): PendingPurge | undefined => {
    const raw = store.getMeta(keyOf(id))
    return raw === undefined ? undefined : (JSON.parse(raw) as PendingPurge)
  }
  const save = (p: PendingPurge) => store.setMeta(keyOf(p.id), JSON.stringify(p))

  /** 原始层追上日志才能删:游标后面的行扫不到,之后就会回来。接入失败时不能假装删完了 */
  async function settled(): Promise<void> {
    for (;;) {
      alive()
      const before = store.cursor()
      if (ingest.catchUp(CATCH_UP_SLICE_MS)) return
      if (store.cursor() === before) throw new RpcError(INTERNAL, 'memory ingest is failing')
      await nextTick()
    }
  }

  const eventAt = (seq: number): KernelEvent | undefined => {
    const e = ctx.events.after(seq - 1, 1)[0]
    return e?.seq === seq ? e : undefined
  }

  /** 第一次见到这个 id。undefined:什么都不是或者已经清过,什么都不用碰 */
  function begin(id: string): PendingPurge | undefined {
    const seq = RAW_ID.exec(id)?.[1]
    if (seq === undefined) {
      const entry = files.findEntry(id)
      return entry ? { id, text: entry.text, scope: entry.scope, evidence: entry.evidence, removedIds: [id], rawSeqs: [] } : undefined
    }
    const e = eventAt(Number(seq))
    if (!e || !NAMEABLE.has(e.type)) return undefined
    const row = store.getRaw(Number(seq))
    const body = namedText(e)
    const blank = body === undefined || body === '' || body === REDACTED
    if (!row && blank) return undefined
    const session = e.sessionId === undefined ? undefined : sessions.get(e.sessionId)
    return {
      id,
      ...(!blank && { text: row?.text ?? scrub(body).text }),
      scope: row?.scope ?? scopeOf(session).read[0] ?? `session:${e.sessionId}`,
      evidence: [],
      removedIds: [id],
      rawSeqs: [Number(seq)],
    }
  }

  function tombstone(p: PendingPurge): void {
    step('tombstone')
    const e = ctx.append({ type: 'memory.deleted', payload: { id: p.id, rawSeqs: p.rawSeqs } })
    p.tombstoneSeq = e.seq
    store.setMeta('lastDeleteSeq', String(e.seq))
    save(p)
  }

  /**
   * 还留在对话记录里、用户可以逐条删的:证据和逐字匹配的用户原话,加上换完之后还逐字含它的助手回复。
   * 工具输出和通知已经按针换掉了,不在这里
   */
  function sourcesOf(p: PendingPurge, quotedBy: number[]): string[] {
    const seqs = [...new Set([...p.rawSeqs, ...quotedBy])].sort((a, b) => a - b)
    const text = p.text === undefined ? undefined : [p.text, dataText(p.text)]
    return seqs.filter(seq => {
      const e = eventAt(seq)
      if (e?.type === 'message.user') return textField(e) !== REDACTED
      return e?.type === 'message.assistant' && text !== undefined && text.some(n => (namedText(e) ?? '').includes(n))
    }).map(seq => `r_${seq}`)
  }

  /**
   * 扫全部事件,收集要换掉的字段。整个日志一页一页地读,页之间让出事件循环;最后一页读空到调用方 redact 之间是同步的,
   * 所以扫的途中写进来的事件也算数。resumed:上次可能只做了一半,旧墓碑不能当"这之前都清过了"
   */
  async function sweep(p: PendingPurge, resumed: boolean): Promise<{ edits: RedactEdit[]; spills: string[]; quotedBy: number[] }> {
    // 什么都不是的 r_(session.created 的 seq)不算点名
    const ownSeq = RAW_ID.test(p.id) && p.rawSeqs.includes(Number(p.id.slice(2))) ? Number(p.id.slice(2)) : undefined
    /**
     * 删会话:会话本身整个抹掉,这里只管别的会话里的副本:召回块、记忆工具的结果、记忆写入的调用、看过它的摘要。
     * 别的会话里用户自己的话、工具输出、助手回复不按这个会话的原话去扫(那是成千条文本对整个日志)
     */
    const whole = p.kind === 'session'
    const texts = whole ? (p.rawTexts ?? []).map(([, t]) => t) : p.text !== undefined ? [p.text] : []
    const longTexts = texts.filter(t => codePoints(t) >= LITERAL_MIN)
    const long = longTexts.length > 0
    const data = p.text !== undefined ? dataText(p.text) : undefined
    const datas = longTexts.map(dataText)
    // 正文里是原样(思考、参数),块和结果里是 dataText 转义过的
    const needles = [...new Set([...longTexts, ...datas])]
    const ownSession = new Set<number>()
    // 编辑器能在注释里写任何 id:不是条目形状的不拿来匹配,否则 id=id 会命中每一条搜索结果
    const ids = [...new Set([...p.removedIds, ...p.rawSeqs.map(s => `r_${s}`)])].filter(i => MEMORY_ID.test(i))
    const idPattern = ids.length > 0 ? new RegExp(`(?<![A-Za-z0-9_-])(?:${ids.map(regexEscape).join('|')})(?![A-Za-z0-9_-])`) : undefined
    const named = (s: string) => idPattern?.test(s) ?? false
    const quoted = (s: string) => needles.some(n => s.includes(n))
    // 写下这条的那一步范围够小,短文本也按针换:"短文本不扫"防的是清空所有提到它的记录
    const stepNeedles = !whole && p.text ? [...new Set([p.text, data as string])] : []
    const stepQuoted = (s: string) => stepNeedles.some(n => s.includes(n))
    const spills = new Set<string>()
    /** 同范围里逐字含它、这里不换的行:用户的话、别的步骤里助手的回复。放进 sources 让用户决定 */
    const quotedBy = new Set<number>()
    const argsQuote = (args: string) => needles.some(n => jsonHolds(args, n))
    const noteSaw = (session: string | undefined) => {
      if (session !== undefined) saw.add(session)
    }
    const listed = new Set(ids)
    const rawSeqs = new Set(p.rawSeqs)

    const edits = new Map<string, RedactEdit>()
    const add = (edit: RedactEdit) => edits.set(`${edit.seq}\0${edit.needle ?? ''}\0${edit.callId ?? ''}`, edit)
    const saw = new Set<string>()
    const checkpoints: { seq: number; sessionId?: string; literal: boolean }[] = []
    const turns = new Map<string, TurnIndex>()
    /** 进度在通知之前到:先记下,点名了哪个 run 最后再换 */
    const progress = new Map<string, number[]>()
    const namedRuns = new Set<string>()
    const inScope = (sessionId: string | undefined): boolean => {
      if (sessionId === undefined || p.scope === undefined) return false
      return scopeOf(sessions.get(sessionId)).read.includes(p.scope)
    }
    const turnIndex = (e: KernelEvent): TurnIndex | undefined => {
      if (e.sessionId === undefined) return undefined
      const id = turnOf(e)
      let t = turns.get(e.sessionId)
      if (!t || t.id !== id) turns.set(e.sessionId, (t = { id, open: new Map(), steps: new Map(), calls: new Map() }))
      return t
    }
    const stepOf = (e: KernelEvent) => (e.payload as { step?: number }).step ?? 0

    /** 结果落盘了:找出这次调用的文件,判断看文件内容,callId 可能和别的轮重名。这里不删,见 PendingPurge.spills */
    const findSpill = (e: KernelEvent, callId: string, name: string, holds: (body: string) => boolean): boolean => {
      if (e.sessionId === undefined || !(textField(e) ?? '').includes(SPILL_MARK)) return false
      const dir = sessions.spillDir(e.sessionId)
      const own = new RegExp(`^${regexEscape(safeName(callId))}-${regexEscape(safeName(name))}(?:-[0-9a-f]{8})?\\.txt$`)
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw err
      }
      let hit = false
      for (const file of names.filter(n => own.test(n))) {
        const body = readFileSync(join(dir, file), 'utf8')
        if (!holds(body)) continue
        spills.add(join(dir, file))
        hit = true
      }
      return hit
    }

    const visit = (e: KernelEvent) => {
      if (whole && e.sessionId === p.sessionId) ownSession.add(e.seq)
      if (e.seq === ownSeq) {
        add({ seq: e.seq })
        if (e.sessionId !== undefined) saw.add(e.sessionId)
        const run = (e.payload as { runId?: unknown }).runId
        if (e.type === 'executor.notice' && typeof run === 'string') namedRuns.add(run)
      }
      const session = e.sessionId
      // 笔记的证据在这里,或者原话逐字在这里:这个会话的摘要可能转述过它
      if (rawSeqs.has(e.seq)) noteSaw(session)
      switch (e.type) {
        case 'executor.run.progress': {
          const run = (e.payload as { runId?: unknown }).runId
          if (typeof run === 'string') progress.set(run, [...(progress.get(run) ?? []), e.seq])
          const text = textField(e)
          if (!whole && text !== undefined && text !== REDACTED && inScope(session)) for (const needle of needles) if (text.includes(needle)) add({ seq: e.seq, needle })
          return
        }
        case 'memory.deleted': {
          // 更早的墓碑:那次已经清过它之前的事件。再扫一遍会把按针换过的块整段换掉,前缀再动一次
          const q = e.payload as { id?: unknown }
          if (!resumed && q.id === p.id && e.seq !== p.tombstoneSeq) {
            edits.clear()
            saw.clear()
            turns.clear()
          }
          return
        }
        case 'message.assistant.delta':
        case 'message.reasoning.delta': {
          const t = turnIndex(e)
          if (!t) return
          const n = stepOf(e)
          let open = t.open.get(n)
          if (!open) t.open.set(n, (open = { seqs: [], texts: new Map() }))
          open.seqs.push(e.seq)
          open.texts.set(e.type, (open.texts.get(e.type) ?? '') + (textField(e) ?? ''))
          return
        }
        case 'message.assistant': {
          const t = turnIndex(e)
          if (!t) return
          const n = stepOf(e)
          const open = t.open.get(n)
          t.open.delete(n)
          const state = { seqs: open?.seqs ?? [], quotes: open !== undefined && [...open.texts.values()].some(stepQuoted) }
          t.steps.set(n, state)
          const parts = (e.payload as { parts?: { type?: string; id?: string; args?: unknown }[] }).parts ?? []
          for (const part of parts) {
            if (part.type !== 'tool_call' || part.id === undefined) continue
            const quotes = !whole && typeof part.args === 'string' && inScope(session) && argsQuote(part.args)
            t.calls.set(part.id, { ...t.calls.get(part.id), assistant: e.seq, step: n, quotes })
            if (quotes) {
              add({ seq: e.seq, callId: part.id })
              noteSaw(session)
            }
          }
          if (!whole && inScope(session) && quoted(namedText(e) ?? '')) {
            quotedBy.add(e.seq)
            noteSaw(session)
          }
          // 点名的这一步:delta 只能整段换,针跨块匹配不到
          if (e.seq === ownSeq) for (const seq of state.seqs) add({ seq })
          return
        }
        case 'tool.started': {
          const t = turnIndex(e)
          const q = e.payload as { callId?: string; argsPreview?: unknown }
          if (t && q.callId !== undefined) t.calls.set(q.callId, { ...t.calls.get(q.callId), started: e.seq })
          // 预览被截过,可能只剩半句:args 里有就算
          const previewQuotes = !whole && typeof q.argsPreview === 'string' && inScope(session) && quoted(q.argsPreview)
          if (previewQuotes || (q.callId !== undefined && t?.calls.get(q.callId)?.quotes)) {
            add({ seq: e.seq })
            noteSaw(session)
          }
          return
        }
        case 'tool.ended': {
          const q = e.payload as { name?: string; callId?: string }
          const content = textField(e)
          if (content === undefined || content === REDACTED) return
          const callId = q.callId ?? ''
          if (q.name === 'memory_write') {
            if (!named(content)) return
            if (session !== undefined) saw.add(session)
            const call = turnIndex(e)?.calls.get(callId)
            if (call?.started !== undefined) add({ seq: call.started })
            if (call?.assistant !== undefined) {
              add({ seq: call.assistant, callId })
              // callId 只碰 args;这一步的正文和思考可能也引用了它
              for (const needle of stepNeedles) add({ seq: call.assistant, needle })
              const state = call.step === undefined ? undefined : turnIndex(e)?.steps.get(call.step)
              if (state?.quotes) for (const seq of state.seqs) add({ seq })
            }
          } else if (q.name === 'memory_search' || q.name === 'memory_get') {
            const spilled = findSpill(e, callId, q.name, body => named(body) || quoted(body))
            if (spilled || named(content) || (inScope(session) && quoted(content))) {
              add({ seq: e.seq })
              if (session !== undefined) saw.add(session)
            }
          } else if (!whole && inScope(session)) {
            // 别的工具的输出(read、shell):只换引用的地方,其余是用户的记录。落盘的全文整个文件删,标记留着
            const spilled = q.name !== undefined && findSpill(e, callId, q.name, quoted)
            for (const needle of needles) if (content.includes(needle)) add({ seq: e.seq, needle })
            if (spilled || quoted(content)) noteSaw(session)
          }
          return
        }
        case 'executor.notice': {
          const text = textField(e)
          if (whole || text === undefined || text === REDACTED || !inScope(session)) return
          for (const needle of needles) if (text.includes(needle)) add({ seq: e.seq, needle })
          if (quoted(text)) noteSaw(session)
          return
        }
        case 'message.user': {
          if (!whole && inScope(session) && quoted(textField(e) ?? '')) {
            quotedBy.add(e.seq)
            noteSaw(session)
          }
          return
        }
        case 'memory.injected': {
          const q = e.payload as { text?: unknown; items?: unknown }
          if (typeof q.text !== 'string' || q.text === REDACTED) return
          const byId = Array.isArray(q.items) && q.items.some(i => listed.has(i as string))
          const literal = inScope(session) && needles.some(n => (q.text as string).includes(n))
          if (!byId && !literal) return
          if (session !== undefined) saw.add(session)
          // 短文本只能整段:pnpm 会连带别的行,notes 会碰到标签。摘录里没有全文时也是整段。
          // 删会话时按 id 点到的块也整段:不知道是哪一行的原话
          const hits = datas.filter(x => (q.text as string).includes(x) && !FRAMES.includes(x))
          const usable = hits.length > 0 && !(whole && byId)
          if (usable) for (const needle of hits) add({ seq: e.seq, needle })
          else add({ seq: e.seq })
          return
        }
        case 'memory.checkpoint': {
          const text = textField(e)
          if (text === undefined || text === REDACTED) return
          checkpoints.push({ seq: e.seq, ...(session !== undefined && { sessionId: session }), literal: long && datas.some(x => text.includes(x)) })
          return
        }
      }
    }

    for (let cursor = 0; ; ) {
      const page = ctx.events.after(cursor, PAGE)
      if (page.length === 0) break
      for (const e of page) visit(e)
      cursor = page[page.length - 1].seq
      if (page.length === PAGE) {
        await nextTick()
        alive()
      }
    }
    for (const run of namedRuns) for (const seq of progress.get(run) ?? []) add({ seq })
    // 摘要可能转述,定位不了:看过的会话整份作废,退回折叠
    for (const c of checkpoints) if (c.literal || (c.sessionId !== undefined && saw.has(c.sessionId))) add({ seq: c.seq })
    // 删会话:它自己的事件下一步整个抹掉,这里不换
    return { edits: [...edits.values()].filter(x => !ownSession.has(x.seq)), spills: [...spills], quotedBy: [...quotedBy] }
  }

  /** 第 1 到 5 步。进度留着,等 finish 清盘 */
  async function removeEntry(id: string): Promise<{ redacted: number; sources: string[] }> {
    await settled()
    alive()
    const resumed = load(id) !== undefined
    const p = load(id) ?? begin(id)
    if (!p) throw notFound() // 什么都不碰:不写墓碑、不扫日志、不重写库
    save(p) // 第一件事:下面任何一步失败,文本都还在

    if (p.swept !== true) {
      alive()
      // 第 1 步:记忆层
      step('deleted')
      if (RAW_ID.test(id)) {
        files.removeBadCopies()
      } else {
        const gone = files.deleteEntry(id, p.text)
        p.text ??= gone.text
        p.evidence = [...new Set([...p.evidence, ...gone.evidence])]
        p.removedIds = [...new Set([...p.removedIds, ...gone.removedIds])]
        // 连带删掉的 id 和证据只有这一次机会拿到:行已经没了,重试时靠它们找 memory_write 和证据行
        if (p.text !== undefined) save(p)
        if (p.text !== undefined) forget(store, p.text)
        for (const text of gone.alsoForget ?? []) forget(store, text)
      }

      // 第 2 步:原始层。先记下再删,删完就再也扫不出来了
      step('raw')
      // 证据写在行尾注释里,编辑器能改:只认同范围里用户自己说的话,否则一条笔记能牵连任何一行
      const evidence = p.evidence.flatMap(e => {
        const seq = RAW_ID.exec(e)?.[1]
        const row = seq === undefined ? undefined : store.getRaw(Number(seq))
        return row && row.scope === p.scope && row.role === 'user' ? [row.seq] : []
      })
      const literal = !RAW_ID.test(id) && p.text !== undefined && p.scope !== undefined && codePoints(p.text) >= LITERAL_MIN ? store.rawSeqsHolding(p.text, p.scope) : []
      p.rawSeqs = [...new Set([...p.rawSeqs, ...evidence, ...literal])]
      if (p.text !== undefined || p.rawSeqs.length > 0) save(p)
      files.removeDerived(p.rawSeqs.map(seq => `r_${seq}`), ({ notes, others, kept }) => {
        // 按 id 换掉召回过、搜到过这些草稿行的载荷
        p.removedIds = [...new Set([...p.removedIds, ...notes])]
        p.derived = [...new Set([...(p.derived ?? []), ...notes, ...others, ...kept])].filter(x => x !== id)
        save(p)
      })
      store.deleteRaw(p.rawSeqs)

      // 第 3 步:墓碑。从日志重建时删过的不回来
      if (p.tombstoneSeq === undefined) tombstone(p)

      // 第 4、5 步:召回过的载荷、点名的那条消息
      const { edits, spills, quotedBy } = await sweep(p, resumed)
      alive()
      p.spills = [...new Set([...(p.spills ?? []), ...spills])]
      if (p.spills.length > 0) save(p)
      step('redact')
      p.redacted = ctx.events.redact(edits)
      for (const file of p.spills) rmSync(file, { force: true })
      p.sources = [...sourcesOf(p, quotedBy), ...(p.derived ?? [])]
      if (RAW_ID.test(id)) ctx.append({ type: 'memory.updated', payload: { id, op: 'delete', source: 'user' } })
      p.swept = true
      save(p)
    }

    // 文本从进度里拿掉,否则它自己就留在库里
    delete p.text
    save(p)
    return { redacted: p.redacted ?? 0, sources: p.sources ?? [] }
  }

  /** 第 6 步:落盘。什么都没动的 id 不用重写事件库。进度最后才清,这一步失败还能重试 */
  async function finish(ids: string[]): Promise<void> {
    const touched = ids.filter(id => load(id) !== undefined)
    step('purge')
    if (touched.length === 0) return
    // optimize 也是同步的,库大了一样会让监管以为卡死:放进同一段要来的时间
    try {
      await ctx.events.purge({
        extraBytes: statSync(d.dbFile, { throwIfNoEntry: false })?.size ?? 0,
        then: () => {
          store.purge()
          for (const id of touched) store.deleteMeta(keyOf(id))
          store.purge()
        },
      })
    } catch (err) {
      if ((err as { errcode?: unknown }).errcode === SQLITE_FULL) throw new RpcError(INTERNAL, 'not enough disk space to finish the delete: it needs about twice the event log, in the data directory and TMPDIR')
      throw err
    }
  }

  /** 记下了要去掉这一行,文件却没写成(写之前崩溃):这行还在,不是删除。已经开始删的不在此列 */
  const notStarted = (p: PendingPurge) => p.file !== undefined && p.tombstoneSeq === undefined && p.swept !== true && p.text !== undefined && files.holdsText(p.text)

  function pendingRecords(): PendingPurge[] {
    const records = store.metaWithPrefix(PENDING).map(r => JSON.parse(r.value) as PendingPurge)
    return records.filter(p => {
      if (!notStarted(p)) return true
      store.deleteMeta(keyOf(p.id))
      return false
    })
  }

  /** 记一笔"这之后有删除":摘要的模型调用在删除期间回来,写下来之前按它作废(checkpoints.ts stale) */
  const noteDelete = () => store.setMeta('lastDeleteSeq', String(lastSeqOf((seq, limit) => ctx.events.after(seq, limit))))

  /**
   * session.delete(08 §4.3)。1 未合并检查 → 2 内核墓碑(同步:忙就 -32003)→ 3 这个会话的原始行按 r_ 的规则清 → 4 整会话抹除 → 5 一次落盘。
   * 进度在 purge:session:<id>,墓碑之前就写下,所以 deleteInFlight 从这一刻起为真;3–5 可重做,resumeAll 接着做
   */
  async function deleteSession(sessionId: string, discard: string[]): Promise<{ ok: true; redacted: number; notes: string[] }> {
    alive()
    const id = `session:${sessionId}`
    let p = load(id)
    if (p && !sessions.isDeleted(sessionId)) {
      // 上次记下了、墓碑没写成:那次删除没发生,从头来
      forgetRecord(id)
      p = undefined
    }
    if (!p) {
      if (!sessions.get(sessionId)) throw new RpcError(INVALID_PARAMS, 'unknown session')
      if (sessions.isDeleted(sessionId)) return { ok: true, redacted: 0, notes: [] } // 早就删完了
      const commands = ctx.services.get<SessionCommands>('sessionCommands')
      if (!commands) throw new RpcError(INTERNAL, 'session commands unavailable')
      const executors = ctx.services.get<BackgroundRuns>('executors')
      // 活着的运行查到一半会结束,它的改动就不在查过的那批里(评审 I1):一上来就忙
      if ((executors?.liveFor?.(sessionId) ?? 0) > 0) throw new RpcError(ERR_BUSY, 'runs in progress')
      // 第 1 步:列出来的才丢(R2、评审 I2):discardUnmerged 要点名每一个。确认框可能是旧的,这里重新查
      const checked = executors?.retainedFor?.(sessionId) ?? []
      const runs = (await executors?.unmergedFor?.(sessionId)) ?? []
      alive()
      const named = new Set(discard)
      if (runs.some(r => !named.has(r.runId))) throw new RpcError(INVALID_PARAMS, 'unmerged', { reason: 'unmerged', runs })
      // 查的时候冒出来的 worktree 没人看过:不丢,让用户再看一次
      const seen = new Set([...checked, ...runs.map(r => r.runId)])
      if ((executors?.retainedFor?.(sessionId) ?? []).some(runId => !seen.has(runId))) throw new RpcError(ERR_BUSY, 'worktrees changed')
      // 第 2 步:进度先落,再立墓碑,中间没有 await。墓碑写不成(忙、未知)就把进度撤掉,什么都没动
      p = { id, kind: 'session', sessionId, evidence: [], removedIds: [], rawSeqs: [] }
      save(p)
      try {
        commands.markDeleted(sessionId)
      } catch (err) {
        forgetRecord(id)
        throw err
      }
      noteDelete()
    }
    const result = await removeSession(p)
    await finish([id])
    return { ok: true, ...result }
  }

  /** 第 3、4 步。进度留着,等 finish 清盘 */
  async function removeSession(p: PendingPurge): Promise<{ redacted: number; notes: string[] }> {
    const sessionId = p.sessionId as string
    const resumed = p.rawDone === true || p.tombstoneSeq !== undefined
    await settled() // 这个会话的每一条都进了原始层,才知道要删哪些行
    alive()
    if (p.swept !== true) {
      if (p.rawDone !== true) {
        step('raw')
        if (p.rawIds === undefined) {
          const rows = store.rawOfSession(sessionId)
          const seqs = new Set(rows.map(r => r.seq))
          for (const e of ctx.events.history(sessionId)) if (NAMEABLE.has(e.type)) seqs.add(e.seq)
          p.rawSeqs = [...seqs].sort((a, b) => a - b)
          p.rawIds = p.rawSeqs.map(seq => `r_${seq}`)
          p.rawTexts = rows.map(r => [r.seq, r.text])
          p.scope = rows[0]?.scope ?? scopeOf(sessions.get(sessionId)).read[0] ?? `session:${sessionId}`
          save(p)
        }
        if (p.turnIds === undefined) {
          p.turnIds = [...new Set(ctx.events.history(sessionId).flatMap(e => (typeof turnOf(e) === 'string' ? [turnOf(e) as string] : [])))]
          save(p)
        }
        files.removeBadCopies()
        // 这些轮里 memory_write 写的(草稿、提议):按 turn_id,和回滚一样。文本记下,召回过它们的块按 id 和原文换掉(评审 C1)
        files.removeTurns(p.turnIds, ({ ids, texts }) => {
          p.removedIds = [...new Set([...p.removedIds, ...ids])]
          p.rawTexts = [...(p.rawTexts ?? []), ...texts.filter(t => !(p.rawTexts ?? []).some(([, x]) => x === t)).map((t): [number, string] => [0, t])]
          p.derived = [...new Set([...(p.derived ?? []), ...ids])]
          save(p)
        })
        for (const t of (p.rawTexts ?? []).filter(([seq]) => seq === 0).map(([, t]) => t)) forget(store, t)
        // 草稿行、候选、等回答的提议一起删;核心文件里引用它的不动,列给用户(notes)
        files.removeDerived(p.rawIds, ({ notes, others, kept }) => {
          p.removedIds = [...new Set([...p.removedIds, ...notes])]
          p.derived = [...new Set([...(p.derived ?? []), ...notes, ...others])]
          p.notes = [...new Set([...(p.notes ?? []), ...kept.filter(k => k.startsWith('n_'))])]
          save(p)
        })
        p.notes ??= []
        // 一片一片删,片之间让出事件循环;整段先向监管要时间(评审 I3)。重做时已删的行删了也是空操作
        const slice = d.rawDeleteSlice ?? RAW_SLICE
        const seqs = p.rawSeqs
        await ctx.events.withHold(purgeHoldMs(statSync(d.dbFile, { throwIfNoEntry: false })?.size ?? 0), async () => {
          for (let i = 0; i < seqs.length; i += slice) {
            if (i > 0) {
              await nextTick()
              alive()
            }
            store.deleteRaw(seqs.slice(i, i + slice))
          }
        })
        p.rawDone = true
        save(p)
      }
      if (p.tombstoneSeq === undefined) tombstone(p)
      if (p.redactDone !== true) {
        // 别的会话里的副本:召回块、记忆工具的结果、看过它的摘要
        const { edits, spills } = await sweep(p, resumed)
        alive()
        p.spills = [...new Set([...(p.spills ?? []), ...spills])]
        if (p.spills.length > 0) save(p)
        step('redact')
        p.redacted = ctx.events.redact(edits)
        p.redactDone = true
        save(p)
        for (const file of p.spills) rmSync(file, { force: true })
      }
      if (p.erased !== true) {
        step('erase')
        p.erasedRows = await ctx.events.eraseSession(sessionId)
        p.erased = true
        save(p)
      }
      p.swept = true
    }
    // 文本从进度里拿掉,否则它自己就留在库里
    delete p.rawTexts
    save(p)
    return { redacted: (p.redacted ?? 0) + (p.erasedRows ?? 0), notes: p.notes ?? [] }
  }

  /** memory.deleteMany:逐个走 1–5 步,最后一次落盘。查不到的进 gone */
  async function deleteMany(ids: string[]): Promise<{ ok: true; redacted: number; sources: string[]; gone: string[] }> {
    const gone: string[] = []
    const done: string[] = []
    const sources = new Set<string>()
    let redacted = 0
    for (const id of [...new Set(ids)]) {
      alive()
      try {
        const r = await removeEntry(id)
        redacted += r.redacted
        for (const src of r.sources) sources.add(src)
        done.push(id)
      } catch (err) {
        if (err instanceof RpcError && err.code === INVALID_PARAMS && err.message === 'not found') gone.push(id)
        else throw err
      }
    }
    await finish(done)
    return { ok: true, redacted, sources: [...sources].filter(src => !done.includes(src)), gone }
  }

  /** 有上限:一次启动最多这么多条,每条最多试 MAX_RESUMES 次,之后只报在 health 里,等客户端重试 */
  async function resumeAll(): Promise<void> {
    const due = pendingRecords().filter(p => (p.resumes ?? 0) < MAX_RESUMES).slice(0, RESUME_BATCH)
    if (due.length === 0) return
    // 先记次数再动手:动手的时候进程没了也算一次
    for (const p of due) save({ ...p, resumes: (p.resumes ?? 0) + 1 })
    const done: string[] = []
    for (const p of due) {
      alive()
      try {
        if (p.kind === 'session') {
          // 墓碑没写成的那次删除没发生:记录撤掉,不替用户删
          if (!sessions.isDeleted(p.sessionId as string)) {
            forgetRecord(p.id)
            continue
          }
          await removeSession(load(p.id) ?? p)
        } else await removeEntry(p.id)
        done.push(p.id)
      } catch (err) {
        if (err instanceof RpcError && err.message === 'memory is closing') throw err
        ctx.log.error('memory delete resume failed', { id: p.id, error: err instanceof Error ? err.name : 'unknown' })
      }
    }
    await finish(done)
  }

  function forgetRecord(id: string): void {
    store.deleteMeta(keyOf(id))
  }

  async function purgeEntry(id: string): Promise<{ redacted: number; sources: string[] }> {
    const result = await removeEntry(id)
    await finish([id])
    return result
  }

  return {
    purgeEntry,
    deleteSession,
    deleteMany,
    removeEntry,
    finish,
    resumeAll,
    /** memory.file.set:写文件之前 */
    remember: (p: PendingPurge) => save(p),
    forget: (id: string) => store.deleteMeta(keyOf(id)),
    pendingForFile: (file: string) => pendingRecords().filter(p => p.file === file).map(p => p.id),
  }
}
