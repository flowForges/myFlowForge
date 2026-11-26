import { stat as fsStat, open } from 'node:fs/promises'
import { readExternal } from './index'
import type { ExtCursor, ExtProvider, ExtRead } from './types'

// 「对方正在用」判定(spec §4.5):外部记录 15 s 内被改过,且末条不是该轮结束标记 → 占用。
// 我方自己的写入不能把自己拦住,按顺序:
//   1) ownLive:我们自己的进程还握着这个会话(claude 留驻 / 我方 app-server 线程还订阅着)→ 不占用
//   2) 文件大小 + mtime 和我方写者安静下来时(ownEnd)一模一样 → 没人动过 → 不占用
//   3) 15 s 内没改过 → 不占用(对方早停了或崩了)
//   4) 末字节不是 `\n`(空文件 / 写到一半的行)→ 占用,不用整读
//   5) 读末尾:结束标记 → 不占用,否则占用
// 没有 ownEnd 的老绑定:2) 换成「我方最近一次写入后 15 s 内的 mtime 变化算我方的」。
// Qoder 记录格式未验证 → 读不出结束标记,实际只看 mtime。

export const BUSY_WINDOW_MS = 15_000
const NL = 0x0a

const APP_NAMES: Record<ExtProvider, string> = { codex: 'Codex', claude: 'Claude', qoder: 'Qoder' }
/** 官方 App 名,用于 `open -a`、阻断条和消息标签。 */
export const appName = (p: ExtProvider): string => APP_NAMES[p]

export interface Occupancy { busy: boolean; app?: string; exists: boolean }
export interface OwnState {
  /** 我方进程此刻还握着这个绑定(见 binding.ts ownLiveFor)。 */
  ownLive?: boolean
  /** 我方写者安静下来时外部文件的大小 + mtime(见 binding.ts recordOwnEnd)。 */
  ownEnd?: { offset: number; mtimeMs: number }
  /** 老绑定的回退:我方最近一次写完的时刻。 */
  ownLastWriteAt?: number
}
export interface OccupancyDeps {
  stat?: (file: string) => Promise<{ mtimeMs: number; size?: number }>
  read?: (provider: ExtProvider, file: string, from: ExtCursor) => Promise<ExtRead>
  /** size-1 处那个字节;读不了 → undefined。 */
  lastByte?: (file: string, size: number) => Promise<number | undefined>
}

async function readLastByte(file: string, size: number): Promise<number | undefined> {
  const fh = await open(file, 'r').catch(() => null)
  if (!fh) return undefined
  try {
    const buf = Buffer.alloc(1)
    const { bytesRead } = await fh.read(buf, 0, 1, size - 1)
    return bytesRead ? buf[0] : undefined
  } catch { return undefined } finally { await fh.close().catch(() => {}) }
}

const free = { busy: false, exists: true } as const
const gone = { busy: false, exists: false } as const

export async function isOccupied(provider: ExtProvider, file: string, now: number, own: OwnState = {}, deps: OccupancyDeps = {}): Promise<Occupancy> {
  if (own.ownLive) return { ...free }
  const stat = deps.stat ?? fsStat
  let mtime: number, size: number
  try { const st = await stat(file); mtime = st.mtimeMs; size = st.size ?? 0 } catch { return { ...gone } }
  const busy: Occupancy = { busy: true, app: appName(provider), exists: true }
  if (own.ownEnd) {
    if (size === own.ownEnd.offset && mtime === own.ownEnd.mtimeMs) return { ...free }
  } else if (own.ownLastWriteAt !== undefined && mtime - own.ownLastWriteAt <= BUSY_WINDOW_MS && now - mtime <= BUSY_WINDOW_MS) {
    return { ...free }
  }
  if (now - mtime > BUSY_WINDOW_MS) return { ...free }
  if (size === 0) return busy
  const last = await (deps.lastByte ?? readLastByte)(file, size)
  if (last === undefined) return { ...gone }
  if (last !== NL) return busy
  // 从文件末尾读(0 条新行):reader 往回找最后一条与轮次有关的记录。
  let r: ExtRead
  try { r = await (deps.read ?? readExternal)(provider, file, { offset: size }) } catch { return { ...gone } }
  if (!r.exists) return { ...gone }
  return r.endedCleanly ? { ...free } : busy
}
