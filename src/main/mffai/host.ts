import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import {
  connectClient,
  connectControlClient,
  dataDir as defaultDataDir,
  runtimePaths,
  type ControlMethodName,
  type ControlParams,
  type ControlResult,
  type ControlStatus,
  type MffaiClient,
  type MffaiState,
  type WorkerResult,
} from '@mffai/protocol'
import { controlCall, type ConnectControl, type ConnectWorker } from './client'
import { createWorkerConnection, isOldProtocol } from './connection'
import { spawnDaemon, type SpawnFn } from './spawn'

// app 主进程里的 mff-ai 宿主。★只经 index.ts / ipc.ts 动态 import:未启用时永不加载。

export interface HostDeps {
  send(ch: string, payload: unknown): void
  readSettings(): { mffai: { enabled: boolean; autostart: boolean } }
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
}

const START_WAIT_MS = 10_000
const STOP_WAIT_MS = 35_000 // 排空最多 30 s
const POLL_MS = 200

export type MffaiHost = ReturnType<typeof createMffaiHost>

export function createMffaiHost(deps: HostDeps) {
  const dir = deps.dataDir ?? (process.env.MFFAI_DATA_DIR || defaultDataDir())
  const paths = runtimePaths(dir)
  const execPath = deps.execPath ?? process.execPath
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const log = deps.log ?? (() => {})
  const connectControl = deps.connectControl ?? connectControlClient
  const spec = { execPath, daemonJs: deps.daemonJs }

  let debugSession: string | undefined

  const control = <M extends ControlMethodName>(m: M, p?: ControlParams<M>): Promise<ControlResult<M>> =>
    controlCall(connectControl, paths, m, p)
  const status = (): Promise<ControlStatus | undefined> => control('status').catch(() => undefined)
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

  let spawnError: string | undefined
  const spawn = () => {
    mkdirSync(dir, { recursive: true })
    spawnError = undefined
    spawnDaemon({ execPath, daemonJs: deps.daemonJs, dataDir: dir }, deps.spawnFn, (err) => {
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
   * `stillWanted` 在连接前复查:等待期间被停用就不连。
   */
  async function bringUp(waitMs: number, stillWanted: () => boolean = () => true): Promise<void> {
    const start = now()
    let end = start + waitMs
    let spawned = false
    let s = await status()
    while (!settled(s)) {
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

  const restart = (): Promise<void> => serial('restart', async () => {
    const s = await status()
    if (!s) return bringUp(START_WAIT_MS)
    if (isOldProtocol(s) || conn.compatible() === false) {
      // 版本不兼容:整个旧后台停掉,换当前 app 带的新后台
      conn.drop()
      await control('shutdown').catch(() => undefined)
      if (await waitStatus(STOP_WAIT_MS, (x) => !x)) throw new Error('old mff-ai daemon did not stop')
      conn.resetCompat()
      return bringUp(START_WAIT_MS)
    }
    await control('restart') // 失败就抛出,现有连接保持不动
    conn.drop()
    await bringUp(STOP_WAIT_MS)
  })

  const resetTrip = (): Promise<void> => serial('resetTrip', async () => {
    await control('resetTrip')
    await bringUp(START_WAIT_MS)
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
    async prompt(text: string): Promise<WorkerResult<'session.prompt'>> {
      const w = requireWorker()
      debugSession ??= (await w.call('session.create', { commandId: randomUUID(), title: 'debug' })).sessionId
      return w.call('session.prompt', { commandId: randomUUID(), sessionId: debugSession, text })
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
export const prompt = (text: string) => h().prompt(text)
export const disconnect = (): void => instance?.disconnect()
