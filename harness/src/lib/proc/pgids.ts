// shell 进程组登记与孤儿回收(spec §12)。只杀能证明是自己起的组:组长或登记过的组员仍在、启动时间逐字一致
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** lib 不引用 kernel:只要这一个方法 */
export interface PgidLog {
  warn(msg: string, data?: unknown): void
}

export interface Member {
  pid: number
  start: string
}

/** 文件每行一条;`members` 是组长退出时组里还在的进程(组长不在后,靠它们认组) */
export interface PgidEntry {
  pgid: number
  start: string
  members?: Member[]
}

export type Kill = (pid: number, signal: NodeJS.Signals | 0) => unknown

export interface ProcDeps {
  kill?: Kill
  startTime?: (pid: number) => string | undefined
  groupMembers?: (pgid: number) => Member[]
  /** 本进程所在的组;拿不到 → 一律不发信号 */
  ownPgid?: () => number | undefined
  log?: PgidLog
}

/** 组长退出时最多记这么多组员 */
const MAX_MEMBERS = 32
const PS = '/bin/ps'
const PS_OPTS = { env: { LC_ALL: 'C' }, timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] as ('ignore' | 'pipe')[] }
const nullLog: PgidLog = { warn() {} }

export const pgidFile = (dataDir: string) => join(dataDir, 'run', 'shell-pgids')

/** /proc/<pid>/stat 里 comm 之后的字段;fields[0] 是第 3 项 state */
function procStat(pid: number | 'self'): string[] | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return s.slice(s.lastIndexOf(')') + 2).trim().split(' ')
  } catch {
    return undefined
  }
}

/** 进程启动时间,原样字符串;进程不在 / 读不到 → undefined。Linux 第 22 项(时钟滴答),macOS `ps -o lstart=` */
export function startTime(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  if (platform === 'linux') return procStat(pid)?.[19]
  if (platform === 'darwin') {
    try {
      const out = execFileSync(PS, ['-o', 'lstart=', '-p', String(pid)], PS_OPTS).toString().trim()
      return out || undefined
    } catch {
      return undefined // ps 对不存在的 pid 退出码 1
    }
  }
  return undefined
}

/** 组 pgid 里现有的进程及其启动时间 */
export function groupMembers(pgid: number, platform: NodeJS.Platform = process.platform): Member[] {
  const out: Member[] = []
  if (platform === 'linux') {
    let names: string[] = []
    try {
      names = readdirSync('/proc')
    } catch {
      return out
    }
    for (const n of names) {
      if (!/^\d+$/.test(n)) continue
      const f = procStat(Number(n))
      if (f && Number(f[2]) === pgid && f[19]) out.push({ pid: Number(n), start: f[19] })
    }
  } else if (platform === 'darwin') {
    try {
      const text = execFileSync(PS, ['-A', '-o', 'pid=,pgid=,lstart='], PS_OPTS).toString()
      for (const line of text.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
        if (m && Number(m[2]) === pgid) out.push({ pid: Number(m[1]), start: m[3] })
      }
    } catch {
      // 列不出来 → 当作没有组员,不杀
    }
  }
  return out
}

export function ownPgid(platform: NodeJS.Platform = process.platform): number | undefined {
  if (platform === 'linux') {
    const v = Number(procStat('self')?.[2])
    return Number.isInteger(v) && v > 0 ? v : undefined
  }
  if (platform === 'darwin') {
    try {
      const v = Number(execFileSync(PS, ['-o', 'pgid=', '-p', String(process.pid)], PS_OPTS).toString().trim())
      return Number.isInteger(v) && v > 0 ? v : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

interface Resolved {
  kill: Kill
  startTime: (pid: number) => string | undefined
  groupMembers: (pgid: number) => Member[]
  ownPgid: () => number | undefined
  log: PgidLog
}

function resolve(platform: NodeJS.Platform, d: ProcDeps): Resolved {
  let own: { v: number | undefined } | undefined
  return {
    kill: d.kill ?? ((pid, sig) => process.kill(pid, sig)),
    startTime: d.startTime ?? (pid => startTime(pid, platform)),
    groupMembers: d.groupMembers ?? (pgid => groupMembers(pgid, platform)),
    ownPgid: () => (own ??= { v: (d.ownPgid ?? (() => ownPgid(platform)))() }).v,
    log: d.log ?? nullLog,
  }
}

const validPgid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 1

/** 组还在吗;EPERM 也算在(组存在,只是不归我们) */
function groupExists(pgid: number, kill: Kill): boolean {
  try {
    kill(-pgid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 这个组是不是登记时的那个。组长活着:它是会话首进程(detached → setsid),换不了组,启动时间一致就是;
 * 不一致 = pid 已被复用(组 id 在组存续期间不会被分给新进程,所以原组已不在)。
 * 组长已死:组里得有一个登记过的组员,pid 与启动时间都对得上。
 */
function verified(e: PgidEntry, r: Resolved): boolean {
  const lead = r.startTime(e.pgid)
  if (lead !== undefined) return lead === e.start
  const anchors = e.members ?? []
  if (!anchors.length) return false
  return r.groupMembers(e.pgid).some(m => m.pid !== e.pgid && anchors.some(a => a.pid === m.pid && a.start === m.start))
}

/** 唯一发信号的地方:不碰 pid ≤ 1、本进程、本进程所在的组;拿不到本组 id 时一律不发 */
function signalGroup(pgid: number, sig: NodeJS.Signals, r: Resolved): boolean {
  const own = r.ownPgid()
  if (!validPgid(pgid) || pgid === process.pid || own === undefined || pgid === own) return false
  try {
    r.kill(-pgid, sig)
    return true
  } catch {
    return false
  }
}

function parseMember(v: unknown): Member | undefined {
  const m = v as Member
  return m && typeof m === 'object' && validPgid(m.pid) && typeof m.start === 'string' && m.start ? { pid: m.pid, start: m.start } : undefined
}

export function parseEntries(text: string): PgidEntry[] {
  const out = new Map<number, PgidEntry>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      continue
    }
    const e = v as PgidEntry
    if (!e || typeof e !== 'object' || !validPgid(e.pgid) || typeof e.start !== 'string') continue
    const members = Array.isArray(e.members) ? e.members.map(parseMember).filter((m): m is Member => !!m).slice(0, MAX_MEMBERS) : []
    out.set(e.pgid, { pgid: e.pgid, start: e.start, ...(members.length && { members }) })
  }
  return [...out.values()]
}

/** 临时文件 + rename,0600 */
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

export class PgidRegistry {
  private entries = new Map<number, PgidEntry>()
  private r: Resolved

  /** 从空开始:上一个工作进程留下的条目由 reapOrphans 在建内核之前处理掉 */
  constructor(
    private file: string,
    private platform: NodeJS.Platform = process.platform,
    deps: ProcDeps = {},
  ) {
    this.r = resolve(platform, deps)
  }

  add(pgid: number): void {
    try {
      if (this.platform === 'win32' || !validPgid(pgid)) return
      const start = this.r.startTime(pgid)
      if (start === undefined) {
        this.r.log.warn('pgid start time unavailable, not registered', { pgid })
        return
      }
      this.entries.set(pgid, { pgid, start })
      this.flush()
    } catch (err) {
      this.r.log.warn('pgid registry add failed', { error: String(err) })
    }
  }

  /** 组长结束后调用:整组已不在 → 删;还有后台进程 → 留着,并记下组员(之后靠它们认组) */
  settle(pgid: number): void {
    try {
      const e = this.entries.get(pgid)
      if (!e) return
      if (!groupExists(pgid, this.r.kill)) this.entries.delete(pgid)
      else {
        const members = this.r.groupMembers(pgid).filter(m => m.pid !== pgid).slice(0, MAX_MEMBERS)
        if (members.length) e.members = members
      }
      this.flush()
    } catch (err) {
      this.r.log.warn('pgid registry settle failed', { error: String(err) })
    }
  }

  /** 仍存活、且能证明是自己起的组;顺手删掉已不在的 */
  live(): number[] {
    const out: number[] = []
    try {
      let changed = false
      for (const e of [...this.entries.values()]) {
        if (!groupExists(e.pgid, this.r.kill)) {
          this.entries.delete(e.pgid)
          changed = true
        } else if (verified(e, this.r)) out.push(e.pgid)
      }
      if (changed) this.flush()
    } catch (err) {
      this.r.log.warn('pgid registry live failed', { error: String(err) })
    }
    return out
  }

  /** 只给登记过的组发信号 */
  signal(pgid: number, sig: NodeJS.Signals): boolean {
    return this.entries.has(pgid) && signalGroup(pgid, sig, this.r)
  }

  exists(pgid: number): boolean {
    return groupExists(pgid, this.r.kill)
  }

  /** 全部清掉(关闭时杀完之后) */
  clear(): void {
    try {
      this.entries.clear()
      this.flush()
    } catch (err) {
      this.r.log.warn('pgid registry clear failed', { error: String(err) })
    }
  }

  private flush(): void {
    writeAtomic(this.file, [...this.entries.values()].map(e => JSON.stringify(e) + '\n').join(''))
  }
}

/**
 * 工作进程启动时(内核建好之前)处理上一个工作进程留下的组(spec §12):能证明是自己的 → SIGKILL 整组;
 * pid 被复用 / 认不出 → 跳过。然后清空文件。文件不在或读不了 → 什么都不做。
 */
export function reapOrphans(file: string, opts: ProcDeps & { platform?: NodeJS.Platform } = {}): { killed: number[]; skipped: number[] } {
  const platform = opts.platform ?? process.platform
  const r = resolve(platform, opts)
  const res = { killed: [] as number[], skipped: [] as number[] }
  if (platform === 'win32') return res
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') r.log.warn('pgid file unreadable', { error: String(err) })
    return res
  }
  try {
    for (const e of parseEntries(text)) {
      if (!groupExists(e.pgid, r.kill)) continue
      if (verified(e, r) && signalGroup(e.pgid, 'SIGKILL', r)) res.killed.push(e.pgid)
      else res.skipped.push(e.pgid)
    }
  } catch (err) {
    r.log.warn('pgid reap failed', { error: String(err) })
  }
  try {
    if (text) writeAtomic(file, '')
  } catch (err) {
    r.log.warn('pgid file truncate failed', { error: String(err) })
  }
  if (res.killed.length || res.skipped.length) r.log.warn('reaped orphan process groups', res)
  return res
}

/** 正常关闭:登记中仍存活的组先 SIGTERM,graceMs 内没退净再 SIGKILL;然后清空登记 */
export async function killLive(registry: PgidRegistry, graceMs = 1000): Promise<void> {
  const sent = registry.live().filter(g => registry.signal(g, 'SIGTERM'))
  if (sent.length) {
    const end = Date.now() + graceMs
    while (Date.now() < end && sent.some(g => registry.exists(g))) await new Promise(res => setTimeout(res, 25))
    // SIGTERM 时已认过组;宽限期内组退净又被别人重建需要 pid 绕一圈,不再重认(组长可能正是被 SIGTERM 杀掉的)
    for (const g of sent) if (registry.exists(g)) registry.signal(g, 'SIGKILL')
  }
  registry.clear()
}
