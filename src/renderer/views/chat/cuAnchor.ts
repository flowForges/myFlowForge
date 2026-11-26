// 电脑操作记录块在消息流里的位置(rc3)。
//
// 日志条目只带 `ts` + `turn`;`turn` 是主进程全局自增的轮次号(service.beginTurn 的 ++seq),跟聊天消息没有
// 可关联的 id。所以按时间归位:一块属于「开始时间 ≤ 它第一条记录 ts 的最后一条用户消息」那一轮,
// 落在这一轮最后一条消息(也就是助手回复)之后、下一条用户消息之前。
// ★不按助手回复的 ts 比:助手消息的 ts 是**回复结束时**才盖的(流式中是 ''),一定晚于这轮里的动作。
import type { CuLogEntry } from '../../../main/computerUse/types'
import type { TimelineEntry } from './timeline'

export interface CuTurn { key: string; turn: number; rows: CuLogEntry[] }
export interface CuTurnItem { kind: 'cu-turn'; turn: CuTurn; /** 落在最后一条用户消息那一轮(可能还在跑) */ latest: boolean }
export type StreamItem = TimelineEntry | CuTurnItem

/** 相邻同 turn 的条目合成一块;key = turn + 第一条 ts,跨刷新稳定。 */
export function groupCuTurns(entries: CuLogEntry[]): CuTurn[] {
  const out: CuTurn[] = []
  for (const en of entries) {
    const last = out[out.length - 1]
    if (last && last.turn === en.turn) last.rows.push(en)
    else out.push({ key: `${en.turn}-${en.ts}`, turn: en.turn, rows: [en] })
  }
  return out
}

const isUser = (e: TimelineEntry) => e.kind === 'message' && e.msg.who === 'user'

/**
 * 把各轮记录块编进时间线。`hiddenCount` > 0(「加载更早」收起了历史)时,比所有可见用户消息都早的块
 * 属于被收起的那段,不渲染;没收起任何东西时这种块放在最上面。
 */
export function weaveCuTurns(visible: TimelineEntry[], turns: CuTurn[], hiddenCount: number): { items: StreamItem[] } {
  if (!turns.length) return { items: visible }
  const users: number[] = []
  visible.forEach((e, i) => { if (isUser(e)) users.push(i) })
  const lastUser = users.length ? users[users.length - 1] : -1
  const after = new Map<number, CuTurnItem[]>()
  const top: CuTurnItem[] = []
  for (const t of turns) {
    const first = t.rows[0].ts
    let u = -1
    for (const p of users) { if (visible[p].ts <= first) u = p; else break }
    if (u < 0) {
      if (hiddenCount <= 0) top.push({ kind: 'cu-turn', turn: t, latest: users.length === 0 })
      continue
    }
    const next = users.find((p) => p > u) ?? visible.length
    let at = u
    for (let i = u + 1; i < next; i++) if (visible[i].kind === 'message' || visible[i].kind === 'council') at = i
    const list = after.get(at) ?? []
    list.push({ kind: 'cu-turn', turn: t, latest: u === lastUser })
    after.set(at, list)
  }
  const items: StreamItem[] = [...top]
  visible.forEach((e, i) => { items.push(e); const l = after.get(i); if (l) items.push(...l) })
  return { items }
}
