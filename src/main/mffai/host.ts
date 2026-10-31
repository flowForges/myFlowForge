import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import {
  connectClient,
  connectControlClient,
  PROTOCOL_VERSION,
  dataDir as defaultDataDir,
  runtimePaths,
  type ControlMethodName,
  type ControlParams,
  type ControlResult,
  type ControlStatus,
  type MffaiClient,
  type MffaiState,
  type ModelRef,
  type WorkerParams,
  type WorkerResult,
} from '@mffai/protocol'
import { controlCall, readSupervisorJson, type ConnectControl, type ConnectWorker } from './client'
import { createWorkerConnection, isOldProtocol } from './connection'
import { spawnDaemon, type SpawnFn } from './spawn'

// app 主进程里的 mff-ai 宿主。★只经 index.ts / ipc.ts 动态 import:未启用时永不加载。

export interface HostDeps {
  send(ch: string, payload: unknown): void
  readSettings(): { mffai: { enabled: boolean; autostart: boolean }; appProxy?: string }
  clientVersion: string
  /** out/main/mffaiDaemon.js 的绝对路径(由 index.ts 算,见 spawn.ts) */
  daemonJs: string
  execPath?: string
  dataDir?: string
  spawnFn?: SpawnFn
  connectControl?: ConnectControl
  connectWorker?: ConnectWorker
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string, err?: unknown) => void
  /** 进程是否还在;默认 process.kill(pid, 0) */
  isAlive?: (pid: number) => boolean
  /** 给进程发信号;默认 process.kill */
  kill?: (pid: number, sig: NodeJS.Signals) => void
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' // 在,但不是我们的
  }
}

const START_WAIT_MS = 10_000
const STOP_WAIT_MS = 35_000 // 排空最多 30 s
const POLL_MS = 200

/** 页面能填的添加账号字段;commandId 由宿主生成 */
export type AddAccountInput = Omit<WorkerParams<'models.addAccount'>, 'commandId'>
export type OpenExternal = (url: string) => void
/** 调试会话选项:cwd 非空才建编码会话;审批模式建会话时定下 */
export interface PromptOpts { cwd?: string; approvalMode?: 'ask' | 'auto' }
export type ApprovalDecision = WorkerParams<'approval.respond'>['decision']

// 只认 https + 精确主机名 + 前缀,挡住 chatgpt.com.evil.com / chatgpt.com@evil.com 之类;返回规范化后的地址
function allowedUrl(url: unknown, prefix: string): string | undefined {
  if (typeof url !== 'string' || !url.startsWith(prefix)) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !u.username && !u.password && `${u.protocol}//${u.host}/` === prefix ? u.href : undefined
  } catch {
    return undefined
  }
}
const EXTERNAL_PREFIX = 'https://chatgpt.com/'

/** ChatGPT 登录:只放行后台回调监听的一次性地址 http://127.0.0.1:<port>/auth/start?flow=<flowId>;返回规范化后的地址 */
function loginStartUrl(url: unknown, flowId: string): string | undefined {
  if (typeof url !== 'string') return undefined
  try {
    const u = new URL(url)
    const ok = u.protocol === 'http:' && u.hostname === '127.0.0.1' && /^\d+$/.test(u.port) && !u.username && !u.password && !u.hash &&
      u.pathname === '/auth/start' && [...u.searchParams.keys()].join() === 'flow' && u.searchParams.get('flow') === flowId
    return ok ? u.href : undefined
  } catch {
    return undefined
  }
}

export type MffaiHost = ReturnType<typeof createMffaiHost>

export function createMffaiHost(deps: HostDeps) {
  const dir = deps.dataDir ?? (process.env.MFFAI_DATA_DIR || defaultDataDir())
  const paths = runtimePaths(dir)
  const execPath = deps.execPath ?? process.execPath
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const log = deps.log ?? (() => {})
  const connectControl = deps.connectControl ?? connectControlClient
  const isAlive = deps.isAlive ?? defaultIsAlive
  const kill = deps.kill ?? ((pid: number, sig: NodeJS.Signals) => void process.kill(pid, sig))
  const spec = { execPath, daemonJs: deps.daemonJs }

  // 调试会话:模型 + 工作目录 + 审批模式,任一变了就新建
  let debugSession: { key: string; id: string } | undefined

  const control = <M extends ControlMethodName>(m: M, p?: ControlParams<M>): Promise<ControlResult<M>> =>
    controlCall(connectControl, paths, m, p)
  /**
   * 旧协议(v2)的后台:v3 的 challenge 第一步就被拒,控制口什么都问不到。
   * 这时读 supervisor.json:协议版本不同且 pid 还活着 → 返回它(pid + 版本),否则 undefined
   */
  const oldDaemon = () => {
    const j = readSupervisorJson(paths.supervisorJson)
    return j && j.protocolVersion !== PROTOCOL_VERSION && isAlive(j.pid) ? j : undefined
  }
  // 由 supervisor.json 合成的状态(控制口不认我们):只能靠信号停
  const fromJson = new WeakSet<ControlStatus>()
  const status = (): Promise<ControlStatus | undefined> =>
    control('status').catch((err): ControlStatus | undefined => {
      if ((err as Error)?.message !== 'unauthorized') return undefined
      const j = oldDaemon()
      if (!j) return undefined
      // 合成一个"旧版本在跑"的状态,走已有的不兼容 → 用户点重启路径
      const s: ControlStatus = { state: 'running', pid: j.pid, protocolVersion: j.protocolVersion, restarts: 0, version: j.version ?? '' }
      fromJson.add(s)
      return s
    })
  const settled = (s?: ControlStatus) => !!s && (s.state === 'running' || s.state === 'tripped' || isOldProtocol(s))
  const enabled = () => deps.readSettings().mffai.enabled

  const conn = createWorkerConnection({
    paths,
    connectWorker: deps.connectWorker ?? connectClient,
    clientVersion: deps.clientVersion,
    send: deps.send,
    status,
    now,
    sleep,
    log,
    onReset: () => { debugSession = undefined },
  })

  async function waitStatus(ms: number, done: (s?: ControlStatus) => boolean): Promise<ControlStatus | undefined> {
    const end = now() + ms
    for (;;) {
      const s = await status()
      if (done(s) || now() >= end) return s
      await sleep(POLL_MS)
    }
  }

  const waitGone = async (): Promise<void> => {
    if (await waitStatus(STOP_WAIT_MS, (x) => !x)) throw new Error('old mff-ai daemon did not stop')
  }

  /**
   * 旧协议的控制口不认我们:SIGTERM 旧监管(它体面退出;Windows 上是强杀)并等它消失。
   * 发信号前再读一次 supervisor.json、再确认 pid 活着,防 pid 被复用
   */
  async function stopOldDaemon(): Promise<void> {
    const j = oldDaemon()
    if (j) {
      try { kill(j.pid, 'SIGTERM') } catch (err) { log('mffai kill old daemon failed', err) }
    }
    await waitGone()
  }

  let spawnError: string | undefined
  const spawn = () => {
    mkdirSync(dir, { recursive: true })
    spawnError = undefined
    spawnDaemon({ execPath, daemonJs: deps.daemonJs, dataDir: dir, proxy: deps.readSettings().appProxy }, deps.spawnFn, (err) => {
      spawnError = err.message
      log('mffai spawn failed', err)
    })
  }

  // —— 串行操作队列:enable / disable / restart / resetTrip / 自启 一个接一个跑,互不穿插。
  //    与队尾同类且未结束的操作直接复用(ipc 与它触发的 onSettings 会各调一次)。
  let queue: Promise<unknown> = Promise.resolve()
  let last: { kind: string; p: Promise<void> } | undefined
  const serial = (kind: string, fn: () => Promise<void>): Promise<void> => {
    if (last?.kind === kind) return last.p
    const p = queue.then(fn, fn)
    const entry = { kind, p }
    last = entry
    queue = p.catch(() => undefined).finally(() => { if (last === entry) last = undefined })
    return p
  }

  /**
   * 后台不在就拉起,等到 running 后连上工作进程。
   * 正在 stopping(刚停用又启用)→ 等它退出(排空最多 30 s),退出后再拉起。
   * `stillWanted` 在拉起和连接前复查:已停用就不拉起,等待期间被停用就不连。
   */
  async function bringUp(waitMs: number, stillWanted: () => boolean = () => true): Promise<void> {
    const start = now()
    let end = start + waitMs
    let spawned = false
    let s = await status()
    while (!settled(s)) {
      if (!stillWanted()) break
      if (s?.state === 'stopping') end = Math.max(end, start + STOP_WAIT_MS)
      if (!s && !spawned) {
        spawn()
        spawned = true
        end = Math.max(end, now() + START_WAIT_MS)
      }
      if (now() >= end || !stillWanted()) break
      await sleep(POLL_MS)
      s = await status()
    }
    if (!stillWanted()) return
    if (isOldProtocol(s)) return conn.markIncompatible() // 旧后台:不跟旧协议说话,等用户点重启
    if (s?.state === 'tripped') return conn.tripped(s)
    if (s?.state !== 'running') throw new Error(`mff-ai daemon did not start${spawnError ? `: ${spawnError}` : ''}`)
    await conn.connect()
  }

  async function sendAutostart(on: boolean): Promise<void> {
    try {
      const r = await control('autostart', { on, spec })
      if (!r.ok) log(`mffai autostart: ${r.errors.join('; ')}`)
    } catch (err) {
      log('mffai autostart failed', err)
    }
  }

  const ensureRunning = (): Promise<void> => serial('ensure', () => bringUp(START_WAIT_MS, enabled))

  const enable = (): Promise<void> => serial('enable', async () => {
    if (!enabled()) return
    await bringUp(START_WAIT_MS, enabled)
    if (enabled()) await sendAutostart(deps.readSettings().mffai.autostart)
  })

  const disable = (): Promise<void> => serial('disable', async () => {
    conn.drop()
    // 旧协议后台撤销不了自启也收不到 shutdown:先停掉它,再按下面的常规路径临时拉起新后台撤销
    const old = await status()
    if (old && fromJson.has(old)) await stopOldDaemon()
    // 自启要靠后台撤销;后台不在(被手动杀过)就为此临时拉起一次
    if (!(await status()) && existsSync(dir)) {
      spawn()
      await waitStatus(START_WAIT_MS, (s) => !!s)
    }
    const s = await status()
    if (!s || s.state === 'stopping') return
    await sendAutostart(false)
    await control('shutdown').catch((err) => log('mffai shutdown failed', err))
  })

  // 已停用(设置里刚关掉)就什么都不做:绝不为此拉起后台
  const restart = (): Promise<void> => serial('restart', async () => {
    if (!enabled()) return
    const s = await status()
    if (!s) return bringUp(START_WAIT_MS, enabled)
    if (isOldProtocol(s) || conn.compatible() === false) {
      // 版本不兼容:整个旧后台停掉,换当前 app 带的新后台
      conn.drop()
      const accepted = await control('shutdown').then(() => true, () => false)
      await (accepted ? waitGone() : stopOldDaemon())
      conn.resetCompat()
      return bringUp(START_WAIT_MS, enabled)
    }
    await control('restart') // 失败就抛出,现有连接保持不动
    conn.drop()
    await bringUp(STOP_WAIT_MS, enabled)
  })

  const resetTrip = (): Promise<void> => serial('resetTrip', async () => {
    if (!enabled()) return
    await control('resetTrip')
    await bringUp(START_WAIT_MS, enabled)
  })

  const setAutostart = (on: boolean): Promise<void> => serial(`autostart:${on}`, async () => {
    if (enabled()) await sendAutostart(on)
  })
  const refreshAutostart = (): Promise<void> => serial('autostart:refresh', async () => {
    if (enabled()) await sendAutostart(deps.readSettings().mffai.autostart)
  })

  async function getState(): Promise<MffaiState> {
    const { enabled: on, autostart } = deps.readSettings().mffai
    const supervisor = await status()
    const worker = conn.current()
    // 重连窗口(30 s)过了而监管早已回到 running:页面每 3 s 轮询一次,借此再连上。
    // 有串行操作在跑(启用 / 重启…)时交给它,不兼容的后台不碰
    if (on && !worker && !last && supervisor?.state === 'running' && !isOldProtocol(supervisor) && conn.compatible() !== false) {
      void conn.connect().catch((err) => log('mffai reconnect failed', err))
    }
    const ws = worker ? await worker.call('status').catch(() => undefined) : undefined
    const rssMb = ws?.rssMb
    const pluginsActive = ws?.plugins.filter((p) => p.state === 'active').length
    return {
      enabled: on,
      autostart,
      running: !!worker,
      supervisor,
      compatible: isOldProtocol(supervisor) ? false : conn.compatible(),
      rssMb,
      pluginsActive,
      dataDir: dir,
    }
  }

  const requireWorker = (): MffaiClient => {
    const w = conn.current()
    if (!w) throw new Error('mff-ai not running')
    return w
  }

  return {
    getState,
    enable,
    disable,
    ensureRunning,
    restart,
    resetTrip,
    setAutostart,
    refreshAutostart,
    async tail(limit: number): Promise<WorkerResult<'events.tail'>> {
      return requireWorker().call('events.tail', { limit })
    },
    async prompt(text: string, model?: ModelRef, opts?: PromptOpts): Promise<WorkerResult<'session.prompt'>> {
      const w = requireWorker()
      const cwd = opts?.cwd ?? ''
      const approvalMode = opts?.approvalMode ?? 'ask'
      const key = JSON.stringify([model?.accountId, model?.modelId, cwd, approvalMode])
      if (debugSession?.key !== key) {
        const params = {
          commandId: randomUUID(),
          title: 'debug',
          ...(model ? { model: { accountId: model.accountId, modelId: model.modelId } } : {}),
          ...(cwd ? { cwd, approvalMode } : {}),
        }
        debugSession = { key, id: (await w.call('session.create', params)).sessionId }
      }
      return w.call('session.prompt', { commandId: randomUUID(), sessionId: debugSession.id, text })
    },
    approvalRespond: (approvalId: string, decision: ApprovalDecision) => requireWorker().call('approval.respond', { approvalId, decision }),
    rollback: (sessionId: string, turnId: string) => requireWorker().call('turn.rollback', { commandId: randomUUID(), sessionId, turnId }),
    // —— 模型 / 账号:原样转给工作进程。★参数可能带 apiKey,绝不写日志
    modelsCatalog: () => requireWorker().call('models.catalog', {}),
    modelsAccounts: () => requireWorker().call('models.accounts', {}),
    addAccount: (input: AddAccountInput) => requireWorker().call('models.addAccount', { ...input, commandId: randomUUID() }),
    removeAccount: (accountId: string) => requireWorker().call('models.removeAccount', { commandId: randomUUID(), accountId }),
    testAccount: (accountId: string) => requireWorker().call('models.testAccount', { accountId }),
    setDefault: (ref: ModelRef) => requireWorker().call('models.setDefault', { accountId: ref.accountId, modelId: ref.modelId }),
    quota: (accountId: string) => requireWorker().call('models.quota', { accountId }),
    /** 开始 ChatGPT 登录:用系统浏览器打开本机一次性地址(由后台 302 到授权页),只把 flowId 回给页面 */
    async chatgptBegin(open: OpenExternal): Promise<{ flowId: string }> {
      const { flowId, authUrl } = await requireWorker().call('auth.chatgpt.begin', {})
      const href = loginStartUrl(authUrl, flowId)
      if (!href) {
        await requireWorker().call('auth.chatgpt.cancel', { flowId }).catch(() => undefined)
        throw new Error('unexpected ChatGPT login URL')
      }
      open(href)
      return { flowId }
    },
    chatgptCancel: (flowId: string) => requireWorker().call('auth.chatgpt.cancel', { flowId }),
    /** 页面要打开的外链(用量链接):只放行 https://chatgpt.com/ */
    async openExternal(url: string, open: OpenExternal): Promise<void> {
      const href = allowedUrl(url, EXTERNAL_PREFIX)
      if (!href) throw new Error('URL not allowed')
      open(href)
    },
    /** app 退出:只断 RPC,不停后台 */
    disconnect(): void {
      conn.drop()
    },
  }
}

// —— 模块级单例:index.ts 的加载器先 init,再调下面这些 ——
let instance: MffaiHost | undefined
export function init(deps: HostDeps): void {
  instance ??= createMffaiHost(deps)
}
const h = (): MffaiHost => {
  if (!instance) throw new Error('mffai host not initialized')
  return instance
}
export const getState = () => h().getState()
export const enable = () => h().enable()
export const disable = () => h().disable()
export const ensureRunning = () => h().ensureRunning()
export const refreshAutostart = () => h().refreshAutostart()
export const restart = () => h().restart()
export const resetTrip = () => h().resetTrip()
export const setAutostart = (on: boolean) => h().setAutostart(on)
export const tail = (limit: number) => h().tail(limit)
export const prompt = (text: string, model?: ModelRef, opts?: PromptOpts) => h().prompt(text, model, opts)
export const approvalRespond = (approvalId: string, decision: ApprovalDecision) => h().approvalRespond(approvalId, decision)
export const rollback = (sessionId: string, turnId: string) => h().rollback(sessionId, turnId)
export const modelsCatalog = () => h().modelsCatalog()
export const modelsAccounts = () => h().modelsAccounts()
export const addAccount = (input: AddAccountInput) => h().addAccount(input)
export const removeAccount = (accountId: string) => h().removeAccount(accountId)
export const testAccount = (accountId: string) => h().testAccount(accountId)
export const setDefault = (ref: ModelRef) => h().setDefault(ref)
export const quota = (accountId: string) => h().quota(accountId)
export const chatgptBegin = (open: OpenExternal) => h().chatgptBegin(open)
export const chatgptCancel = (flowId: string) => h().chatgptCancel(flowId)
export const openExternal = (url: string, open: OpenExternal) => h().openExternal(url, open)
export const disconnect = (): void => instance?.disconnect()
