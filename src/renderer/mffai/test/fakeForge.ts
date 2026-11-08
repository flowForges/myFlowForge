// 渲染层测试的假 window.forge(08 全局约束):从不起后台。call 按脚本表回答,emit 驱动 onEvent,
// alert 驱动 onAlert,calls 记下每一次调用。失败按 preload 的样子拒绝成普通对象 {name, code, message, data}。
import { vi } from 'vitest'
import type { KernelEvent, MffaiAlert, MffaiState, WorkerMethodName, WorkerParams, WorkerResult } from '@mffai/protocol'

type Handler<M extends WorkerMethodName> =
  | WorkerResult<M>
  | ((params: WorkerParams<M>) => WorkerResult<M> | Promise<WorkerResult<M>>)
export type CallTable = { [M in WorkerMethodName]?: Handler<M> }

export const callError = (code: number, message = '', data?: unknown) =>
  ({ name: 'MffaiCallError' as const, code, message, ...(data !== undefined && { data }) })

/** 在脚本函数里用:按 preload 的形状失败 */
export function fail(code: number, message = '', data?: unknown): never { throw callError(code, message, data) }

export const RUNNING_STATE: MffaiState = {
  enabled: true, autostart: false, running: true, dataDir: '/fake/mff-ai',
  supervisor: { state: 'running', version: '0.1.0', restarts: 0, protocolVersion: 3 },
}

export interface FakeForge {
  forge: any
  mffai: any
  /** 每一次 call(method, params),按顺序 */
  calls: { method: string; params: unknown }[]
  callsOf(method: WorkerMethodName): unknown[]
  /** 合并进脚本表 */
  script(table: CallTable): void
  emit(e: KernelEvent): void
  alert(a: MffaiAlert): void
  setState(patch: Partial<MffaiState>): void
  listeners(): number
  alertListeners(): number
}

export function installFakeForge(opts: { state?: Partial<MffaiState>; calls?: CallTable } = {}): FakeForge {
  let state: MffaiState = { ...RUNNING_STATE, ...opts.state }
  const table: CallTable = { ...opts.calls }
  const calls: { method: string; params: unknown }[] = []
  const evs = new Set<(e: KernelEvent) => void>()
  const alerts = new Set<(a: MffaiAlert) => void>()
  const st = () => Promise.resolve(state)

  const mffai = {
    state: vi.fn(st),
    enable: vi.fn(st),
    disable: vi.fn(st),
    restart: vi.fn(st),
    resetTrip: vi.fn(st),
    setAutostart: vi.fn(st),
    tail: vi.fn(async () => ({ events: [] as KernelEvent[] })),
    prompt: vi.fn(async () => ({ accepted: true, turnId: 't1' })),
    approvalRespond: vi.fn(async () => ({ ok: true })),
    rollback: vi.fn(async () => ({ ok: true, files: 0 })),
    cancel: vi.fn(async () => ({ ok: true })),
    permissionsGet: vi.fn(),
    permissionsSet: vi.fn(),
    models: {
      catalog: vi.fn(async () => ({ presets: [], models: {} })),
      accounts: vi.fn(async () => ({ accounts: [], secretsBackend: 'keychain' })),
      addAccount: vi.fn(), removeAccount: vi.fn(), testAccount: vi.fn(), setDefault: vi.fn(),
      quota: vi.fn(async () => null),
    },
    chatgpt: { begin: vi.fn(), cancel: vi.fn() },
    openExternal: vi.fn(async () => {}),
    wipe: vi.fn(async () => ({ ok: true, removed: [] as string[] })),
    call: vi.fn(async (method: WorkerMethodName, params: unknown) => {
      calls.push({ method, params })
      const h = table[method] as unknown
      if (h === undefined) throw callError(-32601, 'method not found')
      return typeof h === 'function' ? await (h as (p: unknown) => unknown)(params) : structuredClone(h)
    }),
    onEvent: vi.fn((cb: (e: KernelEvent) => void) => { evs.add(cb); return () => { evs.delete(cb) } }),
    onAlert: vi.fn((cb: (a: MffaiAlert) => void) => { alerts.add(cb); return () => { alerts.delete(cb) } }),
  }
  const forge = { mffai, setSettings: vi.fn(async () => ({})), openExternal: vi.fn(async () => {}) }
  ;(window as any).forge = forge

  return {
    forge, mffai, calls,
    callsOf: (m) => calls.filter((c) => c.method === m).map((c) => c.params),
    script: (t) => Object.assign(table, t),
    emit: (e) => { for (const cb of [...evs]) cb(e) },
    alert: (a) => { for (const cb of [...alerts]) cb(a) },
    setState: (patch) => { state = { ...state, ...patch } },
    listeners: () => evs.size,
    alertListeners: () => alerts.size,
  }
}
