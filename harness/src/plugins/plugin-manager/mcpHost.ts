// MCP 宿主(09 spec §10.3):每会话每服务一个进程,用到才起。第三方代码跑在没有家目录的沙箱里,这里是唯一启动它的地方。
// 起之前全部重查:记录、授权、完整性、同意的那一条、cwd、程序。任何一步不对都是稳定代码,绝不退回无沙箱。
// 停进程走 killLadder,登记走 pgids:kernel.close 的 killLive 和崩溃后的 reapOrphans 都认得
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants as fsConstants, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Logger } from '../../kernel/log'
import { HARNESS_VERSION } from '../../kernel/version'
import { pluginStoreRootOf } from '../../lib/fs/paths'
import { DEFAULT_CALL_MS, DEFAULT_INIT_MS, McpClient, McpError, type McpTimers, type McpTool } from '../../lib/mcp/client'
import { LineTransport, MAX_LINE, type LineStreams } from '../../lib/mcp/stdio'
import { scrub } from '../../lib/memory/scrub'
import { effectiveGrants, escapeDisplay, sameConsentedServer, type Declared } from '../../lib/plugins/consent'
import { readPlugin } from '../../lib/plugins/read'
import type { Cwd, ParsedServer } from '../../lib/plugins/types'
import { groupExists, groupMembers, type PgidRegistry } from '../../lib/proc/pgids'
import { killLadder } from '../../lib/proc/tree'
import { realSpelling, within } from '../../lib/sandbox/paths'
import { shellEnv } from '../../lib/tools/shellEnv'
import type { SandboxService, ShellPlan } from '../../lib/tools/types'
import type { KernelEvent, SessionOrigin } from '../../protocol/index'
import { MCP_SERVER_NAME } from '../../protocol/index'
import { usable, type SkillCatalog } from './context'
import type { InstalledRecord, PluginStore } from './store'

export const IDLE_MS = 600_000
export const MAX_PER_SESSION = 4
export const MAX_SERVERS = 8
const FAILURE_WINDOW_MS = 600_000
const MAX_FAILURES = 3
const CONSECUTIVE_TIMEOUTS = 3
/** SIGKILL 之后等 exit 事件的上限;killPlugin 等一个还没到 spawn 的启动也是这么久 */
const AFTER_KILL_MS = 1000
const STALL_MS = 3000
const SEEN_MAX = 2048
const CLIENT_INFO = { name: 'mff-ai', version: HARNESS_VERSION }

export class McpHostError extends Error {
  constructor(
    readonly code: string,
    readonly reason?: string,
  ) {
    super(reason === undefined ? code : `${code}: ${reason}`)
    this.name = 'McpHostError'
  }
}
const refuse = (code: string, reason?: string) => new McpHostError(code, reason)

export function declaredOf(rec: Pick<InstalledRecord, 'consent'>): Record<string, Declared | null> {
  return Object.fromEntries(rec.consent.mcp.map(m => [m.name, m.declared]))
}

const isProgram = (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

interface Located {
  real: string
  /** PATH 上找到它的位置;nvm 的 npx 真身在 lib 下,node 却在这里的 bin 旁边 */
  hit?: string
  viaPath: boolean
}

function locate(command: string, root: string, path: string): Located | undefined {
  if (command.startsWith('/')) return isProgram(command) ? { real: realpathSync.native(command), viaPath: false } : undefined
  const rel = command.startsWith('${PLUGIN_ROOT}/') ? command.slice('${PLUGIN_ROOT}/'.length) : command
  if (rel.includes('/') || rel !== command) {
    const inRoot = resolve(root, rel)
    if (!isProgram(inRoot)) return undefined
    const real = realpathSync.native(inRoot)
    return within(real, realpathSync.native(root)) ? { real, viaPath: false } : undefined
  }
  for (const dir of path.split(':')) {
    if (!isAbsolute(dir)) continue // 相对项相对 cwd 解析,仓库里放什么跑什么
    const hit = join(dir, command)
    // hit 的目录也取真实拼写:和家目录比的时候不能被 PATH 里的链接骗过
    if (isProgram(hit)) return { real: realpathSync.native(hit), hit: join(realpathSync.native(dir), command), viaPath: true }
  }
  return undefined
}

/** 找到的程序的真实路径。根内、绝对路径、PATH(只认绝对项),从不相对 cwd */
export function resolveProgram(command: string, root: string, path: string): string | undefined {
  return locate(command, root, path)?.real
}

/** 家目录下认得的运行时布局,只认真实路径:整棵放回。不在表里的只放回程序自己的目录,跑不起来是看得见的,表从实测里长 */
const HOME_RUNTIMES: readonly string[][] = [
  ['.nvm', 'versions', 'node', '*'],
  ['.fnm', 'node-versions', '*'],
  ['.volta', 'tools', 'image', 'node', '*'],
  ['.asdf', 'installs', '*', '*'],
  ['.local', 'share', 'mise', 'installs', '*', '*'],
  ['.pyenv', 'versions', '*'],
  ['.rbenv', 'versions', '*'],
  ['.local', 'share', 'uv', 'tools', '*'],
  ['.local', 'share', 'uv', 'python', '*'],
  ['.local', 'pipx', 'venvs', '*'],
  ['.bun', 'install', 'global'],
]

function knownRuntime(real: string, home: string): string | undefined {
  if (!within(real, home) || real === home) return undefined
  const segs = real.slice(home.length + 1).split('/')
  // 程序要在根的里面:根本身不算
  const hit = HOME_RUNTIMES.find(l => segs.length > l.length && l.every((p, i) => p === '*' || p === segs[i]))
  return hit && join(home, ...segs.slice(0, hit.length))
}

/**
 * 只有纯名字经 PATH 解析的程序才放回东西(M15):插件写的绝对路径不算,否则它能自己点要放开家目录的哪一块。
 * 家目录里只放回程序自己的目录(C1):上两级的 ~/Library、~/.cargo、~/.local 里全是别人的登录态。
 * 那个目录就是家目录或它的直接子目录 → runtime_too_broad。真实路径落在认得的布局里才放回整棵。
 * 家目录外本来读得到;在隐藏的根里的上两级,等于根本身或更高的放回去就白隐藏了
 */
export function runtimeRoots(realProgram: string, home: string, viaPath: boolean, tops: string[] = [], hit: string = realProgram): string[] {
  if (!viaPath) return []
  const out = new Set<string>()
  for (const p of [hit, realProgram]) {
    const dir = dirname(p)
    if (within(dir, home)) {
      if (dir === home || dirname(dir) === home) throw refuse('runtime_too_broad')
      out.add(dir)
      continue
    }
    const root = dirname(dir)
    if (tops.some(t => root !== t && within(root, t))) out.add(root)
  }
  const known = knownRuntime(realProgram, home)
  if (known) out.add(known)
  return [...out]
}

/**
 * 这条放回的路径会让隐藏失效,或者让计划跑不起来:里面有隐藏的根或数据目录(数据目录在里面时,tmp、落盘、
 * 服务数据都被 nested 再拒一次),或者它自己在数据目录里(沙箱会把它从 keep 里丢掉)。两种拼写都算过
 */
export function heldTop(kept: string, tops: string[], dataDir: string): boolean {
  const real = realSpelling(kept)
  const data = realSpelling(dataDir)
  return within(real, data) || within(data, real) || tops.some(t => within(realSpelling(t), real))
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export interface ServerInfo {
  hosts: string[]
  cwd: Cwd
  /** 完整性、域名、cwd 授权:本会话放行的键带着它(M20) */
  epoch: string
  level: 'full' | 'partial'
  /** 同意页上这个服务的命令或参数是打码显示的 */
  configMasked: boolean
  untranslatedPaths: number
}

export interface ServerRow {
  plugin: string
  server: string
  sessionId: string
  state: string
  reason?: string
  pid?: number
}

interface Entry {
  key: string
  sessionId: string
  plugin: string
  server: string
  state: 'starting' | 'running' | 'stopping'
  busy: number
  lastUsed: number
  /** 已授权变化、禁用、卸载、关内核:起到一半的不能再 spawn */
  aborted: boolean
  ready: Promise<void>
  pid?: number
  child?: ChildProcess
  client?: McpClient
  plan?: ShellPlan
  tmpRoot?: string
  exited: boolean
  exit: Promise<void>
  onExit: () => void
  gone: Promise<void>
  onGone: () => void
  stopping?: Promise<void>
  idle?: unknown
}

export interface McpHostOpts {
  sandbox: SandboxService
  sessions: { get(id: string): { cwd?: string; origin: SessionOrigin } | undefined }
  store: Pick<PluginStore, 'get' | 'list' | 'verify' | 'versionDir' | 'dataDirOf' | 'pluginDataRoot'>
  catalog: Pick<SkillCatalog, 'of'>
  secrets: { get(k: string): Promise<string | undefined> }
  pgids?: Pick<PgidRegistry, 'add' | 'settle'>
  spawn?: typeof nodeSpawn
  now: () => number
  timers: McpTimers
  log: Pick<Logger, 'warn'>
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): unknown
  loginPath: () => Promise<string>
  dataDir: string
  home: string
  env: NodeJS.ProcessEnv
  /** 完整性不符:记录关掉,写事件 */
  onIntegrityFailed(rec: InstalledRecord): void
}

const isSet = (rec: InstalledRecord, key: string) => Object.hasOwn(rec.settings, key) || rec.secretKeys.includes(key)
const bareVar = /^([A-Za-z_][A-Za-z0-9_]{0,63})(?::?[-=?+].*)?$/s
const configRef = /^user_config\.([A-Za-z_][A-Za-z0-9_]{0,63})$/
const REF = /\$\{([^}]*)\}/g

export class McpHost {
  private readonly entries = new Map<string, Entry>()
  private readonly failures = new Map<string, number[]>()
  /** 10 分钟内失败到顶:到插件重启或授权变化 */
  private readonly sticky = new Map<string, string>()
  /** 不算失败但状态要说的(程序不在):再试一次还会再查 */
  private readonly notes = new Map<string, string>()
  /** (会话、服务)→ 工具 → 第一次见到的说明和 schema 的哈希。工具名是服务给的,所以是 Map */
  private readonly seen = new Map<string, Map<string, string>>()
  private readonly lastStatus = new Map<string, string>()
  private readonly reported = new Set<string>()
  private readonly spawn: typeof nodeSpawn
  private starts = 0
  private closed = false

  constructor(private readonly o: McpHostOpts) {
    this.spawn = o.spawn ?? nodeSpawn
  }

  private keyOf(sessionId: string, plugin: string, server: string) {
    return `${sessionId}\0${plugin}/${server}`
  }

  // ---------- 查状态(permission 同步调;不起任何东西)----------

  private sandboxBlocked(sessionId?: string): boolean {
    const st = this.o.sandbox.status(sessionId)
    return st.level === 'none' || st.missing.includes('netns')
  }

  private serverOf(rec: InstalledRecord, server: string): ParsedServer {
    const parsed = this.o.catalog.of(rec)
    if (!parsed) throw refuse('plugin_unreadable')
    const srv = parsed.servers.find(s => s.name === server)
    if (!srv) throw refuse('server_not_found')
    return srv
  }

  private grantOf(rec: InstalledRecord, server: string): { network: string[]; cwd: Cwd } {
    // installed.json 没有按声明校验:每次都重算,超出声明的按没有这回事处理(失败方向是关)
    const eff = effectiveGrants(declaredOf(rec), rec.grants)
    if (!eff.ok || !Object.hasOwn(eff.grants.servers, server)) throw refuse('grants_invalid')
    const g = eff.grants.servers[server]
    return { network: [...g.network].sort(), cwd: g.cwd }
  }

  /** 视图之后的查询:启用 → 服务状态。都是稳定代码 */
  inspect(sessionId: string, plugin: string, server: string): ServerInfo {
    const rec = this.o.store.get(plugin)
    if (!rec) throw refuse('plugin_not_installed')
    if (!usable(rec)) throw refuse('plugin_disabled')
    const srv = this.serverOf(rec, server)
    if (srv.problems.length > 0) throw refuse('server_problem', srv.problems[0])
    if (this.sandboxBlocked(sessionId)) throw refuse('needs_sandbox')
    if (rec.config.some(c => c.required && srv.configRefs.includes(c.key) && !isSet(rec, c.key))) throw refuse('needs_config')
    const failed = this.sticky.get(this.keyOf(sessionId, plugin, server))
    if (failed !== undefined) throw refuse('server_failed', failed)
    const g = this.grantOf(rec, server)
    const cwd = this.o.sessions.get(sessionId)?.cwd
    if (cwd === undefined) throw refuse('no_session')
    const entry = rec.consent.mcp.find(m => m.name === server)
    const st = this.o.sandbox.status(sessionId)
    return {
      hosts: g.network,
      cwd: g.cwd,
      epoch: sha(`${rec.integrity}|${g.network.join(',')}|${g.cwd}`).slice(0, 8),
      level: st.level === 'full' ? 'full' : 'partial',
      configMasked: (entry?.argsMasked.length ?? 0) > 0 || scrub(escapeDisplay(srv.command)).masked > 0,
      untranslatedPaths: this.o.sandbox.execPolicy(sessionId, cwd).untranslatedPaths ?? 0,
    }
  }

  isRunning(sessionId: string, plugin: string, server: string): boolean {
    return this.entries.get(this.keyOf(sessionId, plugin, server))?.state === 'running'
  }

  failureCount(sessionId: string, plugin: string, server: string): number {
    return this.failures.get(this.keyOf(sessionId, plugin, server))?.length ?? 0
  }

  // ---------- 状态 ----------

  private rowOf(rec: InstalledRecord, srv: ParsedServer, sessionId: string): ServerRow {
    const base = { plugin: rec.id, server: srv.name, sessionId }
    const key = this.keyOf(sessionId, rec.id, srv.name)
    const e = this.entries.get(key)
    if (e) return { ...base, state: e.state, ...(e.pid !== undefined && { pid: e.pid }) }
    if (srv.problems.length > 0) return { ...base, state: 'problem', reason: srv.problems[0] }
    const stuck = this.sticky.get(key) ?? this.notes.get(key)
    if (stuck !== undefined) return { ...base, state: 'server_failed', reason: stuck }
    if (this.sandboxBlocked(sessionId)) return { ...base, state: 'needs_sandbox' }
    if (rec.config.some(c => c.required && srv.configRefs.includes(c.key) && !isSet(rec, c.key))) return { ...base, state: 'needs_config' }
    return { ...base, state: 'stopped' }
  }

  /** 给了会话:这个会话看到的每个启用的服务。没给:活着的和失败的 */
  status(sessionId?: string): ServerRow[] {
    const recs = this.o.store.list().filter(usable)
    if (sessionId !== undefined) return recs.flatMap(rec => (this.o.catalog.of(rec)?.servers ?? []).filter(s => MCP_SERVER_NAME.test(s.name)).map(s => this.rowOf(rec, s, sessionId)))
    const rows: ServerRow[] = [...this.entries.values()].map(e => ({ plugin: e.plugin, server: e.server, sessionId: e.sessionId, state: e.state, ...(e.pid !== undefined && { pid: e.pid }) }))
    for (const [from, state] of [[this.sticky, 'server_failed'], [this.notes, 'server_failed']] as const)
      for (const [key, reason] of from) {
        if (this.entries.has(key)) continue
        const [sid, ref] = key.split('\0')
        const [plugin, server] = ref.split('/')
        if (!rows.some(r => r.plugin === plugin && r.server === server && r.sessionId === sid)) rows.push({ plugin, server, sessionId: sid, state, reason })
      }
    return rows
  }

  /** plugins.get:跨会话的一行。有在跑的就是 running */
  stateAcross(rec: InstalledRecord, server: string): { state: string; reason?: string } {
    const suffix = `\0${rec.id}/${server}`
    for (const e of this.entries.values()) if (e.key.endsWith(suffix)) return { state: e.state }
    for (const from of [this.sticky, this.notes]) for (const [key, reason] of from) if (key.endsWith(suffix)) return { state: 'server_failed', reason }
    return this.sandboxBlocked() ? { state: 'needs_sandbox' } : { state: 'stopped' }
  }

  /** mcp 的 list:现在启用的服务及状态,什么都不启动 */
  listFor(sessionId: string): string[] {
    return this.status(sessionId)
      .map(r => `${r.plugin}/${r.server} ${r.state}${r.reason === undefined ? '' : `: ${r.reason}`}`)
      .sort()
  }

  private emit(sessionId: string, plugin: string, server: string, state: string, reason?: string, force = false): void {
    if (this.closed) return
    const key = this.keyOf(sessionId, plugin, server)
    const line = `${state}|${reason ?? ''}`
    if (!force && this.lastStatus.get(key) === line) return
    this.lastStatus.set(key, line)
    try {
      this.o.append({ type: 'plugins.mcp.status', sessionId, payload: { plugin, server, state, ...(reason !== undefined && { reason }) } })
    } catch (err) {
      this.o.log.warn('mcp status not recorded', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
  }

  private countFailure(e: Entry, code: string): void {
    const now = this.o.now()
    const recent = (this.failures.get(e.key) ?? []).filter(t => now - t < FAILURE_WINDOW_MS)
    recent.push(now)
    this.failures.set(e.key, recent)
    if (recent.length >= MAX_FAILURES) this.sticky.set(e.key, code)
  }

  // ---------- 取进程 ----------

  private victim(sessionId: string): { wait?: Promise<void>; stop?: Entry } | undefined {
    const all = [...this.entries.values()]
    const mine = all.filter(e => e.sessionId === sessionId)
    const sessionFull = mine.length >= MAX_PER_SESSION
    if (!sessionFull && all.length < MAX_SERVERS) return undefined
    const scope = sessionFull ? mine : all
    const leaving = scope.find(e => e.state === 'stopping')
    if (leaving) return { wait: leaving.gone }
    const idle = scope.filter(e => e.state === 'running' && e.busy === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0]
    if (!idle) throw refuse('too_many_servers')
    return { stop: idle }
  }

  private async acquire(sessionId: string, plugin: string, server: string, mayStart: boolean, signal?: AbortSignal): Promise<Entry> {
    const key = this.keyOf(sessionId, plugin, server)
    for (;;) {
      if (this.closed) throw refuse('server_stopped')
      const e = this.entries.get(key)
      if (e?.state === 'running') {
        e.busy++
        e.lastUsed = this.o.now()
        return e
      }
      if (e?.state === 'stopping') {
        await e.gone
        continue
      }
      if (e?.state === 'starting') {
        await abortable(e.ready, signal)
        continue
      }
      if (!mayStart) throw refuse('server_not_running')
      this.inspect(sessionId, plugin, server)
      // 查和占之间没有 await:并发的启动不会一起挤过上限
      const room = this.victim(sessionId)
      if (room?.wait) {
        await room.wait
        continue
      }
      if (room?.stop) {
        await this.stop(room.stop)
        continue
      }
      await abortable(this.begin(key, sessionId, plugin, server).ready, signal)
    }
  }

  private begin(key: string, sessionId: string, plugin: string, server: string): Entry {
    let onExit = () => {}
    let onGone = () => {}
    const exit = new Promise<void>(res => (onExit = res))
    const gone = new Promise<void>(res => (onGone = res))
    const e: Entry = { key, sessionId, plugin, server, state: 'starting', busy: 0, lastUsed: this.o.now(), aborted: false, ready: Promise.resolve(), exited: false, exit, onExit, gone, onGone }
    this.entries.set(key, e)
    e.ready = this.launch(e).catch(async err => {
      await this.abandon(e)
      throw err
    })
    e.ready.catch(() => {}) // 等它的调用方各自处理;没人等时不算未处理
    return e
  }

  /** 没走到运行的启动:还没进程就直接收尾 */
  private async abandon(e: Entry): Promise<void> {
    if (e.pid !== undefined) return this.stop(e)
    e.state = 'stopping'
    this.finalize(e)
  }

  /** 配置值只在这里进环境变量;这个对象之后只交给沙箱计划和 spawn */
  private async declaredEnv(rec: InstalledRecord, srv: ParsedServer, paths: Record<string, string>): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    const values = new Map<string, string | undefined>()
    const fetch = async (k: string) => {
      if (values.has(k)) return
      let v: string | undefined
      // 只读记录里有的键:别的键名根本问不到 secret(Task 5 m4)
      if (rec.secretKeys.includes(k)) {
        try {
          v = await this.o.secrets.get(`${rec.id}/${k}`)
        } catch {
          throw refuse('secrets_unavailable')
        }
      } else if (Object.hasOwn(rec.settings, k)) v = rec.settings[k]
      values.set(k, v)
    }
    const keyIn = (inner: string) => configRef.exec(inner)?.[1] ?? (Object.hasOwn(paths, inner) ? undefined : bareVar.exec(inner)?.[1])
    for (const e of srv.env) {
      const text = e.source === 'literal' ? e.value : e.template
      if (text === undefined) continue
      for (const m of text.matchAll(REF)) {
        const k = keyIn(m[1])
        if (k !== undefined) await fetch(k)
      }
      let missing = text.replace(REF, '').includes('${')
      // 一趟替换:值里的 ${…} 是值,不再展开
      const value = text.replace(REF, (_all, inner: string) => {
        if (Object.hasOwn(paths, inner)) return paths[inner]
        const v = values.get(keyIn(inner) ?? '')
        if (v === undefined) missing = true
        return v ?? ''
      })
      if (!missing) out[e.name] = value
      else if (e.required) throw refuse('needs_config')
    }
    return out
  }

  private expandArgs(rec: InstalledRecord, srv: ParsedServer, paths: Record<string, string>): string[] {
    return srv.args.map(a =>
      a.replace(REF, (_all, inner: string) => {
        if (Object.hasOwn(paths, inner)) return paths[inner]
        const k = configRef.exec(inner)?.[1]
        // 像密钥的值进了 secrets:不进 argv
        if (k === undefined || rec.secretKeys.includes(k)) throw refuse('server_problem', 'arg_env_ref')
        return Object.hasOwn(rec.settings, k) ? rec.settings[k] : ''
      }),
    )
  }

  /** 每一层都是真目录才给;不存在就建这一层。不穿过链接写东西 */
  private plainDataDir(plugin: string, server: string): string {
    let dir: string
    try {
      dir = this.o.store.dataDirOf(plugin, server)
    } catch {
      throw refuse('server_problem', 'name_invalid')
    }
    const pluginRoot = this.o.store.pluginDataRoot(plugin)
    for (const level of [dirname(pluginRoot), pluginRoot, dir]) {
      let st
      try {
        st = lstatSync(level)
      } catch {
        mkdirSync(level, { mode: 0o700 })
        continue
      }
      if (!st.isDirectory()) throw refuse('data_dir_unsafe')
    }
    return dir
  }

  private async launch(e: Entry): Promise<void> {
    const { sessionId, plugin, server } = e
    const o = this.o
    const stillWanted = (rec: InstalledRecord) => {
      if (e.aborted || this.closed) throw refuse('server_stopped')
      if (o.store.get(plugin) !== rec) throw refuse('grants_changed')
    }

    const rec = o.store.get(plugin)
    if (!rec || !usable(rec)) throw refuse('plugin_disabled')
    const session = o.sessions.get(sessionId)
    if (!session?.cwd) throw refuse('no_session')
    const cwd = session.cwd
    // 自己再查一次级别:不靠 permission(),级别可能刚变
    if (this.sandboxBlocked(sessionId)) throw refuse('needs_sandbox')
    const g = this.grantOf(rec, server)

    // M13:存储里的字节每次起之前重算;不符就这个插件关掉
    if (!o.store.verify(rec)) {
      o.onIntegrityFailed(rec)
      void this.killPlugin(plugin).catch(() => {})
      throw refuse('integrity_failed')
    }
    // 只用同意过的那一份:刚校验过的树现读,缓存可能是校验之前读的
    const root = o.store.versionDir(rec)
    const read = readPlugin(root, { nameHint: rec.id, reservedIds: new Set(), kernelVersion: HARNESS_VERSION, home: o.home })
    if (!read.ok) throw refuse('plugin_unreadable')
    const srv = read.plugin.servers.find(s => s.name === server)
    if (!srv) throw refuse('server_not_found')
    const consented = rec.consent.mcp.find(m => m.name === server)
    if (!consented || !sameConsentedServer(srv, consented)) throw refuse('consent_mismatch')
    if (srv.problems.length > 0) throw refuse('server_problem', srv.problems[0])
    if (rec.config.some(c => c.required && srv.configRefs.includes(c.key) && !isSet(rec, c.key))) throw refuse('needs_config')

    const store = pluginStoreRootOf(o.dataDir)
    const tmpReal = realSpelling(tmpdir())
    const baseTops = [...new Set([o.home, store, tmpReal, '/tmp'])]
    const realCwd = realSpelling(cwd)
    if (heldTop(cwd, baseTops, o.dataDir) || within(realCwd, realSpelling(store))) throw refuse('cwd_too_broad')

    const loginPath = await o.loginPath().catch(() => '')
    stillWanted(rec)
    const base = shellEnv(o.env, { platform: process.platform, home: o.home, loginPath })
    delete base.USERPROFILE
    const located = locate(srv.command, root, base.PATH ?? '')
    if (!located) {
      o.log.warn('mcp program not found', { plugin, server })
      this.notes.set(e.key, 'program_not_found')
      this.emit(sessionId, plugin, server, 'server_failed', 'program_not_found')
      throw refuse('server_failed', 'program_not_found')
    }
    this.notes.delete(e.key)
    const realTops = baseTops.map(realSpelling)
    const realHome = realSpelling(o.home)
    const inTop = (p: string) => [...realTops, realSpelling(o.dataDir)].some(t => within(p, t))
    // 字符串检查之外再看真身(链接):绝对路径不能指进家目录、别的插件或临时目录。根内和 PATH 的不走这里
    if (srv.command.startsWith('/') && inTop(located.real)) throw refuse('bad_command')
    if (located.viaPath && (within(located.real, realSpelling(store)) || within(located.real, realSpelling(o.dataDir)))) throw refuse('bad_command')
    const roots = runtimeRoots(located.real, realHome, located.viaPath, realTops, located.hit)
    if (roots.some(k => heldTop(k, baseTops, o.dataDir))) throw refuse('keep_too_broad')

    const data = this.plainDataDir(plugin, server)
    const spill = join(data, '.spill')
    // 这个目录服务写得到:上次可能留了个链接。删链接不跟随;沙箱规则按它的两种拼写放开,所以每次都是新的空目录
    rmSync(spill, { recursive: true, force: true })
    mkdirSync(spill, { mode: 0o700 })
    const hash = sha(`${plugin}/${server}`).slice(0, 12)
    e.tmpRoot = join(o.dataDir, 'sessions', sessionId, 'mcp', hash)
    rmSync(e.tmpRoot, { recursive: true, force: true })
    const tmp = join(e.tmpRoot, 'tmp')
    mkdirSync(tmp, { recursive: true, mode: 0o700 })

    const paths = { PLUGIN_ROOT: root, PLUGIN_DATA: data, PROJECT_DIR: g.cwd === 'none' ? data : cwd }
    const args = this.expandArgs(rec, srv, paths)
    const declared = await this.declaredEnv(rec, srv, paths)
    stillWanted(rec)
    const env: NodeJS.ProcessEnv = { ...base, ...declared, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, MFF_PLUGIN_ROOT: root, MFF_PLUGIN_DATA: data, HOME: data }

    const policy = o.sandbox.execPolicy(sessionId, cwd)
    let plan: ShellPlan
    try {
      plan = await o.sandbox.planExec(located.real, args, { sessionId, cwd, spillDir: spill }, env, {
        allowRead: [data],
        allowWrite: [data],
        allowHosts: g.network,
        exactHosts: true,
        proxyScope: `mcp_${sha(`${plugin}/${server}/${++this.starts}`).slice(0, 12)}`,
        readOnly: g.cwd !== 'write',
        denyRead: policy.ruleDenyRead,
        denyWrite: policy.ruleDenyWrite,
        hide: { tops: g.cwd === 'none' ? [...baseTops, cwd] : baseTops, keep: [...new Set([...(g.cwd === 'none' ? [] : [cwd]), root, ...roots])] },
        tmpDir: tmp,
      })
    } catch (err) {
      o.log.warn('mcp sandbox plan failed', { plugin, server, error: err instanceof Error ? err.name : 'unknown' })
      throw refuse('sandbox_unavailable')
    }
    e.plan = plan
    if (!plan.sandboxed || plan.level === 'none') {
      plan.release()
      throw refuse('needs_sandbox')
    }
    try {
      stillWanted(rec)
    } catch (err) {
      plan.release()
      throw err
    }

    this.emit(sessionId, plugin, server, 'starting')
    let child: ChildProcess
    try {
      child = this.spawn(plan.file, plan.args, { cwd: g.cwd === 'none' ? data : cwd, env: plan.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      plan.release()
      this.noteSpawnFailure(e)
      throw refuse('spawn_failed')
    }
    e.child = child
    child.on('error', () => {
      // pid 还在的 error 是信号发不出去;没有 pid 的下面处理
    })
    if (child.pid === undefined) {
      plan.release()
      this.noteSpawnFailure(e)
      throw refuse('spawn_failed')
    }
    const pid = child.pid
    e.pid = pid
    o.pgids?.add(pid)
    // exit,不是 close:脱离出去的孙进程拿着 stderr 时 close 一直不来
    child.once('exit', () => this.onExit(e))
    const transport = new LineTransport(child as unknown as LineStreams, { maxLine: MAX_LINE })
    const client = new McpClient(transport, { timers: o.timers, initMs: DEFAULT_INIT_MS, callMs: DEFAULT_CALL_MS, clientInfo: CLIENT_INFO })
    e.client = client
    transport.onClose(why => {
      if (e.state !== 'stopping') void this.stop(e, why === 'overflow' ? 'protocol_error' : 'server_exited')
    })
    try {
      await client.initialize()
    } catch (err) {
      const code = err instanceof McpError ? err.code : 'protocol_error'
      if (e.state === 'stopping' && e.aborted) throw refuse('server_stopped')
      await this.stop(e, code)
      throw refuse(code)
    }
    if (e.aborted || this.closed) {
      await this.stop(e)
      throw refuse('server_stopped')
    }
    e.state = 'running'
    e.lastUsed = o.now()
    this.armIdle(e, IDLE_MS)
    this.emit(sessionId, plugin, server, 'running')
  }

  private noteSpawnFailure(e: Entry): void {
    this.countFailure(e, 'spawn_failed')
    if (this.sticky.has(e.key)) this.emit(e.sessionId, e.plugin, e.server, 'server_failed', 'spawn_failed')
  }

  private armIdle(e: Entry, ms: number): void {
    e.idle = this.o.timers.setTimeout(() => {
      if (e.state !== 'running') return
      const left = IDLE_MS - (this.o.now() - e.lastUsed)
      if (e.busy > 0) return this.armIdle(e, IDLE_MS)
      if (left > 0) return this.armIdle(e, left)
      void this.stop(e)
    }, ms)
  }

  private onExit(e: Entry): void {
    e.exited = true
    if (e.pid !== undefined) this.o.pgids?.settle(e.pid)
    e.plan?.release()
    e.onExit()
    if (this.closed) return this.finalize(e)
    if (e.state !== 'stopping') void this.stop(e, 'server_exited')
  }

  /** failure:没人要它停,是它出了问题,算一次失败 */
  private stop(e: Entry, failure?: string): Promise<void> {
    if (e.stopping) return e.stopping
    if (failure !== undefined) this.countFailure(e, failure)
    e.state = 'stopping'
    if (e.idle !== undefined) this.o.timers.clearTimeout(e.idle)
    e.stopping = (async () => {
      try {
        // 关 stdin(服务应该自己走),并把在等答复的都拒掉
        e.client?.close()
      } catch {
        // 关的时候流已经没了
      }
      const pid = e.pid
      if (pid !== undefined) {
        try {
          if (!e.exited) {
            const { gone } = await killLadder(pid, { fast: true, alive: () => groupExists(pid, liveKill), owned: () => !e.exited, log: this.o.log })
            // 还登记着:kernel.close 的 killLive 和崩溃后的 reapOrphans 还会再收
            if (!gone) this.o.log.warn('mcp server still alive after the ladder', { pid })
          }
          else if (groupExists(pid, liveKill)) {
            // 组长崩了,组员还在:能认出来的才杀
            const anchors = groupMembers(pid).filter(m => m.pid !== pid)
            if (anchors.length > 0) await killLadder(pid, { fast: true, alive: () => groupExists(pid, liveKill), anchors, log: this.o.log })
          }
        } catch (err) {
          this.o.log.warn('mcp server not stopped', { error: err instanceof Error ? err.name : 'unknown' })
        }
        await Promise.race([e.exit, delay(AFTER_KILL_MS)])
      }
      this.finalize(e)
    })()
    return e.stopping
  }

  private finalize(e: Entry): void {
    if (this.entries.get(e.key) === e) this.entries.delete(e.key)
    e.plan?.release()
    if (e.pid !== undefined) this.o.pgids?.settle(e.pid)
    if (e.tmpRoot) {
      try {
        rmSync(e.tmpRoot, { recursive: true, force: true })
      } catch (err) {
        this.o.log.warn('mcp temp dir not removed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
      }
    }
    const failed = this.sticky.get(e.key)
    if (e.pid !== undefined) {
      if (failed !== undefined) this.emit(e.sessionId, e.plugin, e.server, 'server_failed', failed)
      else this.emit(e.sessionId, e.plugin, e.server, 'stopped')
    }
    e.onGone()
  }

  /** 起(需要时)并返回客户端。工具走 tools、callTool:它们还管忙闲和杀进程 */
  async client(sessionId: string, plugin: string, server: string): Promise<McpClient> {
    const e = await this.acquire(sessionId, plugin, server, true)
    e.busy--
    return e.client!
  }

  private async use<T>(sessionId: string, plugin: string, server: string, mayStart: boolean, signal: AbortSignal, fn: (c: McpClient) => Promise<T>): Promise<T> {
    const e = await this.acquire(sessionId, plugin, server, mayStart, signal)
    try {
      return await fn(e.client!)
    } catch (err) {
      if (!(err instanceof McpError)) throw err
      if (err.code === 'call_timeout' && e.client!.consecutiveTimeouts >= CONSECUTIVE_TIMEOUTS) void this.stop(e, 'call_timeout')
      else if (err.code === 'protocol_error' || err.code === 'too_many_tools') void this.stop(e, err.code)
      throw refuse(err.code)
    } finally {
      e.busy--
      e.lastUsed = this.o.now()
    }
  }

  /** 工具清单,以及这个会话里说明变过的工具名(只是看得见,不是钉住,M25) */
  async tools(sessionId: string, plugin: string, server: string, signal: AbortSignal, mayStart = true): Promise<{ tools: McpTool[]; changed: Set<string> }> {
    const tools = await this.use(sessionId, plugin, server, mayStart, signal, c => c.listTools(signal))
    const seenKey = this.keyOf(sessionId, plugin, server)
    let first = this.seen.get(seenKey)
    if (!first) {
      if (this.seen.size >= SEEN_MAX) this.seen.delete(this.seen.keys().next().value!)
      this.seen.set(seenKey, (first = new Map()))
    }
    const changed = new Set<string>()
    let announce = false
    for (const t of tools) {
      const h = sha(`${t.description}\0${JSON.stringify(t.inputSchema)}`)
      const was = first.get(t.name)
      if (was === undefined) first.set(t.name, h)
      else if (was !== h) {
        changed.add(t.name)
        const mark = `${seenKey}\0${t.name}\0${h}`
        if (!this.reported.has(mark)) {
          if (this.reported.size >= SEEN_MAX) this.reported.clear()
          this.reported.add(mark)
          announce = true
        }
      }
    }
    if (announce) this.emit(sessionId, plugin, server, 'running', 'tools_changed', true)
    return { tools, changed }
  }

  callTool(sessionId: string, plugin: string, server: string, tool: string, args: unknown, signal: AbortSignal, mayStart = true): Promise<{ text: string; isError: boolean }> {
    return this.use(sessionId, plugin, server, mayStart, signal, c => c.callTool(tool, args, signal))
  }

  /** 关 stdin、走短梯,并行。记录已经先改了:杀进程期间起不来新的。失败的记账到此为止(到插件重启或授权变化) */
  async killPlugin(id: string): Promise<void> {
    const targets = [...this.entries.values()].filter(e => e.plugin === id)
    for (const e of targets) e.aborted = true
    await Promise.all(
      targets.map(e =>
        // 还没有进程的:launch 下一步就看到 aborted。它卡在起代理上时不让 RPC 跟着卡
        e.pid === undefined && e.state === 'starting' ? Promise.race([e.gone, delay(STALL_MS)]) : this.stop(e),
      ),
    )
    const prefix = `\0${id}/`
    for (const map of [this.failures, this.sticky, this.notes]) for (const key of [...map.keys()]) if (key.includes(prefix)) map.delete(key)
  }

  /** 内核关闭的兜底:killLive 已经收过一遍,这里同步收漏网的。之后不再起,也不再写事件 */
  killAllNow(): void {
    this.closed = true
    for (const e of this.entries.values()) {
      e.aborted = true
      if (e.idle !== undefined) this.o.timers.clearTimeout(e.idle)
      try {
        e.client?.close()
      } catch {
        // 流已经没了
      }
      if (e.pid !== undefined && !e.exited) {
        try {
          // 还没回收的子进程,pid 不可能被复用
          process.kill(-e.pid, 'SIGKILL')
        } catch {
          // 组已经没了
        }
      }
      e.plan?.release()
    }
  }
}

const liveKill = (pid: number, sig: NodeJS.Signals | 0) => process.kill(pid, sig)

const delay = (ms: number) =>
  new Promise<void>(res => {
    setTimeout(res, ms).unref()
  })

/** 等的人被取消了不再等;事情本身继续 */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(refuse('cancelled'))
  return new Promise<T>((res, rej) => {
    const onAbort = () => rej(refuse('cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      v => {
        signal.removeEventListener('abort', onAbort)
        res(v)
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        rej(err)
      },
    )
  })
}
