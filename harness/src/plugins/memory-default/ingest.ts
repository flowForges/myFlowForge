// 事件 → 原始层(06 spec §5)。只有一条路径:从日志拉。onAppend 只记"有新事件",不缓存事件,
// 所以追赶途中到的事件不会把游标顶过缺口
import type { Logger } from '../../kernel/log'
import type { SessionInfo } from '../../kernel/sessions'
import { clip } from '../../lib/tools/diagnostics'
import { scrub } from '../../lib/memory/scrub'
import type { KernelEvent } from '../../protocol/events'
import { CONSOLIDATION_CURSOR, damaged, type RawRole, type Store } from './store'

const BATCH = 500
/** 带时间上限的追赶一次拉这么多:一条大的工具结果要几毫秒,500 条一个事务就是几秒,整个内核都在等 */
const SLICE = 10
/** 轮的开头和工具调用最多替接入干这么久;剩下的不在它们的栈上 */
const CATCH_UP_MS = 200
const TICK_MS = 25
const WAKE_AFTER = 200
const FLUSH_MS = 250
const CLIP_MESSAGE = 16_000
const CLIP_TOOL = 4_000
const FAILING = 'ingest_failing'
/** 文件中段坏了打开时看不出来,只有读写到那一页才报:health 要能说出来 */
const CORRUPT = 'db_corrupt'
const SKIPPED = 'ingest_skipped_events'
// 这几种 SQLite 错误只和这一行有关:TOOBIG、CONSTRAINT、MISMATCH、RANGE
const SQLITE_ROW_FAULTS = new Set([18, 19, 20, 25])

/** 库本身的问题(满了、锁了、坏了)每条都会抛,不能算到事件头上:逐条跳过会把后面的全部丢掉 */
function faultOfEvent(err: unknown): boolean {
  const code = (err as { errcode?: unknown }).errcode
  return typeof code !== 'number' || SQLITE_ROW_FAULTS.has(code & 0xff)
}

/** SQLite 的报错只提表和约束;别的错误可能引用事件内容(JSON.parse 带原文片段),只留类型 */
function safeMessage(err: unknown): string {
  if (typeof (err as { errcode?: unknown }).errcode === 'number') return (err as Error).message
  return err instanceof Error ? err.name : 'unknown'
}

export interface IngestTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const REAL_TIMERS: IngestTimers = {
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
  /** 和这一批同一个事务:重放不重复 */
  countHabit?(e: KernelEvent, session: SessionInfo, ts: number): void
  timers?: IngestTimers
  flushMs?: number
  log: Pick<Logger, 'error'>
  /** 单调时钟,毫秒;测试注入 */
  clock?(): number
}

/** after(x, 1) 有结果 ⇔ x 小于最后一个 seq。倍增加二分,不用把整个日志读一遍 */
export function lastSeqOf(after: IngestDeps['events']['after']): number {
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

  /**
   * 有上限地追,返回追上了没有。没追上时剩下的走后台批次,不占调用方的栈。
   * 追不上的时候原始层不可信:后面可能有这些行的回滚或删除墓碑,所以调用方这时不读 raw
   */
  catchUp(budgetMs = CATCH_UP_MS): boolean {
    if (this.stopped) return false
    this.cancel()
    if (this.runFor(budgetMs)) this.schedule()
    return this.deps.events.after(this.deps.store.cursor(), 1).length === 0
  }

  /** 最后再追一会儿,剩下的下次启动追。按时间不按行数:500 条大事件要好几秒,关停时监管不会一直等 */
  stop(): void {
    if (this.stopped) return
    this.off?.()
    this.cancel()
    this.runFor(CATCH_UP_MS)
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
    if (!this.stopped && this.runFor(TICK_MS)) this.schedule()
  }

  /** 一小批一小批地拉,下一批估计放不下就停。返回是不是还有没拉的;失败算没有,不空转 */
  private runFor(budgetMs: number): boolean {
    const clock = this.deps.clock ?? (() => performance.now())
    const start = clock()
    let last = start
    for (;;) {
      if (this.pull(SLICE) < SLICE) return false
      const now = clock()
      if (now - start + (now - last) >= budgetMs) return true
      last = now
    }
  }

  /** 一批和游标同一个事务。失败不重排:下一条新事件或 flush 再试,坏盘上不空转 */
  private pull(limit = BATCH): number {
    const { store, events, log } = this.deps
    try {
      const batch = events.after(store.cursor(), limit)
      if (batch.length === 0) return 0
      try {
        store.transaction(() => {
          for (const e of batch) this.apply(e)
          store.setCursor(batch[batch.length - 1].seq)
        })
      } catch (err) {
        if (!faultOfEvent(err)) throw err
        this.applyEach(batch)
      }
      if (this.failing) {
        this.failing = false
        this.setProblems(false, false)
      }
      return batch.length
    } catch (err) {
      log.error('memory ingest failed', { error: safeMessage(err) })
      this.failing = true
      this.setProblems(true, damaged(err))
      return 0
    }
  }

  private setProblems(failing: boolean, corrupt: boolean): void {
    const { problems } = this.deps.store
    for (const [code, on] of [[FAILING, failing], [CORRUPT, corrupt]] as const) {
      const at = problems.indexOf(code)
      if (on && at < 0) problems.push(code)
      if (!on && at >= 0) problems.splice(at, 1)
    }
  }

  /** 一条坏事件不能让整批永远回滚:逐条再来,跳过它,游标照走。之前试过的已回滚,回滚钩子会再跑一次 */
  private applyEach(batch: KernelEvent[]): void {
    const { store, log } = this.deps
    for (const e of batch) {
      try {
        store.transaction(() => {
          this.apply(e)
          store.setCursor(e.seq)
        })
      } catch (err) {
        if (!faultOfEvent(err)) throw err
        log.error('memory ingest skipped a bad event', { seq: e.seq, kind: e.type })
        if (!store.problems.includes(SKIPPED)) store.problems.push(SKIPPED)
        store.setCursor(e.seq)
      }
    }
  }

  private apply(e: KernelEvent): void {
    const p = (e.payload ?? {}) as Record<string, unknown>
    switch (e.type) {
      case 'message.user': {
        const session = e.sessionId ? this.deps.sessions.get(e.sessionId) : undefined
        if (session) this.deps.countHabit?.(e, session, e.ts)
        return this.row(e, 'user', p.text, CLIP_MESSAGE)
      }
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
      log.error('memory rollback hook failed', { error: safeMessage(err) })
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
