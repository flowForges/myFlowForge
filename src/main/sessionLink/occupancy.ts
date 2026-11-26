import { stat as fsStat } from 'node:fs/promises'
import { readExternal } from './index'
import type { ExtCursor, ExtProvider, ExtRead } from './types'

// 「对方正在用」判定(spec §4.5):外部记录 15 s 内被改过,且末条不是该轮结束标记 → 占用。
// 我方自己最近一次写入/结束后 15 s 内的 mtime 变化算我方的,不算对方(否则刚跑完的自己会被拦住)。
// Qoder 记录格式未验证 → 读不出结束标记,实际只看 mtime。

export const BUSY_WINDOW_MS = 15_000

const APP_NAMES: Record<ExtProvider, string> = { codex: 'Codex', claude: 'Claude', qoder: 'Qoder' }
/** 官方 App 名,用于 `open -a`、阻断条和消息标签。 */
export const appName = (p: ExtProvider): string => APP_NAMES[p]

export interface Occupancy { busy: boolean; app?: string; exists: boolean }
export interface OccupancyDeps {
  stat?: (file: string) => Promise<{ mtimeMs: number; size?: number }>
  read?: (provider: ExtProvider, file: string, from: ExtCursor) => Promise<ExtRead>
}

export async function isOccupied(provider: ExtProvider, file: string, now: number, ownLastWriteAt?: number, deps: OccupancyDeps = {}): Promise<Occupancy> {
  const stat = deps.stat ?? fsStat
  const read = deps.read ?? readExternal
  let mtime: number, size: number
  try { const st = await stat(file); mtime = st.mtimeMs; size = st.size ?? 0 } catch { return { busy: false, exists: false } }
  if (now - mtime > BUSY_WINDOW_MS) return { busy: false, exists: true }
  if (ownLastWriteAt !== undefined && mtime - ownLastWriteAt <= BUSY_WINDOW_MS) return { busy: false, exists: true }
  // 只看末尾:从文件末尾读(0 条新行),reader 往回找最后一条与轮次有关的记录。
  // 末行写到一半时游标不在行边界 → reader 从头重读并判为未结束(只在正被写的那一瞬发生)。
  let r: ExtRead
  try { r = await read(provider, file, { offset: size }) } catch { return { busy: false, exists: false } }
  if (!r.exists) return { busy: false, exists: false }
  return r.endedCleanly ? { busy: false, exists: true } : { busy: true, app: appName(provider), exists: true }
}
