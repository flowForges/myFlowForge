// shell 进程组登记与孤儿回收(spec §12)。只杀能证明是自己起的组:组长或登记过的组员仍在、启动时间逐字一致
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** lib 不引用 kernel:只要这一个方法 */
export interface PgidLog {
  warn(msg: string, data?: unknown): void
}

export interface Member {
  pid: number
  start: string
}

/**
 * 文件每行一条。`members`:命令跑着时定时刷新、组长退出时再记一次的组员(组长不在后,靠它们认组)。
 * `boot`:Linux 的 boot_id —— 第 22 项是开机以来的滴答数,换一次开机就不能比
 */
export interface PgidEntry {
  pgid: number
  start: string
  boot?: string
  members?: Member[]
}

/** 进程表的一行:同一次读取里的 ppid 和启动时间,说的一定是同一个进程 */
export interface ProcRow {
  pid: number
  ppid: number
  pgid: number
  start: string
}

export type Kill = (pid: number, signal: NodeJS.Signals | 0) => unknown

/** 注入的函数:抛错 = 这次查不了(条目留到下次),返回 undefined = 进程不在 */
export interface ProcDeps {
  kill?: Kill
  startTime?: (pid: number) => string | undefined
  groupMembers?: (pgid: number) => Member[]
  /** 一次列出多个组的组员(定时刷新用,异步);返回 undefined = 这次列不出来 */
  listMembers?: (pgids: number[]) => Promise<Map<number, Member[]> | undefined>
  /** 本进程所在的组;拿不到 → 一律不发信号 */
  ownPgid?: () => number | undefined
  /** 本次开机的标识;Linux 必须有,其余平台不用 */
  bootId?: () => string | undefined
  /** 进程表的一次读取;抛错 = 这次读不了。注入了 kill 而没给它 → 空表(假 pid 不该碰真进程) */
  procTable?: () => ProcRow[]
  /** PgidRegistry:起始条目(reapOrphans 这次认不了、留到下次的),第一次写文件时一并写回 */
  seed?: PgidEntry[]
  /** 命令跑着时多久刷新一次组员,默认 2 s */
  refreshMs?: number
  log?: PgidLog
}

/** 每组最多记这么多组员 */
const MAX_MEMBERS = 32
const REFRESH_MS = 2_000
const PS = '/bin/ps'
const PS_TIMEOUT = 2_000
const PS_TREE_TIMEOUT = 3_000
/** 杀进程的路上读表:读不出来也不能把预算耗光 */
const PS_TABLE_TIMEOUT = 1_000
const PS_OPTS = { env: { LC_ALL: 'C' }, timeout: PS_TIMEOUT, stdio: ['ignore', 'pipe', 'ignore'] as ('ignore' | 'pipe')[] }
const nullLog: PgidLog = { warn() {} }

export const pgidFile = (dataDir: string) => join(dataDir, 'run', 'shell-pgids')

/** /proc/<pid>/stat 里 comm 之后的字段;fields[0] 是第 3 项 state。进程不在 → undefined,其余错误抛出 */
function procStat(pid: number | 'self'): string[] | undefined {
  let s: string
  try {
    s = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ESRCH') return undefined
    throw err
  }
  return s.slice(s.lastIndexOf(')') + 2).trim().split(' ')
}

/** 进程不在 → undefined;查不了(ps 超时 / 不在)→ 抛错 */
export function startTimeStrict(pid: number, platform: NodeJS.Platform): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  if (platform === 'linux') return procStat(pid)?.[19]
  if (platform === 'darwin') {
    try {
      return execFileSync(PS, ['-o', 'lstart=', '-p', String(pid)], PS_OPTS).toString().trim() || undefined
    } catch (err) {
      const e = err as { status?: number | null; stdout?: Buffer }
      if (e.status === 1 && !e.stdout?.toString().trim()) return undefined // 没有这个 pid
      throw err
    }
  }
  return undefined
}

/** 进程启动时间,原样字符串;进程不在 / 读不到 → undefined。Linux 第 22 项(时钟滴答),macOS `ps -o lstart=` */
export function startTime(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  try {
    return startTimeStrict(pid, platform)
  } catch {
    return undefined
  }
}

/** 整张进程表,一次读取(darwin 一次 ps;Linux 扫 /proc)。start 与 startTime 同格式。读不了 → 抛错 */
export function procTable(platform: NodeJS.Platform = process.platform): ProcRow[] {
  const rows: ProcRow[] = []
  if (platform === 'linux') {
    for (const n of readdirSync('/proc')) {
      if (!/^\d+$/.test(n)) continue
      let f: string[] | undefined
      try {
        f = procStat(Number(n))
      } catch {
        continue // 扫描途中退出的进程
      }
      if (f?.[19]) rows.push({ pid: Number(n), ppid: Number(f[1]), pgid: Number(f[2]), start: f[19] })
    }
  } else if (platform === 'darwin') {
    const text = execFileSync(PS, ['-Ao', 'pid=,ppid=,pgid=,lstart='], { ...PS_OPTS, timeout: PS_TABLE_TIMEOUT, maxBuffer: 16 * 1024 * 1024 }).toString()
    for (const line of text.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: m[4] })
    }
  }
  return rows
}

/** 从 roots 沿 ppid 往下走,不含 roots 自己 */
function walkDown(edges: Iterable<{ pid: number; ppid: number }>, roots: number[]): Set<number> {
  const kids = new Map<number, number[]>()
  for (const { pid, ppid } of edges) {
    const list = kids.get(ppid)
    if (list) list.push(pid)
    else kids.set(ppid, [pid])
  }
  const seen = new Set(roots)
  const out = new Set<number>()
  const todo = [...roots]
  while (todo.length) {
    for (const k of kids.get(todo.pop()!) ?? []) {
      if (seen.has(k)) continue
      seen.add(k)
      out.add(k)
      todo.push(k)
    }
  }
  return out
}

/**
 * root 的所有后代(不含 root)。ps 失败 → []。root ≤ 1 → []:从 init 往下就是全机。
 * 只有 pid 没有身份:要发信号的路径用 procTable + treeMembers,启动时间和 ppid 出自同一次读取
 */
export function descendants(root: number, ps: () => string = psTree): number[] {
  if (!validPgid(root)) return []
  try {
    const edges: { pid: number; ppid: number }[] = []
    for (const line of ps().split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
      if (m) edges.push({ pid: Number(m[1]), ppid: Number(m[2]) })
    }
    return [...walkDown(edges, [root])]
  } catch {
    return []
  }
}

function psTree(): string {
  return execFileSync(PS, ['-Ao', 'pid=,ppid='], { ...PS_OPTS, timeout: PS_TREE_TIMEOUT }).toString()
}

function scanProc(wanted: Set<number>): Map<number, Member[]> {
  const out = new Map<number, Member[]>([...wanted].map(g => [g, []]))
  for (const n of readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue
    let f: string[] | undefined
    try {
      f = procStat(Number(n))
    } catch {
      continue // 扫描途中退出的进程
    }
    const g = Number(f?.[2])
    if (f && wanted.has(g) && f[19]) out.get(g)!.push({ pid: Number(n), start: f[19] })
  }
  return out
}

function parsePs(text: string, wanted: Set<number>): Map<number, Member[]> {
  const out = new Map<number, Member[]>([...wanted].map(g => [g, []]))
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (m && wanted.has(Number(m[2]))) out.get(Number(m[2]))!.push({ pid: Number(m[1]), start: m[3] })
  }
  return out
}

const PS_ALL = ['-A', '-o', 'pid=,pgid=,lstart=']

function groupMembersStrict(pgid: number, platform: NodeJS.Platform): Member[] {
  const wanted = new Set([pgid])
  if (platform === 'linux') return scanProc(wanted).get(pgid)!
  if (platform === 'darwin') return parsePs(execFileSync(PS, PS_ALL, PS_OPTS).toString(), wanted).get(pgid)!
  return []
}

/** 组 pgid 里现有的进程及其启动时间;列不出来 → [] */
export function groupMembers(pgid: number, platform: NodeJS.Platform = process.platform): Member[] {
  try {
    return groupMembersStrict(pgid, platform)
  } catch {
    return []
  }
}

/** 一次列出多个组的组员;darwin 异步跑一次 ps。列不出来 → undefined */
export async function listMembers(pgids: number[], platform: NodeJS.Platform = process.platform): Promise<Map<number, Member[]> | undefined> {
  const wanted = new Set(pgids)
  try {
    if (platform === 'linux') return scanProc(wanted)
    if (platform === 'darwin') {
      const text = await new Promise<string>((res, rej) =>
        execFile(PS, PS_ALL, { env: PS_OPTS.env, timeout: PS_TIMEOUT, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? rej(err) : res(stdout))),
      )
      return parsePs(text, wanted)
    }
  } catch {
    // 下一轮再试
  }
  return undefined
}

/** 进程的组在这里不会变:查到一次就记住,查不到不记,下次再查。fork 用尽时 ps 起不来,而 kill 不需要 fork */
let ownCached: number | undefined

export function ownPgid(platform: NodeJS.Platform = process.platform): number | undefined {
  const mine = platform === process.platform
  if (mine && ownCached !== undefined) return ownCached
  try {
    const v =
      platform === 'linux' ? Number(procStat('self')?.[2])
      : platform === 'darwin' ? Number(execFileSync(PS, ['-o', 'pgid=', '-p', String(process.pid)], PS_OPTS).toString().trim())
      : NaN
    if (!Number.isInteger(v) || v <= 0) return undefined
    if (mine) ownCached = v
    return v
  } catch {
    return undefined
  }
}

/** Linux 的 boot_id;其余平台 undefined(macOS 的 lstart 是绝对时间,不需要) */
export function bootId(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'linux') return undefined
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

export interface Resolved {
  platform: NodeJS.Platform
  kill: Kill
  startTime: (pid: number) => string | undefined
  groupMembers: (pgid: number) => Member[]
  listMembers: (pgids: number[]) => Promise<Map<number, Member[]> | undefined>
  ownPgid: () => number | undefined
  bootId: () => string | undefined
  procTable: () => ProcRow[]
  refreshMs: number
  log: PgidLog
}

const once = <T>(fn: () => T): (() => T) => {
  let v: { v: T } | undefined
  return () => (v ??= { v: fn() }).v
}

export function resolveDeps(platform: NodeJS.Platform, d: ProcDeps): Resolved {
  return {
    platform,
    kill: d.kill ?? ((pid, sig) => process.kill(pid, sig)),
    startTime: d.startTime ?? (pid => startTimeStrict(pid, platform)),
    groupMembers: d.groupMembers ?? (pgid => groupMembersStrict(pgid, platform)),
    listMembers: d.listMembers ?? (pgids => listMembers(pgids, platform)),
    ownPgid: d.ownPgid ?? (() => ownPgid(platform)),
    bootId: once(d.bootId ?? (() => bootId(platform))),
    procTable: d.procTable ?? (d.kill ? () => [] : () => procTable(platform)),
    refreshMs: d.refreshMs ?? REFRESH_MS,
    log: d.log ?? nullLog,
  }
}

const validPgid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 1

/** 组还在吗;EPERM 也算在(组存在,只是不归我们) */
export function groupExists(pgid: number, kill: Kill): boolean {
  try {
    kill(-pgid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

type Verdict = 'ours' | 'not' | 'unknown'

/**
 * 这个组是不是登记时的那个。Linux 先比开机标识(启动时间是开机以来的滴答)。
 * 组长活着:它是会话首进程(detached → setsid),换不了组,启动时间一致就是;
 * 不一致 = pid 已被复用(组 id 在组存续期间不会被分给新进程,所以原组已不在)。
 * 组长已死:组里得有一个登记过的组员,pid 与启动时间都对得上(setpgid 只能在同一会话里换组)。
 * 查的过程中出错 → unknown(不杀,条目留到下次)。
 */
export function verify(e: PgidEntry, r: Resolved): Verdict {
  try {
    if (r.platform === 'linux') {
      const boot = r.bootId()
      if (boot === undefined) return 'unknown'
      if (e.boot !== boot) return 'not'
    }
    const lead = r.startTime(e.pgid)
    if (lead !== undefined) return lead === e.start ? 'ours' : 'not'
    const anchors = e.members ?? []
    if (!anchors.length) return 'not'
    return r.groupMembers(e.pgid).some(m => m.pid !== e.pgid && anchors.some(a => a.pid === m.pid && a.start === m.start)) ? 'ours' : 'not'
  } catch {
    return 'unknown'
  }
}

/** 给组发信号的唯一入口:不碰 pid ≤ 1、本进程、本进程所在的组;拿不到本组 id 时一律不发 */
export function signalGroup(pgid: number, sig: NodeJS.Signals, r: Resolved): boolean {
  const own = r.ownPgid()
  if (!validPgid(pgid) || pgid === process.pid || own === undefined || pgid === own) return false
  try {
    r.kill(-pgid, sig)
    return true
  } catch {
    return false
  }
}

/** 这张表里 roots 的后代,启动时间取自同一行(动手之前拍:父进程一死 ppid 链就断)。roots 必须已证明是自己的 */
export function treeMembers(rows: ProcRow[], roots: number[]): Member[] {
  const under = walkDown(rows, roots)
  return rows.filter(x => under.has(x.pid) && validPgid(x.pid) && x.pid !== process.pid).map(x => ({ pid: x.pid, start: x.start }))
}

/**
 * 给快照里的单个进程发信号:表里同一个 pid 的启动时间要和快照一致,否则(pid 被复用)或读不了表都不发。
 * 同样不碰 pid ≤ 1、本进程、本进程所在的组。rows 不给 → 现读一张。
 */
export function signalMembers(members: Member[], sig: NodeJS.Signals, r: Resolved, rows?: ProcRow[]): void {
  const own = r.ownPgid()
  const safe = members.filter(m => validPgid(m.pid) && m.pid !== process.pid && own !== undefined && m.pid !== own)
  if (!safe.length) return
  let table: ProcRow[]
  try {
    table = rows ?? r.procTable()
  } catch (err) {
    r.log.warn('process table unavailable, not signalled', { error: String(err) })
    return
  }
  const now = new Map(table.map(x => [x.pid, x.start]))
  for (const m of safe) {
    if (now.get(m.pid) !== m.start) continue
    try {
      r.kill(m.pid, sig)
    } catch {
      // 刚好退了
    }
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
    out.set(e.pgid, {
      pgid: e.pgid,
      start: e.start,
      ...(typeof e.boot === 'string' && e.boot && { boot: e.boot }),
      ...(members.length && { members }),
    })
  }
  return [...out.values()]
}

const serialize = (entries: Iterable<PgidEntry>) => [...entries].map(e => JSON.stringify(e) + '\n').join('')

/** 临时文件 + rename,0600 */
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  chmodSync(tmp, 0o600) // mode 受 umask 影响;reapOrphans 只认恰好 0600
  renameSync(tmp, file)
}

/** 只读本用户、0600 的普通文件;不跟随符号链接。不在 → undefined;不认 → 抛错 */
function readOwnFile(file: string): string | undefined {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  try {
    const st = fstatSync(fd)
    const uid = process.getuid?.()
    if (!st.isFile() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o777) !== 0o600) throw new Error('pgid file is not a private regular file')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** 上次崩在 write 与 rename 之间留下的临时文件 */
function removeStaleTemps(file: string): void {
  const dir = dirname(file)
  const re = new RegExp(`^${basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.tmp$`)
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    if (!re.test(n)) continue
    try {
      unlinkSync(join(dir, n))
    } catch {
      // 下次再删
    }
  }
}

export class PgidRegistry {
  private entries = new Map<number, PgidEntry>()
  /** 组长还在跑的组:定时刷新组员 */
  private running = new Set<number>()
  private timer: NodeJS.Timeout | undefined
  private inflight = new Set<Promise<void>>()
  private r: Resolved

  /** 上一个工作进程留下的条目由 reapOrphans 在建内核之前处理掉;它认不了的经 deps.seed 带进来 */
  constructor(
    private file: string,
    private platform: NodeJS.Platform = process.platform,
    deps: ProcDeps = {},
  ) {
    this.r = resolveDeps(platform, deps)
    for (const e of deps.seed ?? []) if (validPgid(e.pgid)) this.entries.set(e.pgid, e)
  }

  add(pgid: number): void {
    try {
      if (this.platform === 'win32' || !validPgid(pgid)) return
      const start = this.r.startTime(pgid)
      if (start === undefined) {
        this.r.log.warn('pgid start time unavailable, not registered', { pgid })
        return
      }
      const boot = this.r.bootId()
      this.entries.set(pgid, { pgid, start, ...(boot !== undefined && { boot }) })
      this.running.add(pgid)
      this.flush()
      this.schedule()
    } catch (err) {
      this.r.log.warn('pgid registry add failed', { error: String(err) })
    }
  }

  /** 组长结束后调用:整组已不在 → 删;还有后台进程 → 留着,并(异步)记下组员,之后靠它们认组 */
  settle(pgid: number): void {
    try {
      this.running.delete(pgid)
      this.schedule()
      if (!this.entries.has(pgid)) return
      if (!groupExists(pgid, this.r.kill)) {
        this.entries.delete(pgid)
        this.flush()
      } else this.refresh([pgid])
    } catch (err) {
      this.r.log.warn('pgid registry settle failed', { error: String(err) })
    }
  }

  /** 等进行中的组员刷新写完 */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight])
  }

  /** 仍存活、且能证明是自己起的组;顺手删掉已不在的 */
  live(): number[] {
    const out: number[] = []
    try {
      let changed = false
      for (const e of [...this.entries.values()]) {
        if (!groupExists(e.pgid, this.r.kill)) {
          this.entries.delete(e.pgid)
          this.running.delete(e.pgid)
          changed = true
        } else if (verify(e, this.r) === 'ours') out.push(e.pgid)
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
    this.dispose()
    try {
      this.entries.clear()
      this.flush()
    } catch (err) {
      this.r.log.warn('pgid registry clear failed', { error: String(err) })
    }
  }

  /** 停掉刷新定时器,文件不动 */
  dispose(): void {
    this.running.clear()
    this.schedule()
  }

  /** 有在跑的命令就开着定时器(unref,不拖住退出),没有就停 */
  private schedule(): void {
    if (this.running.size && !this.timer) {
      this.timer = setInterval(() => {
        if (!this.inflight.size) this.refresh([...this.running]) // 上一轮还没回来就跳过
      }, this.r.refreshMs)
      this.timer.unref()
    } else if (!this.running.size && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 一次列出这些组的组员,写回条目;列不出来 → 留着旧的 */
  private refresh(pgids: number[]): void {
    if (!pgids.length) return
    const p = (async () => {
      try {
        const map = await this.r.listMembers(pgids)
        if (!map) return
        let changed = false
        for (const g of pgids) {
          const e = this.entries.get(g)
          const now = (map.get(g) ?? []).filter(m => m.pid !== g).slice(0, MAX_MEMBERS)
          if (!e || !now.length || JSON.stringify(e.members) === JSON.stringify(now)) continue
          e.members = now
          changed = true
        }
        if (changed) this.flush()
      } catch (err) {
        this.r.log.warn('pgid member refresh failed', { error: String(err) })
      }
    })()
    this.inflight.add(p)
    void p.finally(() => this.inflight.delete(p))
  }

  private flush(): void {
    writeAtomic(this.file, serialize(this.entries.values()))
  }
}

/**
 * 工作进程启动时(内核建好之前)处理上一个工作进程留下的组(spec §12):能证明是自己的 → 先拍后代快照,SIGKILL 整组,再杀快照里还是原进程的;
 * pid 被复用 / 别的开机 / 认不出 → 跳过并丢掉;这次查不了(ps 失败等)→ 跳过并留到下次。
 * 文件不在、不是本用户 0600 的普通文件 → 什么都不做。
 */
export interface ReapResult {
  killed: number[]
  skipped: number[]
  /** 这次认不了、写回文件留到下次的条目;交给新的 PgidRegistry 的 seed,免得它第一次写文件时冲掉 */
  kept: PgidEntry[]
}

/** 从组长和现有组员往下走(组长可能已经不在了),一张表。pgid 必须已证明是自己的;读不了 → [] */
function groupTree(pgid: number, r: Resolved): Member[] {
  try {
    const rows = r.procTable()
    return treeMembers(rows, [pgid, ...rows.filter(x => x.pgid === pgid).map(x => x.pid)])
  } catch (err) {
    r.log.warn('process tree snapshot failed', { error: String(err) })
    return []
  }
}

export function reapOrphans(file: string, opts: ProcDeps & { platform?: NodeJS.Platform } = {}): ReapResult {
  const platform = opts.platform ?? process.platform
  const r = resolveDeps(platform, opts)
  const keep: PgidEntry[] = []
  const res: ReapResult = { killed: [], skipped: [], kept: keep }
  if (platform === 'win32') return res
  removeStaleTemps(file)
  let text: string | undefined
  try {
    text = readOwnFile(file)
  } catch (err) {
    r.log.warn('pgid file refused', { error: String(err) })
    return res
  }
  if (text === undefined) return res
  try {
    for (const e of parseEntries(text)) {
      if (!groupExists(e.pgid, r.kill)) continue
      const v = verify(e, r)
      // 后代自成一组时组信号碰不到它们;认过的组才去看进程树。快照在杀组之前:父进程一死 ppid 链就断
      const tree = v === 'ours' && r.ownPgid() !== undefined ? groupTree(e.pgid, r) : []
      if (v === 'ours' && signalGroup(e.pgid, 'SIGKILL', r)) {
        res.killed.push(e.pgid)
        signalMembers(tree, 'SIGKILL', r)
      } else {
        res.skipped.push(e.pgid)
        if (v === 'unknown' || (v === 'ours' && r.ownPgid() === undefined)) keep.push(e)
      }
    }
  } catch (err) {
    r.log.warn('pgid reap failed', { error: String(err) })
  }
  try {
    if (text) writeAtomic(file, serialize(keep))
  } catch (err) {
    r.log.warn('pgid file truncate failed', { error: String(err) })
  }
  if (res.killed.length || res.skipped.length) r.log.warn('reaped orphan process groups', { killed: res.killed, skipped: res.skipped, kept: keep.map(e => e.pgid) })
  return res
}

/** 正常关闭:登记中仍存活的组先 SIGTERM,graceMs 内没退净再 SIGKILL;然后清空登记 */
export async function killLive(registry: PgidRegistry, graceMs = 1000): Promise<void> {
  registry.dispose()
  await registry.idle() // 组长刚退时的组员记录要先写完,否则认不出组
  const sent = registry.live().filter(g => registry.signal(g, 'SIGTERM'))
  if (sent.length) {
    const end = Date.now() + graceMs
    while (Date.now() < end && sent.some(g => registry.exists(g))) await new Promise(res => setTimeout(res, 25))
    // SIGTERM 时已认过组;宽限期内组退净又被别人重建需要 pid 绕一圈,不再重认(组长可能正是被 SIGTERM 杀掉的)
    for (const g of sent) if (registry.exists(g)) registry.signal(g, 'SIGKILL')
  }
  registry.clear()
}
