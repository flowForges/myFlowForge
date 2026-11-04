// 事件 → 原始层(06 spec §5)。只有一条路径:从日志拉。onAppend 只记"有新事件",不缓存事件,
// 所以追赶途中到的事件不会把游标顶过缺口
import type { Logger } from '../../kernel/log'
import type { SessionInfo } from '../../kernel/sessions'
import { clip } from '../../lib/tools/diagnostics'
import { scrub } from '../../lib/memory/scrub'
import type { KernelEvent } from '../../protocol/events'
import { CONSOLIDATION_CURSOR, type RawRole, type Store } from './store'

const BATCH = 500
const WAKE_AFTER = 200
const FLUSH_MS = 250
const CLIP_MESSAGE = 16_000
const CLIP_TOOL = 4_000
const FAILING = 'ingest is failing, see the log'

export interface IngestTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_TIMERS: IngestTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: h => clearTimeout(h as NodeJS.Timeout),
}

export interface IngestDeps {
  store: Store
  events: { after(seq: number, limit: number): KernelEvent[]; onAppend(cb: (e: KernelEvent) => void): () => void }
  sessions: { get(id: string): SessionInfo | undefined }
  /** 受众规则只有一处(policy.ts);这里只要它的读范围 */
  scopeOf(session: SessionInfo | undefined): { read: string[] }
  /** 和这一批同一个事务:抛错只记日志 */
  onRolledBack?(turnId: string): void
  timers?: IngestTimers
  flushMs?: number
  log: Pick<Logger, 'error'>
}

/** after(x, 1) 有结果 ⇔ x 小于最后一个 seq。倍增加二分,不用把整个日志读一遍 */
function lastSeqOf(after: IngestDeps['events']['after']): number {
  const more = (seq: number) => after(seq, 1).length > 0
  if (!more(0)) return 0
  let low = 0
  let high = 1
  while (more(high)) {
    low = high
    high *= 2
  }
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)
    if (more(mid)) low = mid
    else high = mid
  }
  return high
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

export class Ingest {
  private off?: () => void
  private timer?: unknown
  private immediate?: NodeJS.Immediate
  private dirty = 0
  private stopped = false
  private failing = false
  private timers: IngestTimers
  private flushMs: number

  constructor(private deps: IngestDeps) {
    this.timers = deps.timers ?? REAL_TIMERS
    this.flushMs = deps.flushMs ?? FLUSH_MS
  }

  start(): void {
    const { store, events } = this.deps
    // 新库:原始层从头回填是本地的,提取不追溯,否则第一晚把全部历史发给模型(spec §5)
    if (store.getMeta(CONSOLIDATION_CURSOR) === undefined) store.setMeta(CONSOLIDATION_CURSOR, String(lastSeqOf(events.after)))
    this.off = events.onAppend(() => this.wake())
    this.schedule()
  }

  /** 拉到追上为止;在调用方的栈上跑 */
  flush(): void {
    this.cancel()
    while (!this.stopped && this.pull() === BATCH);
  }

  /** 拉最后一批,剩下的下次启动追 */
  stop(): void {
    if (this.stopped) return
    this.off?.()
    this.cancel()
    this.pull()
    this.stopped = true
  }

  /** 在写入方的栈上,不做 I/O */
  private wake(): void {
    if (this.stopped || this.immediate) return
    if (++this.dirty >= WAKE_AFTER) this.schedule()
    else if (this.timer === undefined) this.timer = this.timers.setTimeout(this.tick, this.flushMs)
  }

  private schedule(): void {
    this.cancel()
    this.immediate = setImmediate(this.tick)
  }

  private cancel(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
    if (this.immediate) clearImmediate(this.immediate)
    this.timer = undefined
    this.immediate = undefined
    this.dirty = 0
  }

  private tick = (): void => {
    this.cancel()
    if (!this.stopped && this.pull() === BATCH) this.schedule()
  }

  /** 一批和游标同一个事务。失败不重排:下一条新事件或 flush 再试,坏盘上不空转 */
  private pull(): number {
    const { store, events, log } = this.deps
    try {
      const batch = events.after(store.cursor(), BATCH)
      if (batch.length === 0) return 0
      store.transaction(() => {
        for (const e of batch) this.apply(e)
        store.setCursor(batch[batch.length - 1].seq)
      })
      if (this.failing) {
        this.failing = false
        store.problems.splice(store.problems.indexOf(FAILING), 1)
      }
      return batch.length
    } catch (err) {
      log.error('memory ingest failed', { error: err instanceof Error ? err.message : String(err) })
      if (!this.failing) {
        this.failing = true
        store.problems.push(FAILING)
      }
      return 0
    }
  }

  private apply(e: KernelEvent): void {
    const p = (e.payload ?? {}) as Record<string, unknown>
    switch (e.type) {
      case 'message.user':
        return this.row(e, 'user', p.text, CLIP_MESSAGE)
      case 'message.assistant':
        return this.row(e, 'assistant', p.text, CLIP_MESSAGE)
      case 'executor.notice':
        return this.row(e, 'notice', p.text, CLIP_TOOL)
      case 'tool.ended': {
        const name = str(p.name)
        if (name?.startsWith('memory_')) return // 结果里的东西已经在库里了
        return this.row(e, 'tool', p.content, CLIP_TOOL, name)
      }
      case 'turn.rolledBack': {
        const turnId = str(p.turnId)
        if (turnId) this.rolledBack(turnId)
        return
      }
      case 'memory.deleted':
        if (Array.isArray(p.rawSeqs)) this.deps.store.deleteRaw(p.rawSeqs.filter((s): s is number => typeof s === 'number'))
        return
    }
  }

  private rolledBack(turnId: string): void {
    const { store, onRolledBack, log } = this.deps
    store.markRolledBack(turnId)
    try {
      onRolledBack?.(turnId)
    } catch (err) {
      // 这一步坏了不能卡住接入:卡住之后所有新消息都进不来
      log.error('memory rollback hook failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 先打码再截断:半个密钥认不出。role、scope、origin 只来自事件和会话,模型碰不到 */
  private row(e: KernelEvent, role: RawRole, raw: unknown, max: number, tool?: string): void {
    if (typeof raw !== 'string' || !e.sessionId) return
    const text = clip(scrub(raw).text, max)
    if (text.trim() === '') return
    const { store, sessions, scopeOf } = this.deps
    const session = sessions.get(e.sessionId)
    const turnId = str((e.payload as { turnId?: unknown }).turnId)
    store.insertRaw({
      seq: e.seq,
      ts: e.ts,
      sessionId: e.sessionId,
      ...(turnId !== undefined && { turnId }),
      role,
      ...(tool !== undefined && { tool: scrub(tool).text }),
      origin: session?.origin ?? 'unknown',
      // 不认识的会话 read 是空的:只给它自己,绝不当 owner
      scope: scopeOf(session).read[0] ?? `session:${e.sessionId}`,
      ...(session?.model?.accountId !== undefined && { accountId: session.model.accountId }),
      text,
    })
  }
}
