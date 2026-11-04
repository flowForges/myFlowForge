import { DatabaseSync } from 'node:sqlite'
import type { KernelEvent } from '../protocol/index'

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS events(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, session_id TEXT, payload TEXT);
  CREATE TABLE IF NOT EXISTS receipts(
    command_id TEXT PRIMARY KEY, method TEXT, result TEXT, ts INTEGER);`)
  return db
}

type Written = { log: EventLog; event: KernelEvent }

// 每个 db 一个待发通知队列:事务内的通知等 COMMIT 后再发,ROLLBACK 则丢弃
const pending = new WeakMap<DatabaseSync, Written[]>()

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (pending.has(db)) return fn() // 嵌套:并入外层事务
  const queue: Written[] = []
  db.exec('BEGIN IMMEDIATE') // 失败则不登记 pending
  pending.set(db, queue)
  let result: T
  try {
    result = fn()
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* 已无事务 */ }
    pending.delete(db)
    throw err
  }
  pending.delete(db)
  // 先全部排队再发:监听者这时写的事件 seq 更大,要排在这一批后面
  for (const w of queue) w.log.enqueue(w.event)
  for (const w of queue) w.log.deliver()
  return result
}

type Row = { seq: number; ts: number; type: string; session_id: string | null; payload: string }

function toEvent(r: Row): KernelEvent {
  const e: KernelEvent = { seq: r.seq, ts: r.ts, type: r.type as KernelEvent['type'], payload: JSON.parse(r.payload) }
  if (r.session_id !== null) e.sessionId = r.session_id
  return e
}

/** 用户删除记忆时,白名单字段里的文本换成它(06 spec §16) */
export const REDACTED = '[已删除]'
const REDACTED_ARGS = '{"redacted":true}'

/** 可以就地替换的事件和字段;别的事件类型一律抛错。message.assistant 另外处理 parts */
const REDACTABLE = new Map<string, string>([
  ['memory.injected', 'text'],
  ['memory.checkpoint', 'text'],
  ['tool.ended', 'content'],
  ['tool.started', 'argsPreview'],
  ['message.user', 'text'],
  ['message.assistant', 'text'],
  ['message.assistant.delta', 'text'],
  ['message.reasoning.delta', 'text'],
  ['executor.notice', 'text'],
  ['executor.run.progress', 'text'],
])

export interface RedactEdit {
  seq: number
  /** 只换字面出现的地方;不给 = 换整个字段 */
  needle?: string
  /** 只有 message.assistant:只把这个工具调用的 args 换掉,别的都不动。不能和 needle 同时给 */
  callId?: string
}

/** args、replay 里的文本是 JSON 转义过的:中文可能写成 \uXXXX,引号带反斜杠,字面比较找不到 */
export function jsonHolds(json: string, needle: string): boolean {
  if (json.includes(needle)) return true
  try {
    return JSON.stringify(JSON.parse(json)).includes(JSON.stringify(needle).slice(1, -1))
  } catch {
    return false
  }
}

/** 就地改 payload;返回有没有变。所以重做一遍是空操作 */
function redactPayload(type: string, p: Record<string, unknown>, edit: RedactEdit): boolean {
  const { needle, callId } = edit
  const parts: Record<string, unknown>[] = type === 'message.assistant' && Array.isArray(p.parts) ? p.parts : []
  let changed = false
  const blankArgs = (part: Record<string, unknown>) => {
    if (part.args === REDACTED_ARGS) return
    part.args = REDACTED_ARGS
    changed = true
  }
  if (callId !== undefined) {
    for (const part of parts) if (part.type === 'tool_call' && part.id === callId) blankArgs(part)
    return changed
  }
  const swap = (owner: Record<string, unknown>, field: string) => {
    const old = owner[field]
    if (typeof old !== 'string') return
    // 针是占位符的一部分时只能整段换:否则重做一遍会在占位符里面再换一次
    const whole = needle === undefined || (REDACTED.includes(needle) && old.includes(needle))
    const next = whole ? REDACTED : old.split(needle).join(REDACTED)
    if (next === old) return
    owner[field] = next
    changed = true
  }
  swap(p, REDACTABLE.get(type)!)
  for (const part of parts) {
    swap(part, 'text')
    // args 是 JSON,只能整个换,否则可能不再合法
    if (part.type === 'tool_call' && typeof part.args === 'string' && (needle === undefined || jsonHolds(part.args, needle))) blankArgs(part)
    // replay 就是明文思考(thinking、reasoning_content、summary),history 会原样发回同一模型;带签名,不能只换一段
    if (part.type === 'reasoning' && part.replay !== undefined && (needle === undefined || jsonHolds(JSON.stringify(part.replay), needle))) {
      delete part.replay
      changed = true
    }
  }
  if (type === 'memory.checkpoint' && p.text === REDACTED && p.redacted !== true) {
    p.redacted = true
    changed = true
  }
  return changed
}

export class EventLog {
  private listeners = new Set<(e: KernelEvent) => void>()
  private outbox: KernelEvent[] = []
  private delivering = false
  private insert
  private afterStmt
  private tailStmt
  private lastStmt
  private sessionStmt
  private seqStmt
  private updateStmt

  constructor(
    private db: DatabaseSync,
    private opts: { onListenerError?: (err: unknown) => void; onWarn?: (message: string) => void } = {},
  ) {
    this.insert = db.prepare('INSERT INTO events(ts, type, session_id, payload) VALUES (?, ?, ?, ?)')
    this.afterStmt = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?')
    this.tailStmt = db.prepare('SELECT * FROM (SELECT * FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq')
    this.sessionStmt = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq')
    this.lastStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events')
    this.seqStmt = db.prepare('SELECT type, payload FROM events WHERE seq = ?')
    this.updateStmt = db.prepare('UPDATE events SET payload = ? WHERE seq = ?')
  }

  append(e: Omit<KernelEvent, 'seq' | 'ts'>): KernelEvent {
    const ts = Date.now()
    const info = this.insert.run(ts, e.type, e.sessionId ?? null, JSON.stringify(e.payload ?? null))
    const ev: KernelEvent = { ...e, seq: Number(info.lastInsertRowid), ts }
    const queue = pending.get(this.db)
    if (queue) queue.push({ log: this, event: ev })
    else {
      this.enqueue(ev)
      this.deliver()
    }
    return ev
  }

  /** 给 transaction 用 */
  enqueue(e: KernelEvent): void {
    this.outbox.push(e)
  }

  /** 按 seq 发,不重入:监听者里写的事件等当前这条发完。否则它先到游标型订阅者(rpcServer),当前这条被当成旧的丢掉 */
  deliver(): void {
    if (this.delivering) return
    this.delivering = true
    try {
      for (let e = this.outbox.shift(); e; e = this.outbox.shift()) {
        for (const l of [...this.listeners]) {
          try {
            l(e)
          } catch (err) {
            try { this.opts.onListenerError?.(err) } catch { /* 忽略 */ }
          }
        }
      }
    } finally {
      this.delivering = false
    }
  }

  after(seq: number, limit = -1): KernelEvent[] {
    return (this.afterStmt.all(seq, limit) as Row[]).map(toEvent)
  }

  /** 某会话的全部事件(seq 升序) */
  bySession(sessionId: string): KernelEvent[] {
    return (this.sessionStmt.all(sessionId) as Row[]).map(toEvent)
  }

  tail(limit: number): KernelEvent[] {
    return (this.tailStmt.all(limit) as Row[]).map(toEvent)
  }

  lastSeq(): number {
    return (this.lastStmt.get() as { s: number }).s
  }

  onAppend(cb: (e: KernelEvent) => void): () => void {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  /**
   * "只追加"唯一的窄口子(06 spec §16):不删行、不插行,seq、ts、type、session 和别的键都不变。
   * 一批要么全做要么全不做;有改动才写审计事件(不带文本)。返回改了几个事件
   */
  redact(edits: RedactEdit[], by: string): number {
    if (edits.length === 0) return 0
    this.db.exec('PRAGMA secure_delete=ON') // 否则旧文本留在空闲页里
    const seqs = new Set<number>()
    transaction(this.db, () => {
      for (const edit of edits) {
        const row = this.seqStmt.get(edit.seq) as { type: string; payload: string } | undefined
        if (!row) throw new Error(`redact: no event ${edit.seq}`)
        if (!REDACTABLE.has(row.type)) throw new Error(`redact: ${row.type} is not redactable`)
        if (edit.needle === '') throw new Error('redact: empty needle')
        if (edit.callId !== undefined && (row.type !== 'message.assistant' || edit.needle !== undefined)) throw new Error('redact: callId is only for a whole message.assistant tool call')
        const payload = JSON.parse(row.payload) as Record<string, unknown>
        if (!redactPayload(row.type, payload, edit)) continue
        this.updateStmt.run(JSON.stringify(payload), edit.seq)
        seqs.add(edit.seq)
      }
      if (seqs.size > 0) this.append({ type: 'events.redacted', payload: { by, seqs: [...seqs] } })
    })
    this.checkpoint() // 没有改动也做:上一次可能提交了却没清掉,重试要补上
    return seqs.size
  }

  /**
   * 删除的最后一步:重写整个库文件。secure_delete 只管还算数的格子;日常追加时页分裂留在空隙里的旧副本不归它管(实测 60 个库 38 个有残留)。
   * 同步跑,约 13 ms/MB,要 2 倍磁盘(TMPDIR 一份、WAL 一份),只在用户点删除时才有。seq、自增计数、receipts 都不变。
   * 做不到就抛错,调用方不留回执、可重试。阻塞的时间要先向监管要,见 PluginContext.events.purge
   */
  purge(): void {
    if (pending.has(this.db)) throw new Error('purge: inside a transaction')
    this.db.exec('VACUUM')
    const r = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined
    if (r?.busy) throw new Error('purge: wal checkpoint busy')
  }

  /** 库文件多大:purge 要向监管要多少时间 */
  sizeBytes(): number {
    const size = (pragma: string) => Object.values(this.db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>)[0]
    return size('page_count') * size('page_size')
  }

  /** 旧文本还在 WAL 里;尽力而为。外层事务提交之前做不了,由调用方重试 */
  private checkpoint(): void {
    if (pending.has(this.db)) return
    try {
      // 被读者挡住不抛错,只在结果行里说
      const r = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined
      if (r?.busy) this.opts.onWarn?.('wal checkpoint after redact was busy')
    } catch (err) {
      this.opts.onWarn?.(`wal checkpoint after redact failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
