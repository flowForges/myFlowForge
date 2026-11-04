// 习惯与推荐(06 spec §15):只有统计,不花钱。推荐只发一个事件,不开会话、不进上下文
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { SessionInfo } from '../../kernel/sessions'
import { scrub } from '../../lib/memory/scrub'
import type { MemoryConfig } from '../../lib/memory/types'
import type { KernelEvent, MemoryRecommendationPayload } from '../../protocol/events'
import type { MemoryHabit } from '../../protocol/rpc'
import { localDate } from './files'
import { scopeOf } from './policy'
import type { Store } from './store'

const KIND = 'routine'
const THRESHOLD = 3
const WINDOW = 4
const COOLDOWN_DAYS = 7
const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']
const OPENING = new Set<string>(['message.user', 'turn.started', 'turn.resumed'])
/** 停着的轮还在干活,不算结束:这时候别出声 */
const CLOSING = new Set<string>(['turn.ended', 'turn.failed'])

type HabitStore = Pick<Store, 'db'>
type HabitRow = { id: string; key: string; status: MemoryHabit['status']; last_recommended_at: number | null }

const slotKey = (weekday: number, hour: number, cwd: string) => `${weekday}|${hour}|${cwd}`

function parseSlot(key: string): { weekday: number; hour: number; cwd: string } | undefined {
  const m = /^(\d+)\|(\d+)\|(.*)$/s.exec(key)
  return m ? { weekday: Number(m[1]), hour: Number(m[2]), cwd: m[3] } : undefined
}

/** 这一周的周一,本地日期 */
function weekOf(ms: number): string {
  const d = new Date(ms)
  return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7).getTime())
}

/** 这个时段最近 WINDOW 次所在的周。今天的时段还没到就从上一次数起,所以窗口永远是满的 */
function recentWeeks(weekday: number, hour: number, now: number): string[] {
  const d = new Date(now)
  const date = d.getDate() - (d.getDay() - weekday + 7) % 7
  const started = new Date(d.getFullYear(), d.getMonth(), date, hour).getTime() <= now
  const latest = started ? date : date - 7
  return Array.from({ length: WINDOW }, (_, i) => weekOf(new Date(d.getFullYear(), d.getMonth(), latest - 7 * i, 12).getTime()))
}

/** 一个新轮算一次。只存时段和 cwd,不存文本。和接入的游标同一个事务,所以重放不重复 */
export function countHabit(store: HabitStore, e: KernelEvent, session: SessionInfo, ts: number): void {
  if (e.type !== 'message.user' || (e.payload as { followUp?: unknown } | null)?.followUp === true) return
  if (!session.cwd || !scopeOf(session).countsForHabits) return
  const d = new Date(ts)
  store.db
    .prepare('INSERT INTO habit_counts(kind, key, week, n) VALUES (?, ?, ?, 1) ON CONFLICT(kind, key, week) DO UPDATE SET n = n + 1')
    .run(KIND, slotKey(d.getDay(), d.getHours(), session.cwd), weekOf(ts))
}

/** 夜里算一遍。用户定过的不动;没人定过、又不再成立的去掉,以后成立了再出现 */
export function computeHabits(store: Pick<Store, 'db' | 'transaction'>, now: number): void {
  const seen = new Map<string, Set<string>>()
  for (const r of store.db.prepare('SELECT key, week FROM habit_counts WHERE kind = ?').all(KIND) as { key: string; week: string }[]) {
    if (!seen.has(r.key)) seen.set(r.key, new Set())
    seen.get(r.key)?.add(r.week)
  }
  const holds = new Set<string>()
  for (const [key, weeks] of seen) {
    const slot = parseSlot(key)
    if (slot && recentWeeks(slot.weekday, slot.hour, now).filter(w => weeks.has(w)).length >= THRESHOLD) holds.add(key)
  }
  store.transaction(() => {
    for (const r of store.db.prepare("SELECT id, key FROM habits WHERE kind = ? AND status = 'detected'").all(KIND) as { id: string; key: string }[]) {
      if (!holds.has(r.key)) store.db.prepare('DELETE FROM habits WHERE id = ?').run(r.id)
    }
    const add = store.db.prepare('INSERT INTO habits(id, kind, key, detected_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
    for (const key of holds) add.run(`hb_${createHash('sha256').update(`${KIND}|${key}`).digest('hex').slice(0, 16)}`, KIND, key, now)
  })
}

export function listHabits(store: HabitStore): MemoryHabit[] {
  const rows = store.db.prepare('SELECT id, key, status FROM habits WHERE kind = ? ORDER BY id').all(KIND) as Pick<HabitRow, 'id' | 'key' | 'status'>[]
  return rows.flatMap(r => {
    const slot = parseSlot(r.key)
    return slot ? [{ id: r.id, kind: KIND, status: r.status, ...slot } as const] : []
  })
}

/** 返回有没有这一条 */
export function decideHabit(store: HabitStore, id: string, decision: 'confirmed' | 'dismissed', now: number): boolean {
  return store.db.prepare('UPDATE habits SET status = ?, decided_at = ? WHERE id = ?').run(decision, now, id).changes > 0
}

/** 开着的轮。事件的 tap:在写入方的栈上,只动内存 */
export function noteTurn(open: Set<string>, e: Pick<KernelEvent, 'type' | 'payload'>): void {
  const id = (e.payload as { turnId?: unknown } | null)?.turnId
  if (typeof id !== 'string') return
  if (OPENING.has(e.type)) open.add(id)
  else if (CLOSING.has(e.type)) open.delete(id)
}

const noonOf = (ms: number) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime()
}
/** 按日子算:定时不对齐整点,上周 9:50 发的这周 9:05 到,按小时差一点就错过整整一周 */
const daysBetween = (a: number, b: number) => Math.round((noonOf(b) - noonOf(a)) / 86_400_000)

export interface RecommendDeps {
  store: HabitStore
  config(): MemoryConfig
  hasOpenTurn(): boolean
  /** 有上限地追事件日志,返回追上了没有。没追上时今天的活动可能还没数到 */
  catchUp(): boolean
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): unknown
}

/** 每小时调一次。条件全满足才发一条 */
export function maybeRecommend(d: RecommendDeps, now: number): void {
  if (!d.config().recommendations.routine) return
  const at = new Date(now)
  const { db } = d.store
  const due = (db.prepare("SELECT id, key, status, last_recommended_at FROM habits WHERE kind = ? AND status = 'confirmed' ORDER BY id").all(KIND) as HabitRow[]).flatMap(row => {
    const slot = parseSlot(row.key)
    return slot && slot.weekday === at.getDay() && slot.hour === at.getHours() && (row.last_recommended_at === null || daysBetween(row.last_recommended_at, now) >= COOLDOWN_DAYS) ? [{ row, slot }] : []
  })
  if (due.length === 0 || d.hasOpenTurn() || !d.catchUp()) return
  const { last } = db.prepare('SELECT MAX(last_recommended_at) AS last FROM habits WHERE kind = ?').get(KIND) as { last: number | null }
  if (last !== null && localDate(last) === localDate(now)) return
  const today = (db.prepare('SELECT key FROM habit_counts WHERE kind = ? AND week = ?').all(KIND, weekOf(now)) as { key: string }[]).flatMap(r => {
    const slot = parseSlot(r.key)
    return slot?.weekday === at.getDay() ? [slot.cwd] : []
  })
  const pick = due.find(x => !today.includes(x.slot.cwd))
  if (!pick) return
  const { row, slot } = pick
  // 先记账:事件写失败只是错过这周;反过来,账写不进去就会每小时发一次
  db.prepare('UPDATE habits SET last_recommended_at = ? WHERE id = ?').run(now, row.id)
  const payload: MemoryRecommendationPayload = {
    id: `rec_${row.id}_${localDate(now)}`,
    category: KIND,
    habitId: row.id,
    text: `每周${DAY_NAMES[slot.weekday]} ${slot.hour} 点你常在 ${scrub(basename(slot.cwd)).text} 工作`,
    cwd: slot.cwd,
  }
  d.append({ type: 'memory.recommendation', payload })
}
