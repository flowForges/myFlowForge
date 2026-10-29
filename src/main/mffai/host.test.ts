import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PROTOCOL_VERSION, runtimePaths, type ControlStatus, type KernelEvent } from '@mffai/protocol'
import { createMffaiHost, type HostDeps } from './host'

const TOKEN = 'a'.repeat(64)

/** 假后台:控制口 + 工作进程两个口,全在内存里 */
function fakeDaemon(dir: string) {
  const d = {
    up: false,
    control: { state: 'running', restarts: 0, version: '0.1.0', protocolVersion: PROTOCOL_VERSION, pid: 4242 } as ControlStatus,
    workerUp: true,
    compatible: true,
    lastSeq: 5,
    controlCalls: [] as Array<[string, unknown]>,
    workerCalls: [] as Array<[string, unknown]>,
    workers: [] as Array<{ emit(e: KernelEvent): void; drop(): void }>,
    start() {
      d.up = true
      mkdirSync(dirname(runtimePaths(dir).token), { recursive: true })
      writeFileSync(runtimePaths(dir).token, TOKEN)
    },
  }
  const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })

  const connectControl = vi.fn(async (opts: { addr: string; token: string }) => {
    if (!d.up) throw refused()
    if (opts.token !== TOKEN) throw new Error('unauthorized')
    return {
      async call(method: string, params?: unknown) {
        d.controlCalls.push([method, params])
        if (!d.up) throw new Error('connection closed')
        switch (method) {
          case 'status': return { ...d.control }
          case 'shutdown': d.up = false; return { ok: true }
          case 'restart': d.control = { ...d.control, state: 'running' }; return { ok: true }
          case 'resetTrip': d.control = { ...d.control, state: 'running', trippedReason: undefined }; return { ok: true }
          case 'autostart': return { ok: true, errors: [] }
        }
        throw new Error(`unexpected ${method}`)
      },
      close() {},
    }
  })

  const connectWorker = vi.fn(async (opts: { addr: string; token: string }) => {
    if (!d.up || !d.workerUp) throw refused()
    if (opts.token !== TOKEN) throw new Error('unauthorized')
    const eventCbs = new Set<(e: KernelEvent) => void>()
    const closeCbs = new Set<() => void>()
    let closed = false
    const drop = () => {
      if (closed) return
      closed = true
      for (const cb of [...closeCbs]) cb()
    }
    d.workers.push({ emit: (e) => { for (const cb of eventCbs) cb(e) }, drop })
    return {
      async call(method: string, params?: any) {
        d.workerCalls.push([method, params])
        if (closed) throw new Error('connection closed')
        switch (method) {
          case 'hello': return { version: '0.1.0', protocolVersion: d.compatible ? PROTOCOL_VERSION : PROTOCOL_VERSION + 1, compatible: d.compatible }
          case 'snapshot': return { status: { state: 'running', uptimeMs: 1, rssMb: 51, version: '0.1.0', plugins: [] }, sessions: [], lastSeq: d.lastSeq }
          case 'status': return { state: 'running', uptimeMs: 1, rssMb: 51, version: '0.1.0', plugins: [] }
          case 'events.subscribe': return { ok: true }
          case 'events.tail': return { events: [] }
          case 'session.create': return { sessionId: 's1' }
          case 'session.prompt': return { accepted: true, turnId: 't1' }
        }
        throw new Error(`unexpected ${method}`)
      },
      onEvent(cb: (e: KernelEvent) => void) { eventCbs.add(cb); return () => void eventCbs.delete(cb) },
      onClose(cb: () => void) { closeCbs.add(cb); return () => void closeCbs.delete(cb) },
      close: drop,
    }
  })

  return { d, connectControl, connectWorker }
}

let dir: string
let clock: number
let settings: { mffai: { enabled: boolean; autostart: boolean } }

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'mffai-host-')), 'mff-ai')
  clock = 0
  settings = { mffai: { enabled: true, autostart: true } }
})
afterEach(() => rmSync(dirname(dir), { recursive: true, force: true }))

function setup(opts: { up?: boolean; startOnSpawn?: boolean } = {}) {
  const fake = fakeDaemon(dir)
  if (opts.up) fake.d.start()
  const sent: Array<[string, unknown]> = []
  const unref = vi.fn()
  const spawnFn = vi.fn((..._a: unknown[]) => {
    if (opts.startOnSpawn !== false) fake.d.start()
    return { unref }
  })
  const deps: HostDeps = {
    send: (ch, p) => { sent.push([ch, p]) },
    readSettings: () => settings,
    clientVersion: '9.9.9',
    daemonJs: '/app/out/main/mffaiDaemon.js',
    execPath: '/app/electron',
    dataDir: dir,
    spawnFn: spawnFn as unknown as HostDeps['spawnFn'],
    connectControl: fake.connectControl as unknown as HostDeps['connectControl'],
    connectWorker: fake.connectWorker as unknown as HostDeps['connectWorker'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; await new Promise((r) => setImmediate(r)) },
    log: () => {},
  }
  const host = createMffaiHost(deps)
  const alerts = () => sent.filter(([ch]) => ch === 'mffai:alert').map(([, p]) => p)
  const events = () => sent.filter(([ch]) => ch === 'mffai:event').map(([, p]) => p)
  return { ...fake, host, sent, alerts, events, spawnFn, unref }
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

describe('mffai host', () => {
  it('enable:建目录、detached 拉起一次、等 running、发自启、hello 并转发事件', async () => {
    const t = setup()
    await t.host.enable()

    expect(existsSync(dir)).toBe(true)
    expect(t.spawnFn).toHaveBeenCalledTimes(1)
    const [cmd, args, o] = t.spawnFn.mock.calls[0] as [string, string[], any]
    expect(cmd).toBe('/app/electron')
    expect(args).toEqual(['/app/out/main/mffaiDaemon.js'])
    expect(o.detached).toBe(true)
    expect(o.stdio).toBe('ignore')
    expect(o.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(o.env.MFFAI_DATA_DIR).toBe(dir)
    expect(t.unref).toHaveBeenCalledTimes(1)

    expect(t.d.controlCalls).toContainEqual(['autostart', { on: true, spec: { execPath: '/app/electron', daemonJs: '/app/out/main/mffaiDaemon.js' } }])
    expect(t.d.workerCalls[0]).toEqual(['hello', { clientVersion: '9.9.9', protocolVersion: PROTOCOL_VERSION }])
    expect(t.d.workerCalls).toContainEqual(['events.subscribe', { after: 5 }])

    const ev: KernelEvent = { seq: 6, ts: 1, type: 'turn.started', payload: {} }
    t.d.workers[0].emit(ev)
    expect(t.events()).toEqual([ev])

    const s = await t.host.getState()
    expect(s).toMatchObject({ enabled: true, autostart: true, running: true, compatible: true, rssMb: 51, dataDir: dir })
    expect(s.supervisor?.state).toBe('running')
    expect(t.alerts()).toEqual([])
  })

  it('并发 enable 只拉起一次', async () => {
    const t = setup()
    await Promise.all([t.host.enable(), t.host.enable(), t.host.ensureRunning()])
    expect(t.spawnFn).toHaveBeenCalledTimes(1)
    expect(t.connectWorker).toHaveBeenCalledTimes(1)
  })

  it('autostart 关时 enable 发 autostart {on:false}', async () => {
    settings = { mffai: { enabled: true, autostart: false } }
    const t = setup()
    await t.host.enable()
    expect(t.d.controlCalls.filter(([m]) => m === 'autostart').map(([, p]) => (p as any).on)).toEqual([false])
  })

  it('后台 10 s 内起不来 → enable 报错,不卡死', async () => {
    const t = setup({ startOnSpawn: false })
    await expect(t.host.enable()).rejects.toThrow(/did not start/)
    expect(clock).toBeGreaterThanOrEqual(10_000)
    expect(clock).toBeLessThan(11_000)
  })

  it('ensureRunning:控制口已 running 不拉起', async () => {
    const t = setup({ up: true })
    await t.host.ensureRunning()
    expect(t.spawnFn).not.toHaveBeenCalled()
    expect((await t.host.getState()).running).toBe(true)
  })

  it('hello 不兼容 → compatible:false + alert incompatible,不订阅', async () => {
    const t = setup({ up: true })
    t.d.compatible = false
    await t.host.ensureRunning()
    expect(t.alerts()).toEqual([{ kind: 'incompatible' }])
    expect(t.d.workerCalls.map(([m]) => m)).not.toContain('events.subscribe')
    const s = await t.host.getState()
    expect(s.compatible).toBe(false)
    expect(s.running).toBe(false)
  })

  it('app 升级后旧后台仍在(protocolVersion 不同)→ 不兼容 + 重启换新后台,不崩', async () => {
    const t = setup({ up: true })
    t.d.control = { ...t.d.control, protocolVersion: PROTOCOL_VERSION - 1, version: '0.0.1' }
    await expect(t.host.ensureRunning()).resolves.toBeUndefined()
    // 不跟旧协议的工作进程说话
    expect(t.connectWorker).not.toHaveBeenCalled()
    expect(t.alerts()).toEqual([{ kind: 'incompatible' }])
    expect(await t.host.getState()).toMatchObject({ running: false, compatible: false })

    // 重启:停掉旧后台 → 拉起当前 app 带的新后台
    t.spawnFn.mockImplementation(() => {
      t.d.control = { ...t.d.control, protocolVersion: PROTOCOL_VERSION, version: '0.1.0' }
      t.d.start()
      return { unref: t.unref }
    })
    const before = t.d.controlCalls.length
    await t.host.restart()
    expect(t.d.controlCalls.slice(before).map(([m]) => m)).toContain('shutdown')
    expect(t.spawnFn).toHaveBeenCalledTimes(1)
    expect(await t.host.getState()).toMatchObject({ running: true, compatible: true })
  })

  it('控制口 tripped → alert tripped(带原因),不拉起', async () => {
    const t = setup({ up: true })
    t.d.control = { ...t.d.control, state: 'tripped', trippedReason: 'crash-loop' }
    await t.host.ensureRunning()
    expect(t.alerts()).toEqual([{ kind: 'tripped', reason: 'crash-loop' }])
    expect(t.spawnFn).not.toHaveBeenCalled()
    expect(t.connectWorker).not.toHaveBeenCalled()

    await t.host.resetTrip()
    expect(t.d.controlCalls.map(([m]) => m)).toContain('resetTrip')
    expect((await t.host.getState()).running).toBe(true)
  })

  it('disable:撤销自启 + shutdown,数据目录保留', async () => {
    const t = setup()
    await t.host.enable()
    settings = { mffai: { enabled: false, autostart: true } }
    await t.host.disable()
    const calls = t.d.controlCalls.map(([m, p]) => (m === 'autostart' ? `autostart:${(p as any).on}` : m))
    expect(calls).toContain('autostart:false')
    expect(calls).toContain('shutdown')
    expect(calls.lastIndexOf('autostart:false')).toBeLessThan(calls.lastIndexOf('shutdown'))
    expect(existsSync(dir)).toBe(true)
    expect(t.d.up).toBe(false)
    expect((await t.host.getState()).running).toBe(false)
  })

  it('并发 disable 只 shutdown 一次,不为撤销自启再拉起', async () => {
    const t = setup({ up: true })
    await t.host.ensureRunning()
    await Promise.all([t.host.disable(), t.host.disable()])
    expect(t.d.controlCalls.filter(([m]) => m === 'shutdown')).toHaveLength(1)
    expect(t.spawnFn).not.toHaveBeenCalled()
  })

  it('后台不在时 disable 临时拉起一次只为撤销自启,随后 shutdown', async () => {
    mkdirSync(dir, { recursive: true })
    const t = setup()
    await t.host.disable()
    expect(t.spawnFn).toHaveBeenCalledTimes(1)
    expect(t.d.controlCalls.map(([m, p]) => (m === 'autostart' ? `autostart:${(p as any).on}` : m)).filter((m) => m !== 'status'))
      .toEqual(['autostart:false', 'shutdown'])
    expect(t.d.up).toBe(false)
  })

  it('工作进程断开 → running:false + alert restarting,随后自动重连', async () => {
    const t = setup()
    await t.host.enable()
    t.d.control = { ...t.d.control, state: 'restarting' }
    t.d.workerUp = false
    t.d.workers[0].drop()
    await flush()
    expect(t.alerts()).toEqual([{ kind: 'restarting' }])
    expect((await t.host.getState()).running).toBe(false)

    t.d.control = { ...t.d.control, state: 'running' }
    t.d.workerUp = true
    await vi.waitFor(() => expect(t.connectWorker).toHaveBeenCalledTimes(2))
    await flush()
    expect((await t.host.getState()).running).toBe(true)
    // 断线补齐:从最后见到的 seq 续订
    expect(t.d.workerCalls.filter(([m]) => m === 'events.subscribe').map(([, p]) => p)).toEqual([{ after: 5 }, { after: 5 }])
  })

  it('断开期间熔断 → alert tripped,停止重连', async () => {
    const t = setup()
    await t.host.enable()
    t.d.control = { ...t.d.control, state: 'tripped', trippedReason: 'oom' }
    t.d.workerUp = false
    t.d.workers[0].drop()
    await vi.waitFor(() => expect(t.alerts()).toEqual([{ kind: 'restarting' }, { kind: 'tripped', reason: 'oom' }]))
    expect(t.connectWorker).toHaveBeenCalledTimes(1)
  })

  it('disconnect 只断连接,不 shutdown,也不触发 restarting', async () => {
    const t = setup()
    await t.host.enable()
    t.host.disconnect()
    await flush()
    expect(t.d.controlCalls.map(([m]) => m)).not.toContain('shutdown')
    expect(t.alerts()).toEqual([])
    expect(t.d.up).toBe(true)
  })

  it('后台不在时 getState 不抛', async () => {
    const t = setup()
    expect(await t.host.getState()).toMatchObject({ enabled: true, running: false, dataDir: dir })
  })

  it('prompt:首次建调试会话,之后复用;tail 透传', async () => {
    const t = setup({ up: true })
    await t.host.ensureRunning()
    expect(await t.host.prompt('hi')).toEqual({ accepted: true, turnId: 't1' })
    await t.host.prompt('again')
    const methods = t.d.workerCalls.map(([m]) => m)
    expect(methods.filter((m) => m === 'session.create')).toHaveLength(1)
    const prompts = t.d.workerCalls.filter(([m]) => m === 'session.prompt').map(([, p]) => p as any)
    expect(prompts.map((p) => [p.sessionId, p.text])).toEqual([['s1', 'hi'], ['s1', 'again']])
    expect(new Set(prompts.map((p) => p.commandId)).size).toBe(2)
    expect(await t.host.tail(10)).toEqual({ events: [] })
    expect(t.d.workerCalls).toContainEqual(['events.tail', { limit: 10 }])
  })

  it('setAutostart / refreshAutostart 经控制口下发', async () => {
    const t = setup({ up: true })
    await t.host.setAutostart(false)
    await t.host.refreshAutostart()
    const on = t.d.controlCalls.filter(([m]) => m === 'autostart').map(([, p]) => (p as any).on)
    expect(on).toEqual([false, true])
  })

  it('未启用时 setAutostart 不拉起后台', async () => {
    settings = { mffai: { enabled: false, autostart: true } }
    const t = setup()
    await t.host.setAutostart(false)
    expect(t.spawnFn).not.toHaveBeenCalled()
  })
})
