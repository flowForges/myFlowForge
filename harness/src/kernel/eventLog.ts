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

// 每个 db 一个待发通知队列:事务内的通知等 COMMIT 后再发,ROLLBACK 则丢弃
const pending = new WeakMap<DatabaseSync, Array<() => void>>()

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (pending.has(db)) return fn() // 嵌套:并入外层事务
  const queue: Array<() => void> = []
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
  for (const n of queue) n() // notify 自身已吞掉订阅者异常
  return result
}

type Row = { seq: number; ts: number; type: string; session_id: string | null; payload: string }

function toEvent(r: Row): KernelEvent {
  const e: KernelEvent = { seq: r.seq, ts: r.ts, type: r.type as KernelEvent['type'], payload: JSON.parse(r.payload) }
  if (r.session_id !== null) e.sessionId = r.session_id
  return e
}

export class EventLog {
  private listeners = new Set<(e: KernelEvent) => void>()
  private insert
  private afterStmt
  private tailStmt
  private lastStmt

  constructor(
    private db: DatabaseSync,
    private opts: { onListenerError?: (err: unknown) => void } = {},
  ) {
    this.insert = db.prepare('INSERT INTO events(ts, type, session_id, payload) VALUES (?, ?, ?, ?)')
    this.afterStmt = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?')
    this.tailStmt = db.prepare('SELECT * FROM (SELECT * FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq')
    this.lastStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events')
  }

  append(e: Omit<KernelEvent, 'seq' | 'ts'>): KernelEvent {
    const ts = Date.now()
    const info = this.insert.run(ts, e.type, e.sessionId ?? null, JSON.stringify(e.payload ?? null))
    const ev: KernelEvent = { ...e, seq: Number(info.lastInsertRowid), ts }
    const notify = () => {
      for (const l of [...this.listeners]) {
        try {
          l(ev)
        } catch (err) {
          try { this.opts.onListenerError?.(err) } catch { /* 忽略 */ }
        }
      }
    }
    const queue = pending.get(this.db)
    if (queue) queue.push(notify)
    else notify()
    return ev
  }

  after(seq: number, limit = -1): KernelEvent[] {
    return (this.afterStmt.all(seq, limit) as Row[]).map(toEvent)
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
}
