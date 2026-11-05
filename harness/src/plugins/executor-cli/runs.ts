// 运行管理(04 spec §9、§10、§12):排队、上限、生命周期、节流事件、原始日志、改动与通知。
// 一条规矩:运行离开 active 只有 leave() 一个出口,而 leave() 一定留下通知并叫醒 wait,否则这一轮就永远挂着
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { PermissionGate } from '../../kernel/permissionGate'
import type { Logger } from '../../kernel/log'
import { RpcError } from '../../kernel/rpcError'
import { isInside, resolveToolPath } from '../../lib/fs/paths'
import { validateNetworkEntry } from '../../lib/sandbox/net/domains'
import { changes as gitChanges, NO_REPO, pruneRefs, refExists, repoPrefix, takeSnapshot, type Git, type RepoPin } from '../../lib/git/snapshot'
import { imWorktreeRootOf, isImCwd } from '../../lib/git/imWorktree'
import { addWorktree, removeInWorktree, removeWorktree, reserveWorktree, rootConflict, userGitState, worktreePin } from '../../lib/git/worktree'
import type { PgidRegistry } from '../../lib/proc/pgids'
import { runCli as realRunCli, type CliPlan, type CliResult } from '../../lib/proc/runCli'
import { redact } from '../../lib/tools/redact'
import { shellEnv } from '../../lib/tools/shellEnv'
import type { BackgroundRuns, ExecPolicy, RunNotice, SandboxService } from '../../lib/tools/types'
import type { KernelEvent } from '../../protocol/index'
import { ERR_BUSY } from '../../protocol/rpc'
import type { ExecutorChangesSource, ExecutorIsolation, ExecutorRunReason, ExecutorRunStatus, FileChange } from '../../protocol/tools'
import { foldEvent, type Adapter, type Outcome, type RunEvent, type RunState } from './adapters/types'
import { binaryChanged, binaryDirs, isolationOf, trustedPath, type ExecutorInfo } from './detect'
import { cleanText, clip, noticeText } from './diagnostics'
import { checkViolations, denyReadCopies, mustAsk, protectDirs, translate, treePolicy, type TranslatedPolicy } from './policy'

export type Reason = ExecutorRunReason

export interface ExecutorsConfig {
  maxPerExecutor: number
  maxGlobal: number
  maxPerTurn: number
  maxQueue: number
  timeoutMinutes: number
  idleMinutes: number
  disabled: string[]
  codex: { network: boolean }
  /** 不给 = 适配器默认 */
  qoder: { hosts?: string[] }
}

export const DEFAULT_EXECUTORS_CONFIG: ExecutorsConfig = {
  maxPerExecutor: 2, maxGlobal: 3, maxPerTurn: 6, maxQueue: 16, timeoutMinutes: 30, idleMinutes: 20,
  disabled: [], codex: { network: false }, qoder: {},
}

const isCount = (v: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= max

/**
 * 配置段(§9.1)。写坏的值退回默认并告警,绝不让整个插件起不来;布尔值只认 true,网络不会被 'yes' 打开。
 * qoder.hosts 逐条过 05 的网络条目解析,无效的丢掉
 */
export function parseExecutorsConfig(raw: unknown, warn: (message: string) => void): ExecutorsConfig {
  const d = DEFAULT_EXECUTORS_CONFIG
  if (raw === undefined) return { ...d, disabled: [], codex: { ...d.codex }, qoder: {} }
  const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (!isObject(raw)) warn('executors config is not an object')
  const o = isObject(raw) ? raw : {}
  const count = (k: 'maxPerExecutor' | 'maxGlobal' | 'maxPerTurn' | 'maxQueue' | 'timeoutMinutes' | 'idleMinutes', max?: number): number => {
    if (o[k] === undefined) return d[k]
    if (isCount(o[k], max)) return o[k] as number
    warn(`executors.${k} is invalid, using ${d[k]}`)
    return d[k]
  }
  let disabled: string[] = []
  if (Array.isArray(o.disabled) && o.disabled.every(x => typeof x === 'string')) disabled = o.disabled as string[]
  else if (o.disabled !== undefined) warn('executors.disabled is invalid, using []')
  let network = false
  if (o.codex !== undefined) {
    if (isObject(o.codex) && (o.codex.network === undefined || typeof o.codex.network === 'boolean')) network = o.codex.network === true
    else warn('executors.codex.network is invalid, using false')
  }
  const qoder: ExecutorsConfig['qoder'] = {}
  if (o.qoder !== undefined) {
    if (!isObject(o.qoder) || (o.qoder.hosts !== undefined && !Array.isArray(o.qoder.hosts))) warn('executors.qoder.hosts is invalid, using the defaults')
    else if (Array.isArray(o.qoder.hosts)) {
      const hosts = o.qoder.hosts as unknown[]
      qoder.hosts = hosts.filter((h): h is string => typeof h === 'string' && validateNetworkEntry(h))
      for (let n = hosts.length - qoder.hosts.length; n > 0; n--) warn('executors.qoder.hosts has an invalid entry, dropped')
    }
  }
  return {
    maxPerExecutor: count('maxPerExecutor'), maxGlobal: count('maxGlobal'), maxPerTurn: count('maxPerTurn'), maxQueue: count('maxQueue'),
    timeoutMinutes: count('timeoutMinutes', 120), idleMinutes: count('idleMinutes'), disabled, codex: { network }, qoder,
  }
}

export interface SubmitInput {
  adapter: string
  prompt: string
  model?: string
  readOnly: boolean
  timeoutMs: number
  sessionId: string
  turnId: string
  callId: string
  cwd: string
  spillDir: string
  origin: string
  /** 批准时看到的隔离 */
  isolation: ExecutorIsolation
  /** 这次运行是人放行的 */
  asked: boolean
  /** 批准时的程序文件(binaryKey):无隔离的放行只对这个文件算数 */
  approvedBinary?: string
}

export interface RunManagerDeps {
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): KernelEvent
  sessions: { get(id: string): { cwd?: string; repo?: RepoPin } | undefined }
  sandbox: SandboxService
  gate: Pick<PermissionGate, 'check' | 'checkMany'>
  git: Git
  log: Logger
  /** 启动时的环境快照;过 shellEnv 白名单后才给 CLI */
  env: NodeJS.ProcessEnv
  loginPath(): Promise<string>
  registry?: Pick<PgidRegistry, 'add' | 'settle'>
  adapters: Map<string, Adapter>
  info(id: string): ExecutorInfo
  config(): ExecutorsConfig
  /** ctx.events.history:changes 只靠它和引用名,重启后也能用 */
  history(sessionId: string): KernelEvent[]
  /** app 以外的会话,写运行放在 <root>/<sid>/<runId>。不给 = 这样的运行一律 worktree_unavailable,绝不退回在地 */
  worktreeRoot?: string
  /** 内核数据目录,算 IM 的根用。不给 = 没有 IM 在地运行,快照的可写根也不含它 */
  dataDir?: string
  /**
   * 程序变了、不见了或不可信:重新探测,要等它。Task 10 接到 detectExecutor,先更新 info(id) 再 resolve。
   * 不给 = 不能重新探测,这样的运行一律失败
   */
  redetect?(id: string): Promise<ExecutorInfo>
  /** 等重新探测的上限;探测最坏约 50 s。超过了这次运行失败,探测接着跑 */
  redetectWaitMs?: number
  /** 快照的临时目录 */
  tmpDir?: string
  home?: string
  platform?: NodeJS.Platform
  now?: () => number
  newId?: () => string
  /** 只给测试 */
  runCli?: typeof realRunCli
  /** 只给测试:进度节流的窗口 */
  progressIntervalMs?: number
}

const KEEP_RUNS = 50
const REDETECT_WAIT_MS = 60_000
const REPORTED_PATH_MAX = 4096
const SUMMARY_MAX = 300
const PROGRESS_MAX = 500
const PROGRESS_CAP = 2000
/** ≤ 2/s 按事件时间戳算;留一点余量给定时器和写入之间的抖动 */
const PROGRESS_INTERVAL_MS = 510
const RAW_LOG_MAX = 20 * 1024 * 1024
const RAW_FLUSH = 64 * 1024
const STDERR_TAIL = 2000
const FILES_MAX = 5000
/** errors 只用来判定:一个刷屏的 CLI 不能把它撑大 */
const ERRORS_MAX = 50
const ERROR_TEXT_MAX = 4000
const NATIVE_ID_MAX = 200
const AUTH_FILE_MAX = 64 * 1024
const AUTH_FILES_MAX = 64
const AUTH_DEPTH_MAX = 4
const SECRET_MIN = 16

/** 与 classifyOutcome 的认证判定同一组词 */
const AUTH_HINT = /\b401\b|unauthorized|not logged in/i

const PEM_BEGIN = /BEGIN [A-Z0-9 ]*PRIVATE KEY/g
const PEM_END = /END [A-Z0-9 ]*PRIVATE KEY/g

const lastMatch = (re: RegExp, s: string): number => {
  let at = -1
  for (const m of s.matchAll(re)) at = m.index
  return at
}

/**
 * 一次运行的打码(C10、C11):redact + `~/.qoder/.auth` 里的字面值 + 跨行的 PEM。
 * PEM 状态按流分开:stdout 和 stderr 交错时,一边的 BEGIN 不该影响另一边。
 * 判定用清过控制字符的文本;没有东西要盖时原样返回
 */
/** IM 会话的 cwd 已经是它自己的 worktree:再嵌一层改动就拿不回来,turn.rollback 也覆盖不到(07 spec §8.2)。不知道数据目录就算不是 */
const imInPlace = (origin: string, cwd: string, dataDir: string | undefined) => origin === 'im' && dataDir !== undefined && isImCwd(dataDir, cwd)

/** app 和 acp 都是有人在本机开的会话,再加上面那种:写运行在地跑,排队优先。别的来源进 worktree */
export const runsInPlace = (origin: string, cwd: string, dataDir: string | undefined) => origin === 'app' || origin === 'acp' || imInPlace(origin, cwd, dataDir)

export class RunRedactor {
  private literals: string[]
  private open = new Set<string>()

  constructor(secrets: string[] = []) {
    const forms = secrets.flatMap(v => [v, JSON.stringify(v).slice(1, -1)])
    this.literals = [...new Set(forms)].sort((a, b) => b.length - a.length)
  }

  private apply(s: string): string {
    let out = redact(s)
    for (const v of this.literals) if (out.includes(v)) out = out.split(v).join('***')
    return out
  }

  mask = (s: string): string => {
    const clean = cleanText(s)
    const masked = this.apply(clean)
    return masked !== clean ? masked : s
  }

  /** 一行:从 BEGIN 那行到 END 那行,整行变 *** */
  line(stream: string, s: string): string {
    const clean = cleanText(s)
    const begin = lastMatch(PEM_BEGIN, clean)
    const end = lastMatch(PEM_END, clean)
    if (this.open.has(stream)) {
      if (end >= 0 && begin < end) this.open.delete(stream)
      return '***'
    }
    if (begin >= 0 && begin > end) {
      this.open.add(stream)
      return '***'
    }
    return this.mask(s)
  }

  text(stream: string, s: string): string {
    return s.split('\n').map(l => this.line(stream, l)).join('\n')
  }
}

/** 沙箱外读登录文件(C11):JSON 的字符串值、其他文件的行,长度 ≥ 16。读不了就算了 */
export function authSecrets(roots: string[]): string[] {
  const found = new Set<string>()
  const add = (s: string) => {
    for (const line of s.split('\n')) {
      const t = line.trim()
      if (t.length >= SECRET_MIN) found.add(t)
    }
  }
  const leaves = (v: unknown): void => {
    if (typeof v === 'string') add(v)
    else if (Array.isArray(v)) v.forEach(leaves)
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(leaves)
  }
  let files = 0
  const readFile = (p: string) => {
    if (++files > AUTH_FILES_MAX) return
    if (statSync(p).size > AUTH_FILE_MAX) return
    const text = readFileSync(p, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return add(text)
    }
    leaves(parsed)
  }
  const walk = (p: string, depth: number) => {
    try {
      const s = statSync(p)
      if (s.isFile()) return readFile(p)
      if (!s.isDirectory() || depth > AUTH_DEPTH_MAX) return
      for (const e of readdirSync(p, { withFileTypes: true })) {
        if (!e.isSymbolicLink()) walk(join(p, e.name), depth + 1)
      }
    } catch {
      // 读不了的文件不进打码表
    }
  }
  for (const r of roots) walk(r, 0)
  return [...found]
}

type ProgressKind = 'tool' | 'file' | 'text' | 'think'

/** 每个运行 ≤ 2 条/秒(窗口里只留最后一条,窗口结束发出),最多 2000 条,之后只计数 */
export class ProgressThrottle {
  dropped = 0
  private sent = 0
  private last = -Infinity
  private pending?: { kind: ProgressKind; text: string }
  private timer?: NodeJS.Timeout
  private closed = false
  private onFlush?: () => void
  private intervalMs: number
  private cap: number

  constructor(
    private emit: (kind: ProgressKind, text: string) => void,
    private now: () => number,
    o: { intervalMs?: number; cap?: number } = {},
  ) {
    this.intervalMs = o.intervalMs ?? PROGRESS_INTERVAL_MS
    this.cap = o.cap ?? PROGRESS_CAP
  }

  push(kind: ProgressKind, text: string): void {
    if (this.closed || this.sent >= this.cap) {
      this.dropped++
      return
    }
    if (this.pending) {
      this.dropped++
      this.pending = { kind, text }
      return
    }
    const wait = this.last + this.intervalMs - this.now()
    if (wait <= 0) return this.send(kind, text)
    this.pending = { kind, text }
    // 时钟往回跳时 wait 会很大:等不能超过一个窗口,否则运行收不了尾
    this.timer = setTimeout(() => this.flush(), Math.min(wait, this.intervalMs))
  }

  private send(kind: ProgressKind, text: string): void {
    this.last = this.now()
    this.sent++
    try {
      this.emit(kind, text)
    } catch {
      // 日志关了:进度丢了没关系,结束事件那边有自己的兜底
    }
  }

  private flush(): void {
    const p = this.pending
    this.pending = undefined
    if (p) this.send(p.kind, p.text)
    this.onFlush?.()
  }

  /** wait:等最后一条按节奏发出(≤ 窗口长度);内核关闭时不等,算丢弃 */
  close(wait: boolean): Promise<void> {
    this.closed = true
    if (!this.pending) return Promise.resolve()
    if (wait) return new Promise(res => { this.onFlush = res })
    clearTimeout(this.timer)
    this.pending = undefined
    this.dropped++
    return Promise.resolve()
  }
}

/** spillDir/<runId>.jsonl:写不了只告警,不影响运行 */
class RawLog {
  path?: string
  private fd?: number
  private chunks: string[] = []
  private buffered = 0
  private written = 0
  private full = false

  constructor(dir: string, runId: string, private log: Logger) {
    const path = join(dir, `${runId}.jsonl`)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      this.fd = openSync(path, 'wx', 0o600)
      this.path = path
    } catch (e) {
      this.warn(e)
    }
  }

  private warn(e: unknown): void {
    this.log.warn('run raw log not written', { code: (e as NodeJS.ErrnoException)?.code })
  }

  line(s: string): void {
    if (this.fd === undefined || this.full) return
    const bytes = Buffer.byteLength(s) + 1
    if (this.written + this.buffered + bytes > RAW_LOG_MAX) {
      this.full = true
      this.chunks.push(`{"truncated":true,"maxBytes":${RAW_LOG_MAX}}\n`)
      return this.flush()
    }
    this.chunks.push(s, '\n')
    this.buffered += bytes
    if (this.buffered >= RAW_FLUSH) this.flush()
  }

  private flush(): void {
    if (this.fd === undefined || this.chunks.length === 0) return
    const data = this.chunks.join('')
    this.chunks = []
    this.written += this.buffered
    this.buffered = 0
    try {
      writeSync(this.fd, data)
    } catch (e) {
      this.warn(e)
      this.stop()
    }
  }

  private stop(): void {
    if (this.fd === undefined) return
    try {
      closeSync(this.fd)
    } catch (e) {
      this.warn(e)
    }
    this.fd = undefined
  }

  close(): void {
    this.flush()
    this.stop()
  }
}

/** shellEnv 的白名单之外只加这几个不含密钥的。launchd 起的后台没有它们;实测最小环境下 qodercli 启动就崩(Task 5) */
const fallbackEnv = (): NodeJS.ProcessEnv => {
  let user: string | undefined
  try {
    user = userInfo().username
  } catch {
    // 查不到就不设
  }
  return { TERM: 'xterm-256color', LANG: 'en_US.UTF-8', ...(user && { USER: user, LOGNAME: user }) }
}

interface Run {
  runId: string
  adapter: Adapter
  s: SubmitInput
  seq: number
  phase: 'queued' | 'running'
  abort: AbortController
  /** 内核关闭:走短梯,不拍结束快照,状态写 interrupted */
  stopping: boolean
  isolation: ExecutorIsolation
  redactor: RunRedactor
  throttle?: ProgressThrottle
  raw?: RawLog
  done?: Promise<void>
  startedAt?: number
  /** CLI 跑的地方;s.cwd 始终是会话的目录 */
  cwd: string
  /** 提交时算好的排队优先级:排序里不做文件系统调用 */
  inPlace: boolean
  /** 进了 worktree。有它不代表 CLI 跑过:没跑的在 finish 里删掉,字段也清掉 */
  worktree?: { path: string; sessionTop: string; userState: string[]; denyRead: string[] }
  writer: boolean
  concurrent: boolean
  startRef?: string
  spawned: boolean
  tmpDir?: string
  untranslated?: number
  state: RunState
  final?: string
  lastError?: string
  usage?: { input: number; output: number; cached?: number }
  files: Set<string>
  nativeId?: string
  stderrTail: string
  networkLost?: boolean
  droppedLines: number
}

interface Attempt {
  outcome: Outcome
  cli?: CliResult
  /** 没有 CLI 输出时放进 final 的话:只有我们自己的固定文字 */
  message?: string
  /** 程序变了造成的失败,不是模型派多了:不占 maxPerTurn */
  uncounted?: boolean
}

interface Assessment {
  info: ExecutorInfo
  policy: ExecPolicy
  t: TranslatedPolicy
  isolation: ExecutorIsolation
  missing: string[]
}

interface TurnState {
  submitted: number
  active: number
  notices: RunNotice[]
  waiters: Set<() => void>
  /** abandon 过:take 之后就可以忘掉这一轮 */
  closed: boolean
}

const failed = (reason: Reason, message: string): Attempt => ({ outcome: { status: 'failed', reason }, message })

const REFUSALS: Partial<Record<Reason, string>> = {
  denied: 'Not started: permissions changed while this run was queued.',
  not_installed: 'Not started: the CLI is not installed.',
  untrusted_binary: 'Not started: the CLI program is not trusted, or changed since it was checked.',
  sandbox_unavailable: 'Not started: the isolation this run was approved with is no longer available.',
  worktree_unavailable: 'Not started: this session must run writes in a worktree, and none could be created.',
  worktree_limit: 'Not started: too many worktrees are kept. Discard some first; they are never removed automatically.',
}

const BINARY_CHANGED = 'Not started: the CLI program changed since it was checked and is being re-checked; try again shortly.'
const BINARY_GONE = 'Not started: the CLI program is gone. It is being looked for again; install it, or try again.'
const BINARY_UNTRUSTED = 'Not started: the CLI program failed the trust check. Fix its owner and permissions, then try again.'
const NONE_OTHER_FILE = 'Not started: the CLI program changed after this unconfined run was approved. Call the tool again to ask for approval.'
const RECHECK_WIDER = 'Not started: the CLI program changed, and its re-check came out less isolated than this run was approved for. Call the tool again to ask for approval.'

const inRoots = (file: string, roots: string[], platform = process.platform) => roots.some(r => isInside(file, r, platform))

const runRef = (sessionId: string, runId: string, phase: 'start' | 'end') => `refs/mffai/runs/${sessionId}/${runId}-${phase}`

export class RunManager implements BackgroundRuns {
  private live = new Map<string, Run>()
  private queue: Run[] = []
  private running = new Set<Run>()
  private turns = new Map<string, TurnState>()
  private seq = 0
  /** 同一个执行器只探测一次 */
  private redetects = new Map<string, Promise<ExecutorInfo>>()
  /** 后台在删的运行临时目录:关闭时等一下 */
  private removals = new Set<Promise<void>>()
  /** abandonAll 或内核关闭之后不再起新的 */
  private stopped = false
  /** 日志出错不能挡住收尾 */
  private log: Logger

  constructor(private deps: RunManagerDeps) {
    const quiet = (fn: Logger['warn']): Logger['warn'] => (msg, data) => {
      try {
        fn.call(deps.log, msg, data)
      } catch {
        // 连日志都写不了:什么也做不了,但运行还得结束
      }
    }
    this.log = { info: quiet(deps.log.info), warn: quiet(deps.log.warn), error: quiet(deps.log.error) }
  }

  private now = () => (this.deps.now ?? Date.now)()
  private get platform() {
    return this.deps.platform ?? process.platform
  }
  private get home() {
    return this.deps.env.HOME ?? this.deps.home ?? homedir()
  }

  private turn(turnId: string): TurnState {
    let t = this.turns.get(turnId)
    if (!t) this.turns.set(turnId, (t = { submitted: 0, active: 0, notices: [], waiters: new Set(), closed: false }))
    return t
  }

  /** 写事件出错(内核已关库)不能挡住运行的收尾 */
  private write(type: string, sessionId: string, payload: unknown): void {
    try {
      this.deps.append({ type, sessionId, payload } as Omit<KernelEvent, 'seq' | 'ts'>)
    } catch (e) {
      this.log.warn('run event not recorded', { type, error: e instanceof Error ? redact(e.message) : 'unknown' })
    }
  }

  submit(s: SubmitInput): { runId: string; position: number; queued: boolean } | { failure: Reason } {
    const adapter = this.deps.adapters.get(s.adapter)
    if (!adapter) return { failure: 'not_installed' }
    if (this.stopped) return { failure: 'kernel_stopping' }
    const cfg = this.deps.config()
    const t = this.turn(s.turnId)
    if (t.closed) return { failure: 'cancelled' }
    if (t.submitted >= cfg.maxPerTurn) return { failure: 'too_many_runs' }
    if (this.queue.length >= cfg.maxQueue) return { failure: 'queue_full' }

    const runId = this.deps.newId?.() ?? `run_${randomBytes(8).toString('hex')}`
    const run: Run = {
      runId, adapter, s, inPlace: runsInPlace(s.origin, s.cwd, this.deps.dataDir), seq: this.seq++, phase: 'queued', abort: new AbortController(), stopping: false,
      isolation: s.isolation, redactor: new RunRedactor(), cwd: s.cwd, writer: false, concurrent: false, spawned: false,
      state: { code: null, signal: null, completed: false, sawResult: false, errors: [], timedOut: false, stalled: false, cancelled: false },
      files: new Set(), stderrTail: '', droppedLines: 0,
    }
    t.submitted++
    t.active++
    this.live.set(runId, run)
    this.queue.push(run)
    this.queue.sort((a, b) => Number(b.inPlace) - Number(a.inPlace) || a.seq - b.seq)
    const position = this.queue.indexOf(run)
    this.write('executor.run.queued', s.sessionId, {
      runId, turnId: s.turnId, callId: s.callId, executor: adapter.id,
      summary: `${adapter.id}: ${clip(redact(s.prompt), SUMMARY_MAX)}`,
      readOnly: s.readOnly, isolation: s.isolation, position,
    })
    this.dispatch()
    // 名额满时队列可能是空的、position 是 0:起没起来只看 dispatch 之后的状态
    return { runId, position: this.queue.indexOf(run), queued: run.phase === 'queued' }
  }

  /** 按队列顺序起能起的:一个执行器满了不挡别的执行器 */
  private dispatch(): void {
    if (this.stopped) return
    const cfg = this.deps.config()
    for (const run of [...this.queue]) {
      if (this.running.size >= cfg.maxGlobal) return
      const sameExecutor = [...this.running].filter(r => r.adapter.id === run.adapter.id).length
      if (sameExecutor >= cfg.maxPerExecutor) continue
      this.queue.splice(this.queue.indexOf(run), 1)
      this.running.add(run)
      run.phase = 'running'
      run.startedAt = this.now()
      // 名额只在 finally 里还,不看任何状态
      run.done = this.execute(run)
        .catch(e => this.log.error('run end failed', { error: e instanceof Error ? redact(e.message) : 'unknown' }))
        .finally(() => {
          this.running.delete(run)
          this.dispatchQuietly()
        })
    }
  }

  /** 名额空出来时用:配置读不了只记日志,不能把 run.done 变成 rejected */
  private dispatchQuietly(): void {
    try {
      this.dispatch()
    } catch (e) {
      this.log.error('run queue stalled', { error: e instanceof Error ? redact(e.message) : 'unknown' })
    }
  }

  cancel(sessionId: string, runId: string): boolean {
    const run = this.live.get(runId)
    if (!run || run.s.sessionId !== sessionId) return false
    if (run.phase === 'queued') this.endQueued(run)
    else run.abort.abort()
    return true
  }

  /** 排着队被摘掉:没有 started,不占名额 */
  private endQueued(run: Run): void {
    this.queue.splice(this.queue.indexOf(run), 1)
    this.conclude(run, this.stoppedAttempt(run), { files: [], source: 'none' }, [])
  }

  private stoppedAttempt(run: Run): Attempt {
    return { outcome: run.stopping ? { status: 'interrupted', reason: 'kernel_stopping' } : { status: 'cancelled', reason: 'cancelled' } }
  }

  /**
   * 跑一次。任何一步抛错 = 这次运行失败(spawn_failed);finish 自己每步都兜着,所以一定走到 leave
   */
  private async execute(run: Run): Promise<void> {
    let attempt: Attempt
    try {
      attempt = await this.attempt(run)
    } catch (e) {
      this.log.warn('run failed to start', { runId: run.runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
      attempt = failed('spawn_failed', 'Not started: could not prepare the CLI command.')
    }
    try {
      await this.finish(run, attempt)
    } catch (e) {
      // finish 每步都兜着,这里是最后一道:没有通知,这一轮就永远挂着
      this.log.error('run end steps failed', { runId: run.runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
      if (this.live.has(run.runId)) this.conclude(run, attempt, { files: [], source: 'none' }, [])
    }
  }

  /** 出队时再过一次门(C13)。redetected:这次的 info 是刚探测出来的 */
  private refusal(run: Run, view: Assessment, redetected: boolean): Attempt | undefined {
    const { s, adapter } = run
    const { info, isolation, missing, policy } = view
    const base = { actor: 'tools', sessionId: s.sessionId }
    const summary = `${adapter.id}: ${clip(redact(s.prompt), SUMMARY_MAX)}`
    const [exec, read, write] = this.deps.gate.checkMany([
      { ...base, action: 'exec', resource: adapter.id, summary, unsandboxed: isolation === 'none', mustAsk: mustAsk(policy, isolation) },
      { ...base, action: 'read', resource: s.cwd },
      { ...base, action: 'write', resource: s.cwd },
    ])
    if (exec === 'deny' || read === 'deny' || (!s.readOnly && write === 'deny')) return failed('denied', REFUSALS.denied!)
    const binary = (reason: Reason, message: string): Attempt => ({ ...failed(reason, message), uncounted: true })
    if (missing.includes('untrusted_binary')) return binary('untrusted_binary', redetected ? BINARY_UNTRUSTED : REFUSALS.untrusted_binary!)
    if (!info.installed || info.path === undefined) return binary('not_installed', redetected ? BINARY_GONE : REFUSALS.not_installed!)
    if (binaryChanged(info)) return binary('untrusted_binary', BINARY_CHANGED)
    // 比批准时宽:人批准的是有隔离的那次运行,asked 也不算(05 review I1)。重试会重新过门
    if (s.isolation !== 'none' && isolation === 'none') return redetected ? binary('sandbox_unavailable', RECHECK_WIDER) : failed('sandbox_unavailable', REFUSALS.sandbox_unavailable!)
    if (exec === 'ask' && !s.asked) return failed('denied', REFUSALS.denied!)
    // 人放行的是不隔离地跑那个文件;换了文件仍然不隔离,就得重新问人。隔离变窄(新文件过了自检)不用
    if (s.asked && s.isolation === 'none' && isolation === 'none' && (redetected || (s.approvedBinary !== undefined && info.binaryKey !== s.approvedBinary))) return binary('untrusted_binary', NONE_OTHER_FILE)
    return undefined
  }

  /**
   * 工具的 permission() 用:与出队时同一套算法、同样的路径(同步)。否则批准时算成 own,出队才发现变宽,
   * 报的是 sandbox_unavailable 而不是问人
   */
  preview(adapterId: string, info: ExecutorInfo, s: { sessionId: string; cwd: string; spillDir: string; origin: string }, loginPath: string): Assessment {
    const { deps, platform, home } = this
    const adapter = deps.adapters.get(adapterId)!
    const pathDirs = (shellEnv(deps.env, { platform, home, loginPath }).PATH ?? '').split(':').filter(Boolean)
    return this.assessTree({ adapter, sessionId: s.sessionId, origin: s.origin, sessionCwd: s.cwd, cwd: s.cwd, spillDir: s.spillDir }, info, pathDirs, adapter.allowWrite(home, deps.env))
  }

  /** 这次运行在这份 info 下的策略和隔离 */
  private assess(run: Run, info: ExecutorInfo, pathDirs: string[], allowWrite: string[]): Assessment {
    const { s, adapter, cwd, worktree } = run
    return this.assessTree({ adapter, sessionId: s.sessionId, origin: s.origin, sessionCwd: s.cwd, cwd, spillDir: s.spillDir, worktree }, info, pathDirs, allowWrite)
  }

  private assessTree(
    r: { adapter: Adapter; sessionId: string; origin: string; sessionCwd: string; cwd: string; spillDir: string; worktree?: Run['worktree'] },
    info: ExecutorInfo,
    pathDirs: string[],
    allowWrite: string[],
  ): Assessment {
    const { deps, platform } = this
    const { adapter, worktree: wt } = r
    const policy = treePolicy(cwd => deps.sandbox.execPolicy(r.sessionId, cwd, adapter.id), r.sessionCwd, r.cwd, wt && { session: wt.sessionTop, run: wt.path })
    const protect = protectDirs({
      kind: adapter.isolationKind, pathDirs, binary: binaryDirs(info), cwd: r.cwd, keepWritable: [r.cwd, r.spillDir, ...allowWrite], platform,
    })
    // worktree 的 .git 文件决定沙箱外的 git 认哪个仓库。共用的 git 目录在沙箱里是可写根,要盖成只读:
    // Codex 的 :root 本来只读,写上去只会多一条可能让权限档不可信的路径
    const guard = wt ? [join(wt.path, '.git'), ...(adapter.isolationKind === 'wrap' ? wt.userState : [])] : []
    // 在地的 IM 运行:worktree 就是会话钉住的那棵树,同样的 .git 文件。共用的 git 目录由沙箱按会话来源盖(wrap),Codex 的 :root 本来只读
    const pin = this.pinOf(r.sessionId)
    if (!wt && pin.kind === 'repo' && imInPlace(r.origin, r.cwd, deps.dataDir)) guard.push(join(pin.top, '.git'))
    const t = translate(policy, [...protect, ...guard])
    const level = deps.sandbox.status(r.sessionId).level
    const { isolation, missing } = isolationOf(adapter, info, level, deps.config(), { cwd: r.cwd, denyRead: t.denyRead, readOnlyPaths: t.readOnlyPaths })
    return { info, policy, t, isolation, missing }
  }

  /** 同一个执行器只探测一次;等的人被取消或等过了上限就先走,探测接着跑 */
  private startRedetect(id: string): Promise<ExecutorInfo> | undefined {
    const { redetect } = this.deps
    if (!redetect) return undefined
    let p = this.redetects.get(id)
    if (!p) {
      p = Promise.resolve().then(() => redetect(id)).finally(() => this.redetects.delete(id))
      p.catch(e => this.log.warn('re-detection failed', { id, error: e instanceof Error ? redact(e.message) : 'unknown' }))
      this.redetects.set(id, p)
    }
    return p
  }

  private async awaitRedetect(run: Run): Promise<ExecutorInfo | undefined> {
    const pending = this.startRedetect(run.adapter.id)
    if (!pending) return undefined
    const { signal } = run.abort
    let timer: NodeJS.Timeout | undefined
    let onAbort = () => {}
    try {
      return await Promise.race([
        pending.catch(() => undefined),
        new Promise<undefined>(res => { timer = setTimeout(() => res(undefined), this.deps.redetectWaitMs ?? REDETECT_WAIT_MS) }),
        new Promise<undefined>(res => {
          onAbort = () => res(undefined)
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async attempt(run: Run): Promise<Attempt> {
    const { deps, platform, home } = this
    const { s, adapter } = run
    const login = await deps.loginPath().catch(() => '')
    if (run.abort.signal.aborted) return this.stoppedAttempt(run)

    // 环境:白名单 + 适配器点名;代理的 userinfo 由 shellEnv 去掉
    const env = shellEnv(deps.env, { platform, home, loginPath: login })
    for (const k of adapter.passEnv) if (deps.env[k] !== undefined) env[k] = deps.env[k]
    const pathDirs = (env.PATH ?? '').split(':').filter(Boolean)
    env.PATH = trustedPath(env.PATH, { cwd: s.cwd })
    for (const [k, v] of Object.entries(fallbackEnv())) env[k] ??= v

    const cfg = deps.config()
    const allowRead = adapter.allowRead(home, deps.env)
    const allowWrite = adapter.allowWrite(home, deps.env)
    let view = this.assess(run, deps.info(adapter.id), pathDirs, allowWrite)
    // 程序变了、不见了或不可信:先等重新探测,再按新结果重新判隔离和权限。只有探测确认过的文件才可能跑
    let redetected = false
    if (binaryChanged(view.info) || view.missing.includes('untrusted_binary')) {
      const fresh = await this.awaitRedetect(run)
      if (run.abort.signal.aborted) return this.stoppedAttempt(run)
      if (fresh) {
        redetected = true
        view = this.assess(run, fresh, pathDirs, allowWrite)
      }
    }
    const settle = (v: Assessment) => {
      run.isolation = v.isolation
      run.untranslated = v.t.untranslated
      return this.refusal(run, v, redetected)
    }
    // 先按会话那棵树判一次:不该跑的不白建 worktree,程序在会话 cwd 里(shell 写得到)也在这里挡下
    const refused = settle(view)
    if (refused) return refused
    if (!runsInPlace(s.origin, s.cwd, deps.dataDir) && !s.readOnly) {
      const failure = await this.enterWorktree(run)
      if (failure) return failure
      // 规则、隔离都要按真正跑的那棵树再算一遍;worktree 的路径也可能让隔离变宽
      view = this.assess(run, view.info, pathDirs, allowWrite)
      const again = settle(view)
      if (again) return again
      run.worktree!.denyRead = denyReadCopies(view.policy, run.worktree!.path)
    }
    const { info, policy, t, isolation } = view

    // 抛错(模型名不合规、路径是相对的)走 execute 的 catch:spawn_failed
    const built = adapter.buildArgs({
      prompt: s.prompt, cwd: run.cwd, model: s.model, readOnly: s.readOnly, isolation,
      denyRead: t.denyRead, keepRead: t.keepRead, readOnlyPaths: t.readOnlyPaths, network: cfg.codex?.network === true,
    })

    const wrap = adapter.isolationKind === 'wrap'
    if (wrap) run.redactor = new RunRedactor(authSecrets(allowRead))

    // 非递归:目录已存在说明不是我们的,不能用也不能删
    const runTmp = join(realpathSync(tmpdir()), `mffai-run-${run.runId}`)
    mkdirSync(runTmp, { mode: 0o700 })
    run.tmpDir = runTmp
    env.TMPDIR = runTmp

    // 沙箱不让运行新建这些条目(Task 7),缺的只能现在建
    if (wrap) {
      for (const dir of allowWrite) {
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 })
        } catch (e) {
          this.log.warn('qoder writable dir not created', { code: (e as NodeJS.ErrnoException)?.code })
        }
      }
    }

    if (!s.readOnly) {
      run.writer = true
      for (const other of this.running) {
        if (other !== run && other.writer && (isInside(other.cwd, run.cwd, this.platform) || isInside(run.cwd, other.cwd, this.platform))) {
          other.concurrent = true
          run.concurrent = true
        }
      }
      if (!run.startRef) await this.startSnapshot(run)
      if (run.abort.signal.aborted) return this.stoppedAttempt(run)
    }

    let plan: CliPlan = { file: info.path!, args: built.args, env }
    if (wrap) {
      try {
        const p = await deps.sandbox.planExec(info.path!, built.args, { sessionId: s.sessionId, cwd: run.cwd, spillDir: s.spillDir }, env, {
          allowRead, allowWrite, allowHosts: cfg.qoder?.hosts ?? adapter.hosts, proxyScope: run.runId, readOnly: s.readOnly,
          denyRead: policy.ruleDenyRead, denyWrite: t.denyWrite,
        })
        // argv 里已经有 --dangerously-skip-permissions:这是唯一一条能无隔离跑起来的路
        if (isolation === 'wrapped' && !p.sandboxed) {
          p.release()
          return failed('sandbox_unavailable', REFUSALS.sandbox_unavailable!)
        }
        run.networkLost = p.networkLost === true
        plan = p
      } catch (e) {
        this.log.warn('run sandbox plan failed', { runId: run.runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
        return failed('sandbox_unavailable', REFUSALS.sandbox_unavailable!)
      }
      if (run.abort.signal.aborted) {
        plan.release?.()
        return this.stoppedAttempt(run)
      }
    }

    // 快照可能拍了很久:起之前再看一眼,程序换过就不跑
    if (binaryChanged(info)) {
      plan.release?.()
      void this.startRedetect(adapter.id)
      return { ...failed('untrusted_binary', BINARY_CHANGED), uncounted: true }
    }

    run.raw = new RawLog(s.spillDir, run.runId, this.log)
    run.throttle = new ProgressThrottle(
      (kind, text) => deps.append({ type: 'executor.run.progress', sessionId: s.sessionId, payload: { runId: run.runId, turnId: s.turnId, kind, text } } as Omit<KernelEvent, 'seq' | 'ts'>),
      this.now,
      { intervalMs: deps.progressIntervalMs },
    )

    let cli: CliResult
    try {
      cli = await (deps.runCli ?? realRunCli)(plan, {
        cwd: run.cwd,
        stdin: built.stdin,
        timeoutMs: s.timeoutMs,
        idleMs: cfg.idleMinutes * 60_000,
        signal: run.abort.signal,
        fast: () => run.stopping,
        onSpawn: pid => {
          run.spawned = true
          try {
            deps.registry?.add(pid)
          } catch (e) {
            this.log.warn('run pgid not registered', { runId: run.runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
          }
          this.write('executor.run.started', s.sessionId, {
            runId: run.runId, turnId: s.turnId, executor: adapter.id, cwd: run.cwd, isolation,
            ...(run.worktree && { worktree: run.worktree.path }),
            ...(t.untranslated > 0 && { untranslatedRules: t.untranslated }),
          })
        },
        onClose: pid => deps.registry?.settle(pid),
        onLine: line => this.onLine(run, line),
        onDroppedLine: bytes => {
          run.droppedLines++
          run.raw?.line(`{"droppedLine":${bytes}}`)
        },
        onStderrLine: line => this.onStderr(run, line),
      })
    } catch (e) {
      plan.release?.()
      throw e
    }
    return { outcome: this.classify(run, cli), cli, ...(cli.spawnError && { message: cli.spawnError }) }
  }

  /**
   * 开始快照 → 占位 → 建 worktree,run.cwd 换过去。worktree 在沙箱外建(沙箱里不许在 .git/worktrees 下新建和改名)。
   * 拍不了、建不了 → 失败,绝不退回在地。
   * 上限和占位在同一拍里,并发的运行不会一起超
   */
  private async enterWorktree(run: Run): Promise<Attempt | undefined> {
    const { git, tmpDir, worktreeRoot } = this.deps
    const { s } = run
    const unavailable = failed('worktree_unavailable', REFUSALS.worktree_unavailable!)
    if (!worktreeRoot) return unavailable
    try {
      const repo = this.pinOf(s.sessionId)
      if (repo.kind !== 'repo') return unavailable
      if (rootConflict(worktreeRoot, repo, s.cwd)) {
        this.log.warn('worktree root overlaps the session repo', { runId: run.runId })
        return unavailable
      }
      await this.startSnapshot(run)
      if (run.abort.signal.aborted) return this.stoppedAttempt(run)
      if (!run.startRef) return unavailable
      const path = reserveWorktree(worktreeRoot, s.sessionId, run.runId)
      if (!path) return failed('worktree_limit', REFUSALS.worktree_limit!)
      // 从这里起 finish 负责收拾:没跑就删
      run.worktree = { path, sessionTop: repo.top, userState: userGitState(repo), denyRead: [] }
      await addWorktree(repo, path, run.startRef, git, { tmpDir, root: worktreeRoot })
      if (run.abort.signal.aborted) return this.stoppedAttempt(run)
      // 会话的子目录在快照里可能没有(空目录、全被忽略)
      const cwd = join(path, repoPrefix(repo, s.cwd))
      mkdirSync(cwd, { recursive: true })
      if (!isInside(realpathSync(cwd), path, this.platform)) return unavailable
      run.cwd = cwd
      return undefined
    } catch (e) {
      this.log.warn('worktree not created', { runId: run.runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
      return unavailable
    }
  }

  /** CLI 没跑过的 worktree 里没有谁要的东西,也不该占名额。删不掉只告警,字段留着,还能 discard */
  private async dropUnusedWorktree(run: Run): Promise<void> {
    const { git, tmpDir, worktreeRoot } = this.deps
    if (!run.worktree || run.spawned) return
    try {
      await removeWorktree(this.pinOf(run.s.sessionId), run.worktree.path, git, { tmpDir, root: worktreeRoot! })
      run.worktree = undefined
    } catch (e) {
      this.log.warn('unused worktree not removed', { runId: run.runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
    }
  }

  /** 跑过的 worktree 要留着,`deny read` 的副本不留:别的运行和会话的 shell 都读得到它。结束快照之前删,内核关闭时也删 */
  private removeDeniedCopies(run: Run): void {
    const wt = run.worktree
    if (!wt || !run.spawned) return
    try {
      const refused = removeInWorktree(wt.path, wt.denyRead)
      if (refused.length > 0) this.log.warn('worktree copy of a denied path not removed', { runId: run.runId, count: refused.length })
    } catch (e) {
      this.log.warn('worktree copy of a denied path not removed', { runId: run.runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
    }
  }

  /** 建会话时定下的仓库。沙箱外的 git 只认它 */
  private pinOf(sessionId: string): RepoPin {
    return this.deps.sessions.get(sessionId)?.repo ?? NO_REPO
  }

  /** 沙箱写得到的根(仓库之外):过滤器落在这些地方就不跑。重启后也能算,所以不看运行 */
  private gitOpts(pin: RepoPin): { pin: RepoPin; tmpDir?: string; writableRoots: string[] } {
    const { adapters, env, tmpDir, worktreeRoot, dataDir } = this.deps
    const writableRoots = [...adapters.values()].flatMap(a => a.allowWrite(this.home, env))
    if (worktreeRoot) writableRoots.push(worktreeRoot)
    if (dataDir !== undefined) writableRoots.push(imWorktreeRootOf(dataDir))
    try {
      writableRoots.push(realpathSync(tmpdir()))
    } catch {
      // 系统临时目录不在:运行的 TMPDIR 也建不了
    }
    return { pin, tmpDir, writableRoots: [...writableRoots, ...(tmpDir ? [tmpDir] : [])] }
  }

  private async startSnapshot(run: Run): Promise<void> {
    const { git, tmpDir } = this.deps
    const { log } = this
    const { sessionId } = run.s
    const pin = this.pinOf(sessionId)
    const roots = this.gitOpts(pin)
    const r = await takeSnapshot(run.cwd, runRef(sessionId, run.runId, 'start'), git, { ...roots, writableRoots: [...roots.writableRoots, run.s.cwd] })
    if (r.reason === 'error') log.warn('run start snapshot failed', { runId: run.runId })
    if (r.reason === 'unsafe_filter' || r.reason === 'unsafe_repo') log.warn('run snapshot skipped', { runId: run.runId, reason: r.reason })
    if (!r.ref) return
    run.startRef = r.ref
    await pruneRefs(`refs/mffai/runs/${sessionId}`, KEEP_RUNS, git, { pin, tmpDir }).catch(() => log.warn('run ref prune failed', { runId: run.runId }))
  }

  private onLine(run: Run, line: string): void {
    run.raw?.line(run.redactor.line('stdout', line))
    for (const e of run.adapter.parseLine(line)) this.onEvent(run, e)
  }

  private onStderr(run: Run, line: string): void {
    const masked = run.redactor.line('stderr', line)
    run.raw?.line(JSON.stringify({ stderr: masked }))
    const tail = `${run.stderrTail}${masked}\n`
    run.stderrTail = tail.length > STDERR_TAIL ? tail.slice(-STDERR_TAIL) : tail
  }

  private onEvent(run: Run, e: RunEvent): void {
    const { redactor } = run
    switch (e.kind) {
      case 'native':
        run.nativeId = clip(redactor.mask(e.id), NATIVE_ID_MAX)
        return
      case 'progress':
        run.throttle?.push(e.progress, clip(redactor.text('progress', e.text), PROGRESS_MAX))
        return
      case 'files':
        for (const f of e.files) if (run.files.size < FILES_MAX && f.length <= REPORTED_PATH_MAX) run.files.add(f)
        return
      case 'final':
        run.final = redactor.text('final', e.text)
        return
      case 'usage':
        run.usage = e.usage
        return
      case 'error':
        // 先打码再截:截掉 BEGIN 后正文就认不出了,半个令牌也认不出
        run.lastError = clip(redactor.text('error', e.message), ERROR_TEXT_MAX)
        if (this.keepsError(run.state, e)) run.state = foldEvent(run.state, { ...e, message: clip(e.message, ERROR_TEXT_MAX) })
        return
      default:
        run.state = foldEvent(run.state, e)
    }
  }

  /** 过了上限只再留第一个 fatal、第一个认证错误:判定用得上的都在,刷屏也撑不大 */
  private keepsError(state: RunState, e: Extract<RunEvent, { kind: 'error' }>): boolean {
    const { errors } = state
    if (errors.length < ERRORS_MAX) return true
    const isAuth = (x: { message: string; auth?: boolean }) => x.auth === true || AUTH_HINT.test(x.message)
    return (e.fatal === true && !errors.some(x => x.fatal)) || (isAuth(e) && !errors.some(isAuth))
  }

  /** killFailed 第一个看:进程还在就不能当作已结束,不管别的旗标怎么说 */
  private classify(run: Run, cli: CliResult): Outcome {
    if (cli.killFailed) return { status: 'failed', reason: 'kill_failed' }
    if (cli.spawnError !== undefined) return { status: 'failed', reason: 'spawn_failed' }
    const outcome = run.adapter.classify({
      ...run.state,
      code: cli.code,
      signal: cli.signal,
      timedOut: cli.timedOut,
      stalled: cli.stalled,
      // CLI 已经自己退了,取消才到(等管道的那 1 s):它的结局就是真实结局
      cancelled: cli.cancelled && !cli.exitedFirst,
    })
    return outcome.status === 'cancelled' && run.stopping ? { status: 'interrupted', reason: 'kernel_stopping' } : outcome
  }

  /** 每一步都兜着:git 或磁盘出错不能丢掉结束事件和通知 */
  private async finish(run: Run, attempt: Attempt): Promise<void> {
    const { deps } = this
    try {
      await run.throttle?.close(!run.stopping)
    } catch {
      // close 不抛;防的是以后
    }
    try {
      run.raw?.close()
    } catch (e) {
      this.log.warn('run raw log not closed', { error: e instanceof Error ? redact(e.message) : 'unknown' })
    }
    await this.dropUnusedWorktree(run)
    this.removeDeniedCopies(run)
    const changed = await this.collectChanges(run)
    const violations = await this.violations(run, changed)
    this.conclude(run, attempt, changed, violations)
  }

  /** 改动文件 = 两张快照的 diff;拍不到退回 CLI 自报 */
  private async collectChanges(run: Run): Promise<{ files: string[]; source: ExecutorChangesSource; raw: string[] }> {
    const { git } = this.deps
    const { log } = this
    const none = (source: ExecutorChangesSource, raw: string[]) => ({ files: raw.slice(0, FILES_MAX).map(run.redactor.mask), source, raw })
    if (run.startRef && run.spawned && !run.stopping) {
      try {
        // 沙箱外的 git 不能认 CLI 改过的 .git:它指向的配置里可以有 clean 过滤器
        const session = this.pinOf(run.s.sessionId)
        const pin = run.worktree ? worktreePin(session, run.worktree.path, run.cwd) : session
        if (!pin) {
          log.warn('worktree .git changed, no end snapshot', { runId: run.runId })
          return run.files.size > 0 ? none('cli', [...run.files]) : none('none', [])
        }
        const roots = this.gitOpts(pin)
        const end = await takeSnapshot(run.cwd, runRef(run.s.sessionId, run.runId, 'end'), git, roots)
        if (end.ref) {
          const list = await gitChanges(run.cwd, run.startRef, end.ref, git, roots)
          const wt = run.worktree
          // 副本是我们删的,不是 CLI 的改动
          return none('git', list.map(f => f.path).filter(f => !wt || !inRoots(join(wt.path, f), wt.denyRead)))
        }
        if (end.reason === 'error') log.warn('run end snapshot failed', { runId: run.runId })
        if (end.reason === 'unsafe_filter' || end.reason === 'unsafe_repo') log.warn('run snapshot skipped', { runId: run.runId, reason: end.reason })
      } catch (e) {
        log.warn('run changes failed', { runId: run.runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
      }
    }
    return run.files.size > 0 ? none('cli', [...run.files]) : none('none', [])
  }

  /**
   * 跑后过门(§8.4):git 的 diff 加上 CLI 自报的。快照不看被忽略的文件,也只看 cwd 前缀,所以 gitignore 里的 `x.env`、
   * cwd 外的写只有 CLI 自报这一条线索。git 的路径相对仓库根,CLI 的相对会话目录(Qoder 的是绝对路径);
   * 规则针对的是会话那棵树,worktree 运行也一样,所以 worktree 里的绝对路径先映射回去
   */
  private async violations(run: Run, changed: { source: ExecutorChangesSource; raw: string[] }): Promise<string[]> {
    const { deps } = this
    const { s } = run
    const fromGit = changed.source === 'git' ? changed.raw : []
    const reported = [...new Set([...run.files].map(f => this.toSessionTree(run, f)))]
    if (fromGit.length === 0 && reported.length === 0) return []
    try {
      const sessionDir = deps.sessions.get(s.sessionId)?.cwd ?? s.cwd
      let repoRoot = sessionDir
      if (fromGit.length > 0) {
        const repo = this.pinOf(s.sessionId)
        if (repo.kind === 'repo') repoRoot = repo.top
      }
      const inDiff = new Set(fromGit.map(f => resolveToolPath(repoRoot, f)))
      const extra = reported.filter(f => !inDiff.has(resolveToolPath(sessionDir, f)))
      return [
        ...checkViolations(deps.gate, s.sessionId, fromGit, repoRoot),
        ...checkViolations(deps.gate, s.sessionId, extra, sessionDir),
      ].map(run.redactor.mask)
    } catch (e) {
      this.log.warn('run violations not checked', { runId: run.runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
      return []
    }
  }

  /** worktree 里的绝对路径 → 会话仓库里的同一个文件。爬出 worktree 的不算,按它真正指向的判 */
  private toSessionTree(run: Run, file: string): string {
    const wt = run.worktree
    if (!wt || !isAbsolute(file)) return file
    const abs = resolve(file)
    return isInside(abs, wt.path, this.platform) ? join(wt.sessionTop, relative(wt.path, abs)) : file
  }

  /** 写结束事件、算通知、删临时目录、离开。到这里之后没有 await,也不会抛 */
  private conclude(run: Run, attempt: Attempt, changed: { files: string[]; source: ExecutorChangesSource }, violations: string[]): void {
    const { s, adapter, runId } = run
    const { cli, outcome } = attempt
    const ms = run.startedAt === undefined ? 0 : this.now() - run.startedAt
    const dropped = run.throttle?.dropped ?? 0
    const changedField = { files: changed.files, source: changed.source, ...(run.concurrent && { concurrent: true }) }
    this.write('executor.run.ended', s.sessionId, {
      runId, turnId: s.turnId, executor: adapter.id, status: outcome.status,
      ...(outcome.reason && { reason: outcome.reason }),
      ms,
      // 协议里是可选、不可为空
      exit: cli?.code ?? undefined,
      signal: cli?.signal ?? undefined,
      ...(run.usage && { usage: run.usage }),
      changed: changedField,
      ...(violations.length > 0 && { violations }),
      ...(run.worktree && { worktree: run.worktree.path }),
      ...(run.raw?.path && { rawLog: run.raw.path }),
      ...(run.nativeId && { nativeId: run.nativeId }),
      ...(dropped > 0 && { droppedProgress: dropped }),
    })
    if (attempt.uncounted) {
      const t = this.turn(s.turnId)
      t.submitted = Math.max(0, t.submitted - 1)
    }
    this.leave(run, this.notice(run, attempt, ms, changedField, violations, outcome.status))
  }

  private notice(run: Run, attempt: Attempt, ms: number, changed: { files: string[]; source: ExecutorChangesSource; concurrent?: boolean }, violations: string[], status: ExecutorRunStatus): string {
    const { cli, outcome, message } = attempt
    try {
      return noticeText({
        id: run.adapter.id, run: run.runId, status, reason: outcome.reason, exit: cli?.code, signal: cli?.signal, ms,
        isolation: run.isolation, changed, violations, untranslated: run.untranslated, usage: run.usage, rawLog: run.raw?.path, worktree: run.worktree?.path,
        stderrTail: run.stderrTail, final: run.final ?? run.lastError ?? message,
        killFailed: cli?.killFailed, leftovers: cli?.leftovers, networkLost: run.networkLost, droppedLines: run.droppedLines,
      }, run.redactor.mask)
    } catch (e) {
      this.log.warn('run notice fell back', { runId: run.runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
      return `<executor-notice run="${run.runId}" executor="${run.adapter.id}" status="${status}">\n[executor] id=${run.adapter.id} run=${run.runId} status=${status} reason=${outcome.reason ?? '-'}\n</executor-notice>`
    }
  }

  /**
   * CLI 可能把 TMPDIR 填得很满,同步删会卡住工作进程(含 session.prompt 和取消)。
   * 这一拍只改名,路径上的运行临时目录立刻没了;真正的删除在后台。改不了名就直接在原路径后台删
   */
  private dropTmp(dir: string): void {
    let doomed = dir
    try {
      renameSync(dir, `${dir}-rm`)
      doomed = `${dir}-rm`
    } catch {
      // 用原路径
    }
    const removal: Promise<void> = rm(doomed, { recursive: true, force: true })
      .catch(e => this.log.warn('run tmp dir not removed', { code: (e as NodeJS.ErrnoException)?.code }))
      .finally(() => this.removals.delete(removal))
    this.removals.add(removal)
  }

  /** 运行离开 active 的唯一出口:同一拍里 active 减一、通知进队、叫醒 wait */
  private leave(run: Run, text: string): void {
    if (run.tmpDir) this.dropTmp(run.tmpDir)
    this.live.delete(run.runId)
    const t = this.turn(run.s.turnId)
    t.active--
    t.notices.push({ runId: run.runId, text })
    for (const wake of [...t.waiters]) wake()
  }

  active(turnId: string): number {
    return this.turns.get(turnId)?.active ?? 0
  }

  pending(turnId: string): number {
    return this.turns.get(turnId)?.notices.length ?? 0
  }

  take(turnId: string): RunNotice[] {
    const t = this.turns.get(turnId)
    if (!t) return []
    const out = t.notices
    t.notices = []
    if (t.closed && t.active === 0) this.turns.delete(turnId)
    return out
  }

  /** 循环每次叫醒都中止输家,所以 signal 中止时要把自己摘干净 */
  wait(turnId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.pending(turnId) > 0) return Promise.resolve()
    const t = this.turn(turnId)
    return new Promise(resolve => {
      const done = () => {
        t.waiters.delete(done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      t.waiters.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  /**
   * 摘掉本轮排队的,取消在跑的,等它们都写完 run.ended。没有超时:runCli 一定返回,结束步骤里的 git 有自己的超时。
   * kernel_stopping:走短梯,不拍结束快照。已经在长梯上的(刚被 executor.cancel)从这一刻起也按短梯算。
   * 内核限时等这里(结束步骤里的 git 能卡很久),过了就接着 killLive:SIGINT 已经发过,直接杀组不会留下 Codex 的命令。
   * 日志已经关了也没关系:write 兜着,通知照样留在内存,来不及的由崩溃恢复补
   */
  async abandon(turnId: string, reason?: string): Promise<void> {
    const stopping = reason === 'kernel_stopping'
    if (stopping) this.stopped = true
    const t = this.turns.get(turnId)
    if (!t) return
    t.closed = true
    const waits: Promise<void>[] = []
    for (const run of [...this.live.values()]) {
      if (run.s.turnId !== turnId) continue
      if (stopping) run.stopping = true
      if (run.phase === 'queued') this.endQueued(run)
      else {
        run.abort.abort()
        if (run.done) waits.push(run.done)
      }
    }
    await Promise.allSettled(waits)
    this.dispatchQuietly()
  }

  /** 插件停用、内核关闭:所有轮。之后 submit 一律拒绝 */
  async abandonAll(reason?: string): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.turns.keys()].map(id => this.abandon(id, reason)))
    await Promise.allSettled([...this.removals])
  }

  /** 全部从事件和引用名推出来,重启后也能用。runId 不属于这个会话 → -32602 */
  async changes(sessionId: string, runId: string): Promise<{ files: FileChange[]; source: ExecutorChangesSource; concurrent?: boolean }> {
    const { git, tmpDir } = this.deps
    const { log } = this
    const events = this.deps.history(sessionId)
    const find = <T>(type: string): T | undefined => {
      const e = events.find(x => x.type === type && (x.payload as { runId?: string } | undefined)?.runId === runId)
      return e?.payload as T | undefined
    }
    if (!find('executor.run.queued')) throw new RpcError(-32602, 'unknown run')
    const started = find<{ cwd: string; worktree?: string; executor?: string }>('executor.run.started')
    const ended = find<{ status?: string; changed?: { files: string[]; source: ExecutorChangesSource; concurrent?: boolean } }>('executor.run.ended')
    const concurrent = ended?.changed?.concurrent ? { concurrent: true } : {}
    /** 算不了就报 run.ended 记下的。没有状态,一律按改过算 */
    const reported = () => {
      const files = ended?.changed?.files ?? []
      const source: ExecutorChangesSource = files.length > 0 ? ended!.changed!.source : 'none'
      return { files: files.map(path => ({ path, status: 'M' as const })), source, ...concurrent }
    }
    if (!started) return reported()
    const { cwd } = started
    const startRef = runRef(sessionId, runId, 'start')
    const endRef = runRef(sessionId, runId, 'end')
    try {
      const session = this.pinOf(sessionId)
      const pin = started.worktree ? worktreePin(session, started.worktree, cwd) : session
      if (!pin) return reported()
      const exists = (ref: string) => refExists(ref, git, { pin, tmpDir })
      if (!(await exists(startRef))) return reported()
      // 只有 finish 拍的结束快照算数。还在跑、中断的(内核关闭和崩溃都不拍)要现拍:这里之前写下的 -end 早就过时了
      const finished = ended !== undefined && ended.status !== 'interrupted' && ended.changed?.source === 'git'
      if (!finished || !(await exists(endRef))) {
        const end = await takeSnapshot(cwd, endRef, git, this.gitOpts(pin))
        if (!end.ref) return reported()
      }
      const files = await gitChanges(cwd, startRef, endRef, git, this.gitOpts(pin))
      const denied = this.deniedForChanges(sessionId, started)
      return { files: files.filter(f => !inRoots(join(started.worktree ?? cwd, f.path), denied)).map(f => ({ ...f, path: redact(f.path) })), source: 'git', ...concurrent }
    } catch (e) {
      log.warn('executor.changes failed', { runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
      return reported()
    }
  }

  /** run.ended 里已经滤掉了;这里按现在的规则再算一遍,重启后 Run 不在了 */
  private deniedForChanges(sessionId: string, started: { cwd: string; worktree?: string; executor?: string }): string[] {
    const { worktree } = started
    const sessionCwd = this.deps.sessions.get(sessionId)?.cwd
    const repo = this.pinOf(sessionId)
    if (!worktree || sessionCwd === undefined || repo.kind !== 'repo') return []
    const policy = treePolicy(cwd => this.deps.sandbox.execPolicy(sessionId, cwd, started.executor), sessionCwd, started.cwd, { session: repo.top, run: worktree })
    return denyReadCopies(policy, worktree)
  }

  /**
   * 路径从事件来,重启后也找得到。没有 started 也没有 ended(崩在建好之后、起进程之前)时按 id 推:
   * 运行确实属于这个会话才走到那一步。路径不在根下 removeWorktree 拒绝,所以日志里写什么都删不到别处
   */
  async discard(sessionId: string, runId: string): Promise<{ ok: boolean }> {
    const { git, tmpDir, worktreeRoot } = this.deps
    const live = this.live.get(runId)
    if (live?.s.sessionId === sessionId) throw new RpcError(ERR_BUSY, 'run in progress')
    if (live || !worktreeRoot) return { ok: false }
    const events = this.deps.history(sessionId)
    const payloads = events.filter(e => (e.payload as { runId?: string } | undefined)?.runId === runId)
    const of = (type: string) => payloads.find(e => e.type === type)?.payload as { worktree?: string } | undefined
    if (!of('executor.run.queued')) return { ok: false }
    const recorded = of('executor.run.started')?.worktree ?? of('executor.run.ended')?.worktree
    let path = recorded
    if (path === undefined) {
      try {
        path = join(realpathSync(worktreeRoot), sessionId, runId)
      } catch {
        return { ok: false }
      }
    }
    const present = existsSync(path)
    if (!present && recorded === undefined) return { ok: false }
    try {
      await removeWorktree(this.pinOf(sessionId), path, git, { tmpDir, root: worktreeRoot })
      return { ok: present }
    } catch (e) {
      this.log.warn('worktree not discarded', { runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
      return { ok: false }
    }
  }
}
