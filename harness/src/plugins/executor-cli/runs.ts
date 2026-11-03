// 运行管理(04 spec §9、§10、§12):排队、上限、生命周期、节流事件、原始日志、改动与通知。
// 一条规矩:运行离开 active 只有 leave() 一个出口,而 leave() 一定留下通知并叫醒 wait,否则这一轮就永远挂着
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { PermissionGate } from '../../kernel/permissionGate'
import type { Logger } from '../../kernel/log'
import { RpcError } from '../../kernel/rpcError'
import { changes as gitChanges, pruneRefs, repoInfo, takeSnapshot, type Git } from '../../lib/git/snapshot'
import type { PgidRegistry } from '../../lib/proc/pgids'
import { runCli as realRunCli, type CliPlan, type CliResult } from '../../lib/proc/runCli'
import { redact } from '../../lib/tools/redact'
import { shellEnv } from '../../lib/tools/shellEnv'
import type { BackgroundRuns, RunNotice, SandboxService } from '../../lib/tools/types'
import type { KernelEvent } from '../../protocol/index'
import type { ExecutorChangesSource, ExecutorIsolation, ExecutorRunReason, ExecutorRunStatus, FileChange } from '../../protocol/tools'
import { foldEvent, type Adapter, type Outcome, type RunEvent, type RunState } from './adapters/types'
import { binaryChanged, binaryDirs, isolationOf, trustedPath, type ExecutorInfo } from './detect'
import { cleanText, clip, noticeText } from './diagnostics'
import { checkViolations, mustAsk, protectDirs, translate, treePolicy } from './policy'

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
}

/** Task 9 实现。没有它之前,app 以外的写运行一律 worktree_unavailable */
export interface WorktreeOps {
  root: string
  add(repoCwd: string, path: string, commit: string): Promise<void>
  remove(repoCwd: string, path: string): Promise<void>
}

export interface RunManagerDeps {
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): KernelEvent
  sessions: { get(id: string): { cwd?: string } | undefined }
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
  worktree?: WorktreeOps
  /** 程序变了:这次运行失败,Task 10 在后台重新探测 */
  onBinaryChanged?(id: string): void
  /** 快照的临时目录 */
  tmpDir?: string
  home?: string
  platform?: NodeJS.Platform
  now?: () => number
  newId?: () => string
  /** 只给测试 */
  runCli?: typeof realRunCli
}

const KEEP_RUNS = 50
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
    this.timer = setTimeout(() => this.flush(), wait)
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
  /** CLI 跑的地方。Task 9 换成 worktree;s.cwd 始终是会话的目录 */
  cwd: string
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
}

interface Attempt {
  outcome: Outcome
  cli?: CliResult
  /** 没有 CLI 输出时放进 final 的话:只有我们自己的固定文字 */
  message?: string
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
}

const runRef = (sessionId: string, runId: string, phase: 'start' | 'end') => `refs/mffai/runs/${sessionId}/${runId}-${phase}`

export class RunManager implements BackgroundRuns {
  private live = new Map<string, Run>()
  private queue: Run[] = []
  private running = new Set<Run>()
  private turns = new Map<string, TurnState>()
  private seq = 0
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

  submit(s: SubmitInput): { runId: string; position: number } | { failure: Reason } {
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
      runId, adapter, s, seq: this.seq++, phase: 'queued', abort: new AbortController(), stopping: false,
      isolation: s.isolation, redactor: new RunRedactor(), cwd: s.cwd, writer: false, concurrent: false, spawned: false,
      state: { code: null, signal: null, completed: false, sawResult: false, errors: [], timedOut: false, stalled: false, cancelled: false },
      files: new Set(), stderrTail: '',
    }
    t.submitted++
    t.active++
    this.live.set(runId, run)
    this.queue.push(run)
    this.queue.sort((a, b) => Number(b.s.origin === 'app') - Number(a.s.origin === 'app') || a.seq - b.seq)
    const position = this.queue.indexOf(run)
    this.write('executor.run.queued', s.sessionId, {
      runId, turnId: s.turnId, callId: s.callId, executor: adapter.id,
      summary: `${adapter.id}: ${clip(redact(s.prompt), SUMMARY_MAX)}`,
      readOnly: s.readOnly, isolation: s.isolation, position,
    })
    this.dispatch()
    return { runId, position }
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
          this.dispatch()
        })
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

  /** 出队时再过一次门(C13)。返回拒绝的原因 */
  private refusal(run: Run, info: ExecutorInfo, isolation: ExecutorIsolation, missing: string[], must: boolean, summary: string): Reason | undefined {
    const { s, adapter } = run
    const { deps } = this
    const base = { actor: 'tools', sessionId: s.sessionId }
    const [exec, read, write] = deps.gate.checkMany([
      { ...base, action: 'exec', resource: adapter.id, summary, unsandboxed: isolation === 'none', mustAsk: must },
      { ...base, action: 'read', resource: s.cwd },
      { ...base, action: 'write', resource: s.cwd },
    ])
    if (exec === 'deny' || read === 'deny' || (!s.readOnly && write === 'deny')) return 'denied'
    if (missing.includes('untrusted_binary')) return 'untrusted_binary'
    if (!info.installed || info.path === undefined) return 'not_installed'
    const changed = binaryChanged(info)
    if (changed) deps.onBinaryChanged?.(adapter.id)
    // 比批准时宽:人批准的是有隔离的那次运行,asked 也不算(05 review I1)
    if (s.isolation !== 'none' && isolation === 'none') return 'sandbox_unavailable'
    if (changed) return 'untrusted_binary'
    if (exec === 'ask' && !s.asked) return 'denied'
    return undefined
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
    const info = deps.info(adapter.id)
    const allowRead = adapter.allowRead(home, deps.env)
    const allowWrite = adapter.allowWrite(home, deps.env)
    const policy = treePolicy(cwd => deps.sandbox.execPolicy(s.sessionId, cwd, adapter.id), s.cwd, run.cwd)
    const protect = protectDirs({
      kind: adapter.isolationKind, pathDirs, binary: binaryDirs(info), cwd: run.cwd, keepWritable: [run.cwd, s.spillDir, ...allowWrite], platform,
    })
    const t = translate(policy, protect)
    const level = deps.sandbox.status(s.sessionId).level
    const { isolation, missing } = isolationOf(adapter, info, level, cfg, { cwd: run.cwd, denyRead: t.denyRead, readOnlyPaths: t.readOnlyPaths })
    run.isolation = isolation
    run.untranslated = t.untranslated

    const summary = `${adapter.id}: ${clip(redact(s.prompt), SUMMARY_MAX)}`
    const refused = this.refusal(run, info, isolation, missing, mustAsk(policy, isolation), summary)
    if (refused) return failed(refused, REFUSALS[refused] ?? 'Not started.')
    if (s.origin !== 'app' && !s.readOnly) return failed('worktree_unavailable', REFUSALS.worktree_unavailable!)

    // 抛错(模型名不合规、路径是相对的)走 execute 的 catch:spawn_failed
    const built = adapter.buildArgs({
      prompt: s.prompt, cwd: run.cwd, model: s.model, readOnly: s.readOnly, isolation,
      denyRead: t.denyRead, readOnlyPaths: t.readOnlyPaths, network: cfg.codex?.network === true,
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
        if (other !== run && other.writer && other.cwd === run.cwd) {
          other.concurrent = true
          run.concurrent = true
        }
      }
      await this.startSnapshot(run)
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
        if (p.level === 'partial') this.log.warn('run sandbox is partial', { runId: run.runId })
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

    run.raw = new RawLog(s.spillDir, run.runId, deps.log)
    run.throttle = new ProgressThrottle(
      (kind, text) => deps.append({ type: 'executor.run.progress', sessionId: s.sessionId, payload: { runId: run.runId, turnId: s.turnId, kind, text } } as Omit<KernelEvent, 'seq' | 'ts'>),
      this.now,
    )

    const cli = await (deps.runCli ?? realRunCli)(plan, {
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
          ...(t.untranslated > 0 && { untranslatedRules: t.untranslated }),
        })
      },
      onClose: pid => deps.registry?.settle(pid),
      onLine: line => this.onLine(run, line),
      onDroppedLine: bytes => run.raw?.line(`{"droppedLine":${bytes}}`),
      onStderrLine: line => this.onStderr(run, line),
    })
    return { outcome: this.classify(run, cli), cli, ...(cli.spawnError && { message: cli.spawnError }) }
  }

  private async startSnapshot(run: Run): Promise<void> {
    const { git, tmpDir } = this.deps
    const { log } = this
    const { sessionId } = run.s
    const r = await takeSnapshot(run.cwd, runRef(sessionId, run.runId, 'start'), git, { tmpDir })
    if (r.reason === 'error') log.warn('run start snapshot failed', { runId: run.runId })
    if (!r.ref) return
    run.startRef = r.ref
    await pruneRefs(run.cwd, `refs/mffai/runs/${sessionId}`, KEEP_RUNS, git, { tmpDir }).catch(() => log.warn('run ref prune failed', { runId: run.runId }))
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
        for (const f of e.files) if (run.files.size < FILES_MAX) run.files.add(f)
        return
      case 'final':
        run.final = redactor.text('final', e.text)
        return
      case 'usage':
        run.usage = e.usage
        return
      case 'error':
        run.lastError = redactor.text('error', clip(e.message, ERROR_TEXT_MAX))
        if (run.state.errors.length < ERRORS_MAX || e.fatal) run.state = foldEvent(run.state, { ...e, message: clip(e.message, ERROR_TEXT_MAX) })
        return
      default:
        run.state = foldEvent(run.state, e)
    }
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
    const changed = await this.collectChanges(run)
    const violations = await this.violations(run, changed)
    this.conclude(run, attempt, changed, violations)
  }

  /** 改动文件 = 两张快照的 diff;拍不到退回 CLI 自报 */
  private async collectChanges(run: Run): Promise<{ files: string[]; source: ExecutorChangesSource; raw: string[] }> {
    const { git, tmpDir } = this.deps
    const { log } = this
    const none = (source: ExecutorChangesSource, raw: string[]) => ({ files: raw.map(run.redactor.mask), source, raw })
    if (run.startRef && run.spawned && !run.stopping) {
      try {
        const end = await takeSnapshot(run.cwd, runRef(run.s.sessionId, run.runId, 'end'), git, { tmpDir })
        if (end.ref) {
          const list = await gitChanges(run.cwd, run.startRef, end.ref, git, { tmpDir })
          return none('git', list.map(f => f.path).slice(0, FILES_MAX))
        }
        if (end.reason === 'error') log.warn('run end snapshot failed', { runId: run.runId })
      } catch (e) {
        log.warn('run changes failed', { runId: run.runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
      }
    }
    return run.files.size > 0 ? none('cli', [...run.files]) : none('none', [])
  }

  /**
   * 跑后过门(§8.4)。git 给的路径相对仓库根,CLI 自报的相对 cwd;repoRoot 永远是会话那棵树,worktree 运行也一样,规则针对的是它
   */
  private async violations(run: Run, changed: { source: ExecutorChangesSource; raw: string[] }): Promise<string[]> {
    if (changed.raw.length === 0) return []
    const { deps } = this
    const { s } = run
    try {
      const sessionDir = deps.sessions.get(s.sessionId)?.cwd ?? s.cwd
      let repoRoot = sessionDir
      if (changed.source === 'git') {
        const repo = await repoInfo(sessionDir, deps.git, { tmpDir: deps.tmpDir }).catch(() => undefined)
        if (repo) repoRoot = repo.top
      }
      return checkViolations(deps.gate, s.sessionId, changed.raw, repoRoot).map(run.redactor.mask)
    } catch (e) {
      this.log.warn('run violations not checked', { runId: run.runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
      return []
    }
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
      ...(run.raw?.path && { rawLog: run.raw.path }),
      ...(run.nativeId && { nativeId: run.nativeId }),
      ...(dropped > 0 && { droppedProgress: dropped }),
    })
    this.leave(run, this.notice(run, attempt, ms, changedField, violations, outcome.status))
  }

  private notice(run: Run, attempt: Attempt, ms: number, changed: { files: string[]; source: ExecutorChangesSource; concurrent?: boolean }, violations: string[], status: ExecutorRunStatus): string {
    const { cli, outcome, message } = attempt
    try {
      return noticeText({
        id: run.adapter.id, run: run.runId, status, reason: outcome.reason, exit: cli?.code, signal: cli?.signal, ms,
        isolation: run.isolation, changed, violations, untranslated: run.untranslated, usage: run.usage, rawLog: run.raw?.path,
        stderrTail: run.stderrTail, final: run.final ?? run.lastError ?? message,
        killFailed: cli?.killFailed, leftovers: cli?.leftovers,
      }, run.redactor.mask)
    } catch (e) {
      this.log.warn('run notice fell back', { runId: run.runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
      return `<executor-notice run="${run.runId}" executor="${run.adapter.id}" status="${status}">\n[executor] id=${run.adapter.id} run=${run.runId} status=${status} reason=${outcome.reason ?? '-'}\n</executor-notice>`
    }
  }

  /** 运行离开 active 的唯一出口:同一拍里 active 减一、通知进队、叫醒 wait */
  private leave(run: Run, text: string): void {
    if (run.tmpDir) {
      try {
        rmSync(run.tmpDir, { recursive: true, force: true })
      } catch (e) {
        this.log.warn('run tmp dir not removed', { code: (e as NodeJS.ErrnoException)?.code })
      }
    }
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
   * kernel_stopping:走短梯,不拍结束快照。已经在长梯上的(刚被 executor.cancel)改不了预算,只能等,最长约 6 s,
   * 比 CLOSE_GRACE_MS 长;这时内核接着 killLive,SIGINT 已经发过,直接杀组不会留下 Codex 的命令。
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
    this.dispatch()
  }

  /** 插件停用、内核关闭:所有轮。之后 submit 一律拒绝 */
  async abandonAll(reason?: string): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.turns.keys()].map(id => this.abandon(id, reason)))
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
    const started = find<{ cwd: string; worktree?: string }>('executor.run.started')
    const ended = find<{ changed?: { files: string[]; source: ExecutorChangesSource; concurrent?: boolean } }>('executor.run.ended')
    const concurrent = ended?.changed?.concurrent ? { concurrent: true } : {}
    const reported = () => {
      const files = ended?.changed?.source === 'cli' ? ended.changed.files : []
      // CLI 自报没有状态,一律按改过算
      return { files: files.map(path => ({ path, status: 'M' as const })), source: files.length > 0 ? ('cli' as const) : ('none' as const), ...concurrent }
    }
    if (!started) return reported()
    const cwd = started.worktree ?? started.cwd
    const startRef = runRef(sessionId, runId, 'start')
    const endRef = runRef(sessionId, runId, 'end')
    const exists = async (ref: string) => (await git(['rev-parse', '-q', '--verify', ref], { cwd })).code === 0
    try {
      if (!(await exists(startRef))) return reported()
      if (!(await exists(endRef))) {
        const end = await takeSnapshot(cwd, endRef, git, { tmpDir })
        if (!end.ref) return reported()
      }
      const files = await gitChanges(cwd, startRef, endRef, git, { tmpDir })
      return { files: files.map(f => ({ ...f, path: redact(f.path) })), source: 'git', ...concurrent }
    } catch (e) {
      log.warn('executor.changes failed', { runId, error: e instanceof Error ? redact(e.message) : 'unknown' })
      return reported()
    }
  }
}
