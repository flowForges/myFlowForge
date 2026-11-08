// memory.sqlite(06 spec §5):与 events.sqlite 分开,坏了能从事件日志和 Markdown 重建
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { basename, dirname } from 'node:path'
import { transaction } from '../../kernel/eventLog'
import type { Logger } from '../../kernel/log'
import { scanInjection } from '../../lib/memory/scan'
import { buildMatch, excerpt, quote, windowTerms } from './query'

const SCHEMA_VERSION = 1
/** meta 里夜间整合的游标;没有这一行 = 新库 */
export const CONSOLIDATION_CURSOR = 'consolidationCursor'
const MAX_LIMIT = 100
/** 召回的复核在 JS 里:多取一些,否则被筛掉的行吃掉名额 */
const RECALL_FETCH = 200

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw(
  seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL, tool TEXT,
  origin TEXT NOT NULL, scope TEXT NOT NULL, account_id TEXT, text TEXT NOT NULL, rolled_back INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS raw_turn ON raw(turn_id);
CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(text, content='raw', content_rowid='seq', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS raw_ai AFTER INSERT ON raw BEGIN
  INSERT INTO raw_fts(rowid, text) VALUES (new.seq, new.text);
END;
CREATE TRIGGER IF NOT EXISTS raw_ad AFTER DELETE ON raw BEGIN
  INSERT INTO raw_fts(raw_fts, rowid, text) VALUES ('delete', old.seq, old.text);
END;
CREATE TRIGGER IF NOT EXISTS raw_au AFTER UPDATE OF text ON raw BEGIN
  INSERT INTO raw_fts(raw_fts, rowid, text) VALUES ('delete', old.seq, old.text);
  INSERT INTO raw_fts(rowid, text) VALUES (new.seq, new.text);
END;

CREATE TABLE IF NOT EXISTS notes(
  n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, layer TEXT NOT NULL, file TEXT, scope TEXT NOT NULL, source TEXT NOT NULL,
  text TEXT NOT NULL, ts INTEGER NOT NULL, flags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', turn_id TEXT);
CREATE INDEX IF NOT EXISTS notes_file ON notes(file);
CREATE INDEX IF NOT EXISTS notes_turn ON notes(turn_id);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(text, content='notes', content_rowid='n', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, text) VALUES (new.n, new.text);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.n, old.text);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF text ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.n, old.text);
  INSERT INTO notes_fts(rowid, text) VALUES (new.n, new.text);
END;

CREATE TABLE IF NOT EXISTS candidates(
  id TEXT PRIMARY KEY, text TEXT NOT NULL, norm TEXT NOT NULL, kind TEXT NOT NULL, target TEXT, replaces TEXT, flags TEXT NOT NULL DEFAULT '[]',
  days_seen INTEGER NOT NULL DEFAULT 1, evidence TEXT NOT NULL DEFAULT '[]', first_date TEXT, last_date TEXT);
CREATE TABLE IF NOT EXISTS proposals(
  id TEXT PRIMARY KEY, target TEXT NOT NULL, op TEXT NOT NULL, text TEXT NOT NULL, replaces TEXT, evidence TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', turn_id TEXT, created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE TABLE IF NOT EXISTS changes(
  n INTEGER PRIMARY KEY, ts INTEGER NOT NULL, entry_id TEXT, file TEXT, op TEXT NOT NULL, before TEXT, after TEXT, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS habit_counts(kind TEXT NOT NULL, key TEXT NOT NULL, week TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind, key, week));
CREATE TABLE IF NOT EXISTS habits(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'detected', detected_at INTEGER, decided_at INTEGER, last_recommended_at INTEGER);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

export type RawRole = 'user' | 'assistant' | 'tool' | 'notice'

export interface RawInput {
  seq: number
  ts: number
  sessionId: string
  turnId?: string
  role: RawRole
  tool?: string
  origin: string
  scope: string
  accountId?: string
  text: string
}
export interface RawRow extends RawInput {
  rolledBack: boolean
}
export type RawHit = RawRow & { excerpt: string }

export interface NoteInput {
  id: string
  layer: string
  file?: string
  scope: string
  source: string
  text: string
  ts: number
  flags?: string[]
  status?: string
  turnId?: string
}
export interface NoteRow extends NoteInput {
  flags: string[]
  status: string
}
export type NoteHit = NoteRow & { excerpt: string }

export interface ChangeRow {
  ts: number
  entry_id: string | null
  file: string | null
  op: string
  before: string | null
  after: string | null
  source: string
}

type Row = Record<string, SQLInputValue>

const toRaw = (r: Row): RawRow => ({
  seq: r.seq as number,
  ts: r.ts as number,
  sessionId: r.session_id as string,
  ...(r.turn_id !== null && { turnId: r.turn_id as string }),
  role: r.role as RawRole,
  ...(r.tool !== null && { tool: r.tool as string }),
  origin: r.origin as string,
  scope: r.scope as string,
  ...(r.account_id !== null && { accountId: r.account_id as string }),
  text: r.text as string,
  rolledBack: r.rolled_back === 1,
})

const toNote = (r: Row): NoteRow => ({
  id: r.id as string,
  layer: r.layer as string,
  ...(r.file !== null && { file: r.file as string }),
  scope: r.scope as string,
  source: r.source as string,
  text: r.text as string,
  ts: r.ts as number,
  flags: JSON.parse(r.flags as string) as string[],
  status: r.status as string,
  ...(r.turn_id !== null && { turnId: r.turn_id as string }),
})

const marks = (n: number) => Array(n).fill('?').join(', ')
const scopeFilter = (scopes: string[] | 'all'): Filter => (scopes === 'all' ? { sql: '1 = 1', params: [] } : { sql: `scope IN (${marks(scopes.length)})`, params: scopes })
const clampLimit = (limit: number) => Math.min(Math.max(0, Math.floor(limit)), MAX_LIMIT)

interface Filter {
  sql: string
  params: SQLInputValue[]
}
interface Indexed {
  table: string
  fts: string
  key: string
}
const RAW: Indexed = { table: 'raw', fts: 'raw_fts', key: 'seq' }
const NOTES: Indexed = { table: 'notes', fts: 'notes_fts', key: 'n' }

export class Store {
  private insertRawStmt
  private setMetaStmt
  private getMetaStmt

  constructor(
    readonly db: DatabaseSync,
    /** 给 memory.health;恢复过、接入失败都记在这 */
    readonly problems: string[],
    private log: Pick<Logger, 'warn'>,
  ) {
    this.insertRawStmt = db.prepare(`INSERT OR IGNORE INTO raw(seq, ts, session_id, turn_id, role, tool, origin, scope, account_id, text, rolled_back)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(rolled_back) FROM raw WHERE turn_id = ?), 0))`)
    this.getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?')
    this.setMetaStmt = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  }

  /** 可嵌套:并入外层事务。抛错全部撤销 */
  transaction<T>(fn: () => T): T {
    return transaction(this.db, fn)
  }

  getMeta(key: string): string | undefined {
    return (this.getMetaStmt.get(key) as { value: string } | undefined)?.value
  }

  setMeta(key: string, value: string): void {
    this.setMetaStmt.run(key, value)
  }

  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key)
  }

  metaWithPrefix(prefix: string): { key: string; value: string }[] {
    return this.db.prepare('SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?').all(prefix.length, prefix) as { key: string; value: string }[]
  }

  /** 接入游标:这个 seq 及之前都处理过 */
  cursor(): number {
    return Number(this.getMeta('cursor') ?? 0)
  }

  setCursor(seq: number): void {
    this.setMeta('cursor', String(seq))
  }

  /** 已撤销的轮迟到的行(后台通知)也算撤销 */
  insertRaw(r: RawInput): void {
    const turnId = r.turnId ?? null
    this.insertRawStmt.run(r.seq, r.ts, r.sessionId, turnId, r.role, r.tool ?? null, r.origin, r.scope, r.accountId ?? null, r.text, turnId)
  }

  getRaw(seq: number): RawRow | undefined {
    const row = this.db.prepare('SELECT * FROM raw WHERE seq = ?').get(seq) as Row | undefined
    return row && toRaw(row)
  }

  markRolledBack(turnId: string): void {
    this.db.prepare('UPDATE raw SET rolled_back = 1 WHERE turn_id = ?').run(turnId)
  }

  deleteRaw(seqs: number[]): void {
    const stmt = this.db.prepare('DELETE FROM raw WHERE seq = ?')
    this.transaction(() => {
      for (const seq of seqs) stmt.run(seq)
    })
  }

  /** 一个会话的原始层行(删会话用,08 §4.3)。没有 session_id 的索引:只在用户删会话时扫一次 */
  rawOfSession(sessionId: string): { seq: number; text: string; scope: string }[] {
    return this.db.prepare('SELECT seq, text, scope FROM raw WHERE session_id = ? ORDER BY seq').all(sessionId) as { seq: number; text: string; scope: string }[]
  }

  /** 同范围内逐字含这段文本的行。instr 比字节:LIKE 不分大小写,也不是"逐字" */
  rawSeqsHolding(text: string, scope: string): number[] {
    return (this.db.prepare('SELECT seq FROM raw WHERE scope = ? AND instr(text, ?) > 0').all(scope, text) as { seq: number }[]).map(r => r.seq)
  }

  upsertNote(n: NoteInput): void {
    this.db
      .prepare(
        `INSERT INTO notes(id, layer, file, scope, source, text, ts, flags, status, turn_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET layer = excluded.layer, file = excluded.file, scope = excluded.scope, source = excluded.source,
           text = excluded.text, ts = excluded.ts, flags = excluded.flags, status = excluded.status, turn_id = excluded.turn_id`,
      )
      .run(n.id, n.layer, n.file ?? null, n.scope, n.source, n.text, n.ts, JSON.stringify(n.flags ?? []), n.status ?? 'active', n.turnId ?? null)
  }

  getNote(id: string): NoteRow | undefined {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Row | undefined
    return row && toNote(row)
  }

  deleteNote(id: string): void {
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id)
  }

  /** scopes 是 'all' 只有 RPC 这么传:app 带 token,看得到全部(spec §9) */
  searchRaw(o: { q: string; scopes: string[] | 'all'; limit: number; includeRolledBack?: boolean }): RawHit[] {
    if (o.scopes.length === 0) return []
    const scope = scopeFilter(o.scopes)
    const filter: Filter = {
      sql: `${scope.sql}${o.includeRolledBack ? '' : ' AND rolled_back = 0'}`,
      params: scope.params,
    }
    const { rows, terms } = this.find(RAW, o.q, filter, o.limit)
    return rows.map(r => ({ ...toRaw(r), excerpt: excerpt(r.text as string, terms) }))
  }

  searchNotes(o: { q: string; scopes: string[] | 'all'; layers: string[]; limit: number; noFlags?: boolean }): NoteHit[] {
    if (o.scopes.length === 0 || o.layers.length === 0) return []
    const scope = scopeFilter(o.scopes)
    const filter: Filter = {
      sql: `${scope.sql} AND layer IN (${marks(o.layers.length)}) AND status = 'active'${o.noFlags ? " AND flags = '[]'" : ''}`,
      params: [...scope.params, ...o.layers],
    }
    const { rows, terms } = this.find(NOTES, o.q, filter, o.limit)
    return rows.map(r => ({ ...toNote(r), excerpt: excerpt(r.text as string, terms) }))
  }

  /** 自动召回:只有主人在其他会话里自己说的话,只用 OR 模式,命中不同的窗 ≥2 个才算(spec §7) */
  recallUserRaw(o: { q: string; excludeSession: string; limit: number }): RawHit[] {
    return this.recallRows(
      RAW,
      o.q,
      { sql: "scope = 'owner' AND role = 'user' AND origin IN ('app', 'im') AND rolled_back = 0 AND session_id != ?", params: [o.excludeSession] },
      o.limit,
      toRaw,
    )
  }

  /** 自动召回的笔记:和上面同样的 OR 模式和阈值,searchNotes 的 AND 再退到 OR 没有阈值 */
  recallNotes(o: { q: string; scopes: string[]; layers: string[]; limit: number }): NoteHit[] {
    if (o.scopes.length === 0 || o.layers.length === 0) return []
    const filter: Filter = {
      sql: `scope IN (${marks(o.scopes.length)}) AND layer IN (${marks(o.layers.length)}) AND status = 'active'`,
      params: [...o.scopes, ...o.layers],
    }
    return this.recallRows(NOTES, o.q, filter, o.limit, toNote)
  }

  /** 新的在前。见 newest:同一时刻的行不拆开 */
  listRaw(o: { before?: number; limit: number }): RawRow[] {
    return this.newest(RAW, { sql: 'rolled_back = 0', params: [] }, o).map(toRaw)
  }

  listNotes(o: { layers: string[]; before?: number; limit: number }): NoteRow[] {
    if (o.layers.length === 0) return []
    return this.newest(NOTES, { sql: `layer IN (${marks(o.layers.length)}) AND status = 'active'`, params: o.layers }, o).map(toNote)
  }

  /** 新的在前,只给 limit 条 */
  listChanges(limit: number): ChangeRow[] {
    return this.db.prepare('SELECT * FROM changes ORDER BY n DESC LIMIT ?').all(clampLimit(limit)) as unknown as ChangeRow[]
  }

  /** 这个文件的索引行;contextFor 用它知道块里有哪些条目 */
  notesInFile(file: string): NoteRow[] {
    return (this.db.prepare('SELECT * FROM notes WHERE file = ? ORDER BY n').all(file) as Row[]).map(toNote)
  }

  /** 让删掉的文本离开文件:FTS 的 trigram 只有 optimize 之后才真的消失,WAL 里的旧页要截掉(spec §16) */
  purge(): void {
    this.db.exec(`INSERT INTO raw_fts(raw_fts) VALUES ('optimize'); INSERT INTO notes_fts(notes_fts) VALUES ('optimize');`)
    const r = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined
    if (r?.busy) this.log.warn('memory wal checkpoint was busy')
  }

  /** 索引和内容表对不上就抛错 */
  integrityCheck(): void {
    this.db.exec(`INSERT INTO raw_fts(raw_fts, rank) VALUES ('integrity-check', 1); INSERT INTO notes_fts(notes_fts, rank) VALUES ('integrity-check', 1);`)
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  /** before 按 ts 翻页:第 limit 条同一时刻的行都带上,否则下一页的 ts < before 会把它们漏掉。所以可能多于 limit */
  private newest(t: Indexed, filter: Filter, o: { before?: number; limit: number }): Row[] {
    const before = o.before ?? Number.MAX_SAFE_INTEGER
    const where = `${filter.sql} AND ts < ?`
    const sql = `SELECT * FROM ${t.table} WHERE ${where} AND ts >= COALESCE((SELECT ts FROM ${t.table} WHERE ${where} ORDER BY ts DESC LIMIT 1 OFFSET ?), 0)
      ORDER BY ts DESC, ${t.key} DESC`
    return this.db.prepare(sql).all(...filter.params, before, ...filter.params, before, Math.max(clampLimit(o.limit) - 1, 0)) as Row[]
  }

  /** AND 没有结果才退到 OR */
  private find(t: Indexed, q: string, filter: Filter, rawLimit: number): { rows: Row[]; terms: string[] } {
    const limit = clampLimit(rawLimit)
    if (limit === 0) return { rows: [], terms: [] }
    const { match, likes, terms } = buildMatch(q)
    const all = match ? this.matchRows(t, match, likes, filter, limit) : likes.length > 0 ? this.likeRows(t, likes, ' AND ', filter, limit) : []
    if (all.length > 0) return { rows: all, terms }
    const windows = windowTerms(q)
    const rows = windows.length > 0 ? this.matchRows(t, windows.map(quote).join(' OR '), [], filter, limit) : []
    // MATCH 不能和 LIKE 用 OR 拼在一条语句里
    if (rows.length < limit && likes.length > 0) {
      const seen = new Set(rows.map(r => r[t.key]))
      for (const r of this.likeRows(t, likes, ' OR ', filter, limit)) if (!seen.has(r[t.key]) && rows.length < limit) rows.push(r)
    }
    return { rows, terms: [...windows, ...terms] }
  }

  /** 有标记的现扫,不看 flags 列:raw 没有这一列,扫描规则升级后老笔记也按新的算 */
  private recallRows<T>(t: Indexed, q: string, filter: Filter, rawLimit: number, map: (r: Row) => T): (T & { excerpt: string })[] {
    const limit = clampLimit(rawLimit)
    const windows = windowTerms(q)
    if (limit === 0 || windows.length === 0) return []
    const lowered = [...new Set(windows.map(w => w.toLowerCase()))]
    const hits: (T & { excerpt: string })[] = []
    for (const row of this.matchRows(t, windows.map(quote).join(' OR '), [], filter, RECALL_FETCH)) {
      const text = (row.text as string).toLowerCase()
      if (lowered.filter(w => text.includes(w)).length < 2) continue
      if (scanInjection(row.text as string).length > 0) continue
      hits.push({ ...map(row), excerpt: excerpt(row.text as string, windows) })
      if (hits.length === limit) break
    }
    return hits
  }

  private matchRows(t: Indexed, match: string, likes: string[], filter: Filter, limit: number): Row[] {
    const extra = likes.map(() => ` AND ${t.table}.text LIKE ? ESCAPE '\\'`).join('')
    const sql = `SELECT ${t.table}.* FROM ${t.fts} JOIN ${t.table} ON ${t.table}.${t.key} = ${t.fts}.rowid
      WHERE ${t.fts} MATCH ?${extra} AND ${filter.sql} ORDER BY bm25(${t.fts}) LIMIT ?`
    return this.db.prepare(sql).all(match, ...likes, ...filter.params, limit) as Row[]
  }

  /** 短词全表扫:按 seq 倒序,靠 LIMIT 止损 */
  private likeRows(t: Indexed, likes: string[], joiner: string, filter: Filter, limit: number): Row[] {
    const any = likes.map(() => `text LIKE ? ESCAPE '\\'`).join(joiner)
    const sql = `SELECT * FROM ${t.table} WHERE (${any}) AND ${filter.sql} ORDER BY ${t.key} DESC LIMIT ?`
    return this.db.prepare(sql).all(...likes, ...filter.params, limit) as Row[]
  }
}

class NewerVersion extends Error {}

/** 只有文件本身坏了才挪走。锁、权限、磁盘满时好好的库不能丢:候选、提议、习惯都不能从日志重建 */
export function damaged(err: unknown): boolean {
  if (err instanceof NewerVersion) return true
  const code = (err as { errcode?: unknown }).errcode
  const SQLITE_CORRUPT = 11
  const SQLITE_NOTADB = 26
  return typeof code === 'number' && ((code & 0xff) === SQLITE_CORRUPT || (code & 0xff) === SQLITE_NOTADB)
}

function connect(file: string, busyTimeoutMs: number): DatabaseSync {
  const db = new DatabaseSync(file)
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    db.exec('PRAGMA secure_delete = ON')
    db.exec('PRAGMA journal_mode = WAL')
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version > SCHEMA_VERSION) throw new NewerVersion(`newer schema ${version}`)
    if (version < SCHEMA_VERSION) transaction(db, () => db.exec(`${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION};`))
    return db
  } catch (err) {
    db.close()
    throw err
  }
}

/** SQLite 关连接时通常已经清掉 -wal、-shm;清不掉(别的进程开着)时留下来会被新库当成自己的重放 */
function setAside(file: string, ts: number): string {
  const bad = `${file}.bad-${ts}`
  renameSync(file, bad)
  for (const suffix of ['-wal', '-shm']) if (existsSync(file + suffix)) renameSync(file + suffix, bad + suffix)
  return bad
}

export interface OpenStoreOpts {
  log: Pick<Logger, 'warn'>
  now?: () => number
  busyTimeoutMs?: number
}

export function openStore(file: string, o: OpenStoreOpts): Store {
  const problems: string[] = []
  const busyTimeoutMs = o.busyTimeoutMs ?? 5000
  const tighten = (path: string, mode: number) => {
    try {
      chmodSync(path, mode)
    } catch (err) {
      o.log.warn('memory store chmod failed', { path: basename(path), error: err instanceof Error ? err.message : String(err) })
    }
  }
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  tighten(dir, 0o700)
  // SQLite 让 -wal、-shm 跟主文件同权限,所以主文件要先于第一次连接存在
  closeSync(openSync(file, 'a', 0o600))
  tighten(file, 0o600)
  let db: DatabaseSync
  try {
    db = connect(file, busyTimeoutMs)
  } catch (err) {
    if (!damaged(err)) throw err
    const reason = err instanceof Error ? err.message : String(err)
    const bad = setAside(file, (o.now ?? Date.now)())
    o.log.warn('memory store set aside, rebuilding', { reason, moved: basename(bad) })
    problems.push('db_recovered')
    closeSync(openSync(file, 'a', 0o600))
    db = connect(file, busyTimeoutMs)
  }
  return new Store(db, problems, o.log)
}
