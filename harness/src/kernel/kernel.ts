import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ERR_BUSY,
  ERR_DRAINING,
  WorkerMethods,
  type KernelEvent,
  type SnapshotResult,
  type StatusResult,
  type WorkerMethodName,
} from '../protocol/index'
import { KernelConfigSchema, loadConfig, saveConfig, type KernelConfig } from './config'
import { EventBus } from './events'
import { EventLog, openDb, transaction } from './eventLog'
import { Approvals } from './approvals'
import { nullLogger, type Logger } from './log'
import { PermissionGate } from './permissionGate'
import { PermissionsStore } from './permissions'
import { PluginHost, type Plugin } from './pluginHost'
import { Receipts } from './receipts'
import { RpcError } from './rpcError'
import { RpcRegistry } from './rpcRegistry'
import { openSecretStore, type OpenSecretStoreOpts } from './secrets/secretStore'
import { ServiceRegistry } from './services'
import { Sessions, validateCwd } from './sessions'
import { CLOSE_GRACE_MS, KILL_LIVE_GRACE_MS } from './shutdown'
import { overbroadRelocations, snapshotEnv } from '../lib/fs/paths'
import { killLive, pgidFile, PgidRegistry, type PgidEntry } from '../lib/proc/pgids'
import { createSandboxService } from './sandbox'
import { detectSandbox, type DetectResult } from '../lib/sandbox/detect'
import { upstreamFromEnv, type LookupFn, type Upstream } from '../lib/sandbox/net/proxy'
import type { Git } from '../lib/git/snapshot'
import { HARNESS_VERSION } from './version'
import { toWire } from './wire'

export interface Kernel {
  handle(method: string, params: unknown): Promise<unknown>
  events: EventLog
  status(): StatusResult
  snapshot(): SnapshotResult
  readonly draining: boolean
  drain(timeoutMs: number): Promise<void>
  close(): Promise<void>
}

export interface KernelOpts {
  dataDir: string
  plugins: Plugin[]
  log?: Logger
  injectTimeoutMs?: number
  /** 凭据存储选项;必填,避免测试误用真钥匙串(测试传 `{ osBackend: false }` 或注入 exec) */
  secrets: Omit<OpenSecretStoreOpts, 'dataDir' | 'log'>
  /** 用户主目录(凭据黑名单的基准);默认 os.homedir(),测试传临时目录 */
  home?: string
  /** 审批无应答多久按拒绝处理;默认 10 分钟 */
  approvalTimeoutMs?: number
  /** 凭据黑名单 / 持久化文件读的环境;默认 process.env。启动时拷一份,之后的变化不影响判定 */
  env?: NodeJS.ProcessEnv
  /** shell 进程组登记文件(spec §12);默认 `dataDir/run/shell-pgids`。win32 不登记 */
  pgidFile?: string
  /** 启动时 reapOrphans 认不了、留到下次的条目(`ReapResult.kept`),登记从它们开始 */
  pgidSeed?: PgidEntry[]
  /**
   * 沙箱(05 spec §7、§10)。不给 = 真实探测(生产默认);测试传 `NO_SANDBOX`(harness/test/sandboxStub.ts)或注入 detect。
   * upstream:不给 = 从环境快照的 HTTPS_PROXY 等取;null = 没有上游
   */
  sandbox?: {
    detect?: () => DetectResult | Promise<DetectResult>
    execPath?: string
    upstream?: Upstream | null
    lookup?: LookupFn
    idleMs?: number
    /** 查 gitDir 用的 git(测试注入隔离的环境) */
    git?: Git
  }
}

const ERR_METHOD_NOT_FOUND = -32601
const ERR_INVALID_PARAMS = -32602
const ERR_INTERNAL = -32603
const CANCEL_GRACE_MS = 1000
const APPROVAL_TIMEOUT_MS = 600_000

type Turn = { turnId: string; sessionId: string; ended: boolean; controller: AbortController; settled: Promise<void>; terminal?: KernelEvent }

const isTerminal = (type: string) => type === 'turn.ended' || type === 'turn.failed'

export async function createKernel(opts: KernelOpts): Promise<Kernel> {
  const log = opts.log ?? nullLogger
  const startedAt = Date.now()
  mkdirSync(join(opts.dataDir, 'db'), { recursive: true })
  const db = openDb(join(opts.dataDir, 'db', 'events.sqlite'))
  const eventLog = new EventLog(db, { onListenerError: err => log.error('event listener failed', { error: String(err) }) })
  const receipts = new Receipts(db)
  const services = new ServiceRegistry()
  const bus = new EventBus({ onError: (type, err) => log.error(`handler for ${type} failed`, { error: String(err) }) })
  bus.declare('session.prompt', 'bail')
  const home = opts.home ?? homedir()
  const envSnapshot = snapshotEnv(opts.env ?? process.env, process.platform)
  const broad = overbroadRelocations(envSnapshot, home, process.platform)
  if (broad.length) log.warn('credential env var covers home or root', { vars: broad.map(b => `${b.name}:${b.covers}`).join(',') })
  const sessions = new Sessions(opts.dataDir)
  sessions.load(eventLog.after(0))
  eventLog.onAppend(e => sessions.observe(e)) // 事务提交后才通知:回滚的 session.created 不会进来
  const turns = new Map<string, Turn>() // turnId -> 进行中的 turn
  const activeBySession = new Map<string, string>() // sessionId -> turnId(每会话最多一个)
  /**
   * 所有写入都经这里。进行中的 turn 只收一个终态:已终结的 turn 再来 turn.ended / turn.failed 直接丢弃,
   * 返回第一条(如取消宽限期过后内核已写 cancelled,忽略 SIGTERM 的 shell 被 SIGKILL 后循环又写一条)。
   * 检查与写入同步完成,中间不会插进别的写入
   */
  const append = (e: Omit<KernelEvent, 'seq' | 'ts'>): KernelEvent => {
    const id = isTerminal(e.type) ? (e.payload as { turnId?: unknown } | null)?.turnId : undefined
    const t = typeof id === 'string' ? turns.get(id) : undefined
    if (t?.terminal) return t.terminal
    const written = eventLog.append(e)
    if (t) {
      t.ended = true
      t.terminal = written
    }
    return written
  }
  const approvals = new Approvals({ append, log, timeoutMs: opts.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS })
  const pgids = process.platform === 'win32' ? undefined : new PgidRegistry(opts.pgidFile ?? pgidFile(opts.dataDir), process.platform, { log, seed: opts.pgidSeed })
  const configFile = join(opts.dataDir, 'config.json')
  let config = loadConfig(configFile)
  const configAccess = {
    get: () => config,
    update: (section: keyof KernelConfig, value: unknown) => {
      const next = KernelConfigSchema.parse({ ...config, [section]: value })
      saveConfig(configFile, next) // 先落盘,成功后才换内存
      config = next
    },
  }
  // 规则写坏了只记进 errors,不影响启动,也不动 config.json(spec §6)
  const permissions = new PermissionsStore({ config: configAccess, ctx: { home, platform: process.platform, realpath: realpathSync.native } })
  // 探测一次(约 50 ms),之后缓存;enabled / allowLoopback 由服务现读配置
  const so = opts.sandbox ?? {}
  const detectStart = Date.now()
  const detected = await (so.detect ?? (() => detectSandbox({ platform: process.platform, enabled: true })))()
  const detectMs = Date.now() - detectStart
  if (detectMs > 500) log.warn('sandbox detection was slow', { ms: detectMs, level: detected.level }) // 挂住的容器里最多 2×3 s
  let upstream: Upstream | undefined
  if (so.upstream === undefined) {
    const u = upstreamFromEnv(envSnapshot)
    if (u.warning) log.warn('sandbox upstream proxy unsupported', { warning: u.warning })
    upstream = u.upstream
  } else upstream = so.upstream ?? undefined
  const sandbox = createSandboxService({
    platform: process.platform,
    dataDir: opts.dataDir,
    home,
    env: envSnapshot,
    detected,
    permissions: () => permissions.get().config,
    append: e => append(e),
    currentTurn: sid => activeBySession.get(sid),
    execPath: so.execPath,
    upstream,
    lookup: so.lookup,
    idleMs: so.idleMs,
    git: so.git,
    log,
  })
  /** 全局状态(status / snapshot 用):不含单个会话的代理失败 */
  const sandboxStatus = () => sandbox.status()
  const gate = new PermissionGate({
    sessions, home, dataDir: opts.dataDir, platform: process.platform, env: envSnapshot, permissions: () => permissions.get(),
    sandbox: sid => sandbox.status(sid),
  })
  const rpc = new RpcRegistry()
  // 后端故障不抛错:状态为 unavailable / unreadable,内核照常启动
  const secrets = await openSecretStore({ ...opts.secrets, dataDir: opts.dataDir, log })
  const host = new PluginHost({
    services, events: bus, rpc, append, history: sid => eventLog.bySession(sid), log, dataDir: opts.dataDir, injectTimeoutMs: opts.injectTimeoutMs, secrets, config: configAccess,
  })

  let state: StatusResult['state'] = 'starting'

  const failTurn = (t: Turn, reason: string, extra?: Record<string, unknown>) => {
    if (t.ended) return
    append({ type: 'turn.failed', sessionId: t.sessionId, payload: { turnId: t.turnId, reason, ...extra } })
  }

  // 崩溃恢复:有开始痕迹却无终态的 turn 标记 interrupted,不重放(副作用不确定)
  const open = new Map<string, string | undefined>()
  for (const e of eventLog.after(0)) {
    const id = (e.payload as { turnId?: string } | null)?.turnId
    if (!id) continue
    if (e.type === 'turn.started' || e.type === 'message.user') open.set(id, e.sessionId)
    else if (isTerminal(e.type)) open.delete(id)
  }
  for (const [turnId, sessionId] of open) append({ type: 'turn.failed', sessionId, payload: { turnId, reason: 'interrupted' } })

  const dispatchPrompt = (sessionId: string, turnId: string, text: string) => {
    const controller = new AbortController()
    const turn: Turn = { turnId, sessionId, controller, ended: false, settled: Promise.resolve() }
    turns.set(turnId, turn)
    activeBySession.set(sessionId, turnId) // 先登记:处理者可能同步写完终态事件
    turn.settled = (async () => {
      let failure: string | undefined
      try {
        await bus.bail('session.prompt', { sessionId, turnId, text, signal: controller.signal })
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
        log.error('session.prompt handler failed', { error: failure })
      }
      // 处理者结束后 turn 仍未终结:补 turn.failed
      if (!controller.signal.aborted) {
        failTurn(turn, failure ? 'error' : 'unhandled', failure ? { message: failure } : undefined)
      }
      turns.delete(turnId)
      if (activeBySession.get(sessionId) === turnId) activeBySession.delete(sessionId)
    })()
  }

  /** 回执重放 / 事务内写入;返回 [result, after-commit 副作用] */
  function command<R>(
    method: string,
    commandId: string,
    run: () => { result: R; after?: () => void },
    opts: { allowDraining?: boolean } = {},
  ): { result: R; replayed: boolean } {
    const prior = receipts.get(commandId)
    if (prior) {
      if (prior.method !== method) throw new RpcError(ERR_INVALID_PARAMS, 'commandId already used by another method')
      return { result: prior.result as R, replayed: true }
    }
    if (state === 'draining' && !opts.allowDraining) throw new RpcError(ERR_DRAINING, 'draining')
    let after: (() => void) | undefined
    const result = transaction(db, () => {
      const r = run()
      receipts.put(commandId, method, r.result)
      after = r.after
      return r.result
    })
    after?.()
    return { result, replayed: false }
  }

  // 插件命令(异步):成功后才写回执;失败不留回执,可用同一 commandId 重试
  const inflight = new Map<string, { method: string; promise: Promise<unknown> }>()
  async function pluginCommand(method: string, commandId: string, run: () => Promise<unknown>): Promise<unknown> {
    const running = inflight.get(commandId)
    if (running) {
      if (running.method !== method) throw new RpcError(ERR_INVALID_PARAMS, 'commandId already used by another method')
      return running.promise
    }
    const prior = receipts.get(commandId)
    if (prior) {
      if (prior.method !== method) throw new RpcError(ERR_INVALID_PARAMS, 'commandId already used by another method')
      return prior.result
    }
    if (state === 'draining') throw new RpcError(ERR_DRAINING, 'draining')
    const promise = (async () => {
      try {
        const result = await run()
        receipts.put(commandId, method, result)
        return result
      } finally {
        inflight.delete(commandId)
      }
    })()
    inflight.set(commandId, { method, promise })
    return promise
  }

  async function cancel(sessionId: string): Promise<void> {
    const id = activeBySession.get(sessionId)
    const t = id ? turns.get(id) : undefined
    if (!t) return
    t.controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([t.settled, new Promise<void>(r => { timer = setTimeout(r, CANCEL_GRACE_MS) })])
    clearTimeout(timer)
    failTurn(t, 'cancelled')
  }

  function status(): StatusResult {
    return {
      state,
      uptimeMs: Date.now() - startedAt,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      version: HARNESS_VERSION,
      plugins: host.states(),
      secretsBackend: secrets.backend,
      sandbox: sandboxStatus(),
    }
  }

  function snapshot(): SnapshotResult {
    const sessions = new Map<string, { id: string; title: string; updatedAt: number }>()
    for (const e of eventLog.after(0)) {
      if (!e.sessionId) continue
      if (e.type === 'session.created') {
        const title = (e.payload as { title?: string } | null)?.title
        sessions.set(e.sessionId, { id: e.sessionId, title: title || '新会话', updatedAt: e.ts })
      } else {
        const s = sessions.get(e.sessionId)
        if (s) s.updatedAt = e.ts
      }
    }
    return { status: status(), sessions: [...sessions.values()], lastSeq: eventLog.lastSeq() }
  }

  const kernel: Kernel = {
    events: eventLog,
    status,
    snapshot,
    get draining() {
      return state === 'draining'
    },

    async handle(method, rawParams) {
      if (!Object.hasOwn(WorkerMethods, method)) throw new RpcError(ERR_METHOD_NOT_FOUND, `method not found: ${method}`)
      const name = method as WorkerMethodName
      const parsed = WorkerMethods[name].params.safeParse(rawParams === undefined ? {} : rawParams)
      if (!parsed.success) throw new RpcError(ERR_INVALID_PARAMS, 'invalid params', parsed.error.issues)
      const p = parsed.data as any

      switch (name) {
        case 'status':
          return status()
        case 'snapshot':
          return snapshot()
        case 'events.tail':
          return { events: eventLog.tail(p.limit).map(toWire) }
        case 'session.create':
          return command(name, p.commandId, () => {
            const cwd = p.cwd === undefined ? undefined : validateCwd(p.cwd, { home, dataDir: opts.dataDir, platform: process.platform, env: envSnapshot })
            const sessionId = randomUUID()
            const payload = {
              title: p.title,
              ...(p.model && { model: p.model }),
              ...(cwd && { cwd }),
              approvalMode: p.approvalMode ?? 'ask',
              ...(p.toolset && { toolset: p.toolset }),
              ...(p.origin && p.origin !== 'app' && { origin: p.origin }),
            }
            append({ type: 'session.created', sessionId, payload })
            return { result: { sessionId } }
          }).result
        case 'session.prompt':
          return command(name, p.commandId, () => {
            if (activeBySession.has(p.sessionId)) throw new RpcError(ERR_BUSY, 'turn in progress') // 回滚,不留回执
            const turnId = randomUUID()
            append({ type: 'message.user', sessionId: p.sessionId, payload: { turnId, text: p.text } })
            // 提交之后才交给循环插件
            return { result: { accepted: true, turnId }, after: () => dispatchPrompt(p.sessionId, turnId, p.text) }
          }).result
        case 'permissions.get': {
          if (p.sessionId !== undefined && !sessions.get(p.sessionId)) throw new RpcError(ERR_INVALID_PARAMS, 'unknown session')
          const { config: cfg, errors } = permissions.get()
          // 有 sessionId:默认规则与沙箱状态都按该会话(含它的代理失败)
          return { config: cfg, defaults: gate.defaults(p.sessionId), errors, sandbox: sandbox.status(p.sessionId) }
        }
        case 'permissions.set':
          return command(name, p.commandId, () => {
            const v = permissions.validate(p.config)
            if (!v.ok) throw new RpcError(ERR_INVALID_PARAMS, 'invalid rules', v.errors) // 回滚,不留回执,不落盘
            // 事件先写进事务:落盘失败时一起回滚
            append({ type: 'permissions.updated', payload: { rules: v.config.rules.length, network: v.config.network.allow.length } })
            permissions.apply(v)
            return { result: { ok: true } }
          }).result
        case 'approval.respond':
          return { ok: approvals.respond(p.approvalId, p.decision) }
        case 'session.cancel': {
          const r = command(name, p.commandId, () => ({ result: { ok: true } }), { allowDraining: true })
          if (!r.replayed) await cancel(p.sessionId) // 重放不产生副作用
          return r.result
        }
        default: {
          // 插件注册的方法;auth / hello / events.subscribe 属于传输层,不会走到这里
          const handler = rpc.get(name)
          if (!handler) throw new RpcError(ERR_METHOD_NOT_FOUND, `method not handled: ${method}`)
          const run = async () => {
            try {
              return await handler(p)
            } catch (err) {
              if (err instanceof RpcError) throw err
              log.error(`rpc ${method} failed`, { error: err instanceof Error ? err.message : String(err) })
              throw new RpcError(ERR_INTERNAL, 'internal error')
            }
          }
          // 带 commandId 的方法与核心命令同样:回执重放 + 排空时拒绝
          return typeof p.commandId === 'string' ? pluginCommand(name, p.commandId, run) : run()
        }
      }
    },

    async drain(timeoutMs) {
      state = 'draining'
      let timer: ReturnType<typeof setTimeout> | undefined
      const inflight = Promise.all([...turns.values()].map(t => t.settled))
      await Promise.race([inflight, new Promise<void>(r => { timer = setTimeout(r, timeoutMs) })])
      clearTimeout(timer)
    },

    async close() {
      append({ type: 'kernel.stopping', payload: {} })
      approvals.cancelAll() // 在关库之前:待决审批写完 resolved 再停
      // 中止进行中的 turn(模型流、工具、shell 进程树),等它们写完终态再关库;不等无限久
      const running = [...turns.values()]
      for (const t of running) t.controller.abort()
      if (running.length) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([Promise.all(running.map(t => t.settled)), new Promise<void>(r => { timer = setTimeout(r, CLOSE_GRACE_MS) })])
        clearTimeout(timer)
      }
      // shell 留在后台的组(开发服务器等):无主进程比被杀更糟
      if (pgids) await killLive(pgids, KILL_LIVE_GRACE_MS).catch(err => log.error('killLive failed', { error: String(err) }))
      await sandbox.close().catch(err => log.error('sandbox close failed', { error: String(err) }))
      await host.deactivateAll()
      db.close()
    },
  }

  services.provide('permissionGate', gate)
  services.provide('sessions', sessions)
  services.provide('approvals', approvals)
  if (pgids) services.provide('pgids', pgids)
  services.provide('sandbox', sandbox)
  append({ type: 'kernel.started', payload: { version: HARNESS_VERSION } })
  await host.activateAll(opts.plugins, config.plugins.disabled)
  state = 'running'
  return kernel
}
