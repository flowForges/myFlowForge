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
    drainPolls: 0, // shutdown 后还要答几次 stopping 才真正退出
    failRestart: false,
    sessions: 0,
    authUrl: 'http://127.0.0.1:1455/auth/start?flow=f1',
    onRestart: undefined as undefined | (() => void),
    controlCalls: [] as Array<[string, unknown]>,
    workerCalls: [] as Array<[string, unknown]>,
    workers: [] as Array<{ emit(e: KernelEvent): void; drop(): void }>,
    start() {
      d.up = true
      d.control = { ...d.control, state: 'running' }
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
          case 'status': {
            const s = { ...d.control }
            if (s.state === 'stopping' && --d.drainPolls <= 0) d.up = false
            return s
          }
          case 'shutdown':
            if (d.drainPolls > 0) d.control = { ...d.control, state: 'stopping' }
            else d.up = false
            return { ok: true }
          case 'restart':
            if (d.failRestart) throw new Error('timeout')
            if (d.onRestart) { d.onRestart(); return { ok: true } }
            d.control = { ...d.control, state: 'running' }; return { ok: true }
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
          case 'status': return { state: 'running', uptimeMs: 1, rssMb: 51, version: '0.1.0', plugins: [{ id: 'a', state: 'active' }, { id: 'b', state: 'failed' }] }
          case 'events.subscribe': return { ok: true }
          case 'events.tail': return { events: [] }
          case 'session.create': return { sessionId: `s${++d.sessions}` }
          case 'models.catalog': return { presets: [], models: {} }
          case 'models.accounts': return { accounts: [], secretsBackend: 'keychain' }
          case 'models.addAccount': return { id: 'acc1', presetId: params.presetId, label: 'x', state: 'ok' }
          case 'models.removeAccount': return { ok: true }
          case 'models.testAccount': return { ok: true }
          case 'models.setDefault': return { ok: true }
          case 'models.quota': return { link: 'https://chatgpt.com/codex/settings/usage' }
          case 'auth.chatgpt.begin': return { flowId: 'f1', authUrl: d.authUrl }
          case 'auth.chatgpt.cancel': return { ok: true }
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
  const logs: string[] = []
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
    log: (m, e) => { logs.push(e === undefined ? m : `${m}: ${e instanceof Error ? e.message : String(e)}`) },
  }
  const host = createMffaiHost(deps)
  const alerts = () => sent.filter(([ch]) => ch === 'mffai:alert').map(([, p]) => p)
  const events = () => sent.filter(([ch]) => ch === 'mffai:event').map(([, p]) => p)
  return { ...fake, host, sent, logs, alerts, events, spawnFn, unref }
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
    expect(s).toMatchObject({ enabled: true, autostart: true, running: true, compatible: true, rssMb: 51, pluginsActive: 1, dataDir: dir })
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

  it('拉起报错(ENOENT)→ 记日志,enable 的报错带上原因', async () => {
    const t = setup({ startOnSpawn: false })
    t.spawnFn.mockImplementation(() => ({
      unref: t.unref,
      on: (_ev: string, cb: (e: Error) => void) => setImmediate(() => cb(new Error('spawn /app/electron ENOENT'))),
    }) as never)
    await expect(t.host.enable()).rejects.toThrow(/ENOENT/)
    expect(t.logs.some((l) => l.includes('ENOENT'))).toBe(true)
  })

  it('停用后马上又启用(旧后台还在排空)→ 等它退出再拉起,最终 running', async () => {
    const t = setup({ up: true })
    await t.host.ensureRunning()
    t.d.drainPolls = 5
    settings = { mffai: { enabled: false, autostart: true } }
    const off = t.host.disable()
    settings = { mffai: { enabled: true, autostart: true } }
    const on = t.host.enable()
    await Promise.all([off, on])
    expect(t.spawnFn).toHaveBeenCalledTimes(1)
    expect(await t.host.getState()).toMatchObject({ running: true, compatible: true })
    expect(t.alerts()).toEqual([])
  })

  it('启用进行中被停用 → 不连接,最后发的是 autostart:false,无 restarting', async () => {
    const t = setup({ startOnSpawn: false })
    const on = t.host.enable()
    await flush() // 只走微任务:假 sleep 要等宏任务,启用停在「等 running」里
    expect(t.spawnFn).toHaveBeenCalledTimes(1)
    // 后台此刻才起来,同时用户已经关掉
    settings = { mffai: { enabled: false, autostart: true } }
    t.d.start()
    const off = t.host.disable()
    await Promise.all([on, off])
    await flush()
    expect(t.connectWorker).not.toHaveBeenCalled()
    const auto = t.d.controlCalls.filter(([m]) => m === 'autostart').map(([, p]) => (p as any).on)
    expect(auto).toEqual([false])
    expect(t.d.controlCalls.map(([m]) => m).filter((m) => m !== 'status')).toEqual(['autostart', 'shutdown'])
    expect(t.alerts()).toEqual([])
    expect((await t.host.getState()).running).toBe(false)
  })

  it('兼容时 restart 失败 → 抛出且原连接保留', async () => {
    const t = setup({ up: true })
    await t.host.ensureRunning()
    t.d.failRestart = true
    await expect(t.host.restart()).rejects.toThrow(/timeout/)
    expect((await t.host.getState()).running).toBe(true)
    expect(t.alerts()).toEqual([])
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

  it('重连窗口过后监管才回到 running → 页面轮询 getState 时重新连上', async () => {
    const t = setup()
    await t.host.enable()
    t.d.control = { ...t.d.control, state: 'restarting' }
    t.d.workerUp = false
    t.d.workers[0].drop()
    // 重连循环 30 s 后放弃(退避可能超过 30 s)
    await vi.waitFor(() => expect(clock).toBeGreaterThanOrEqual(30_000))
    await flush()
    expect(t.connectWorker).toHaveBeenCalledTimes(1)

    t.d.control = { ...t.d.control, state: 'running' }
    t.d.workerUp = true
    expect((await t.host.getState()).running).toBe(false)
    await vi.waitFor(() => expect(t.connectWorker).toHaveBeenCalledTimes(2))
    await vi.waitFor(async () => expect((await t.host.getState()).running).toBe(true))
    expect(t.connectWorker).toHaveBeenCalledTimes(2)
    expect(t.spawnFn).toHaveBeenCalledTimes(1)
  })

  it('getState 不替不兼容 / 未启用的后台重连', async () => {
    const t = setup({ up: true })
    t.d.compatible = false
    await t.host.ensureRunning()
    await t.host.getState()
    await flush()
    expect(t.connectWorker).toHaveBeenCalledTimes(1)

    settings = { mffai: { enabled: false, autostart: true } }
    const t2 = setup({ up: true })
    await t2.host.getState()
    await flush()
    expect(t2.connectWorker).not.toHaveBeenCalled()
  })

  it('已停用时 restart / resetTrip 不拉起后台、不发控制命令', async () => {
    settings = { mffai: { enabled: false, autostart: true } }
    const t = setup()
    await t.host.restart()
    await t.host.resetTrip()
    expect(t.spawnFn).not.toHaveBeenCalled()
    expect(t.d.controlCalls).toEqual([])
    expect(t.connectWorker).not.toHaveBeenCalled()
  })

  it('restart 途中被停用、后台随之消失 → 不再拉起', async () => {
    const t = setup({ up: true })
    await t.host.ensureRunning()
    t.d.onRestart = () => {
      t.d.up = false
      settings = { mffai: { enabled: false, autostart: true } }
    }
    await t.host.restart()
    expect(t.spawnFn).not.toHaveBeenCalled()
    expect((await t.host.getState()).running).toBe(false)
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

  it('prompt 带模型:按选择建会话(带 model),同一选择复用,换选择新建', async () => {
    const t = setup({ up: true })
    await t.host.ensureRunning()
    const a = { accountId: 'acc1', modelId: 'gpt-5' }
    await t.host.prompt('1', a)
    await t.host.prompt('2', { ...a })
    await t.host.prompt('3', { accountId: 'acc1', modelId: 'gpt-5-mini' })
    await t.host.prompt('4')
    const creates = t.d.workerCalls.filter(([m]) => m === 'session.create').map(([, p]) => p as any)
    expect(creates.map((p) => p.model)).toEqual([a, { accountId: 'acc1', modelId: 'gpt-5-mini' }, undefined])
    const prompts = t.d.workerCalls.filter(([m]) => m === 'session.prompt').map(([, p]) => (p as any).sessionId)
    expect(prompts).toEqual(['s1', 's1', 's2', 's3'])
  })

  it('models.* 透传给工作进程;addAccount 原样带 apiKey / restrictionAck 并生成 commandId', async () => {
    const t = setup({ up: true })
    await t.host.ensureRunning()
    expect(await t.host.modelsCatalog()).toEqual({ presets: [], models: {} })
    expect(await t.host.modelsAccounts()).toEqual({ accounts: [], secretsBackend: 'keychain' })
    const input = { presetId: 'kimi-coding', label: 'k', apiKey: 'sk-secret', baseUrl: 'https://x', protocol: 'anthropic' as const, restrictionAck: true }
    expect(await t.host.addAccount(input)).toMatchObject({ id: 'acc1' })
    await t.host.removeAccount('acc1')
    await t.host.removeAccount('acc1')
    expect(await t.host.testAccount('acc1')).toEqual({ ok: true })
    await t.host.setDefault({ accountId: 'acc1', modelId: 'm' })
    expect(await t.host.quota('acc1')).toEqual({ link: 'https://chatgpt.com/codex/settings/usage' })
    const call = (m: string) => t.d.workerCalls.filter(([x]) => x === m).map(([, p]) => p as any)
    const [add] = call('models.addAccount')
    expect(add).toEqual({ ...input, commandId: expect.any(String) })
    const removes = call('models.removeAccount')
    expect(removes.map((p) => p.accountId)).toEqual(['acc1', 'acc1'])
    expect(new Set([add.commandId, ...removes.map((p) => p.commandId)]).size).toBe(3)
    expect(call('models.testAccount')).toEqual([{ accountId: 'acc1' }])
    expect(call('models.setDefault')).toEqual([{ accountId: 'acc1', modelId: 'm' }])
    expect(call('models.quota')).toEqual([{ accountId: 'acc1' }])
    expect(t.logs.join('\n')).not.toContain('sk-secret')
  })

  it('chatgptBegin:只打开本机一次性 /auth/start?flow=<flowId>(规范化后),回给页面的只有 flowId', async () => {
    const t = setup({ up: true })
    await t.host.ensureRunning()
    const open = vi.fn()
    const cancels = () => t.d.workerCalls.filter(([m]) => m === 'auth.chatgpt.cancel')
    expect(await t.host.chatgptBegin(open)).toEqual({ flowId: 'f1' })
    expect(open).toHaveBeenCalledWith('http://127.0.0.1:1455/auth/start?flow=f1')
    // 打开的是规范化后的 href,不是原始字符串
    t.d.authUrl = 'HTTP://127.0.0.1:01455/auth/start?flow=f1'
    open.mockClear()
    await t.host.chatgptBegin(open)
    expect(open).toHaveBeenCalledWith('http://127.0.0.1:1455/auth/start?flow=f1')
    expect(cancels()).toEqual([])
    for (const bad of [
      'https://auth.openai.com/api/accounts/authorize?id_token_hint=x', 'https://evil.com/?http://127.0.0.1:1455/auth/start?flow=f1',
      'http://localhost:1455/auth/start?flow=f1', 'http://127.0.0.1/auth/start?flow=f1', 'https://127.0.0.1:1455/auth/start?flow=f1',
      'http://127.0.0.1:1455/auth/callback?flow=f1', 'http://127.0.0.1:1455/auth/start?flow=f2', 'http://127.0.0.1:1455/auth/start?flow=f1&id_token_hint=x',
      'http://u@127.0.0.1:1455/auth/start?flow=f1', 'http://127.0.0.1.evil.com:1455/auth/start?flow=f1', 'not a url',
    ]) {
      t.d.authUrl = bad
      open.mockClear()
      const before = cancels().length
      await expect(t.host.chatgptBegin(open)).rejects.toThrow()
      expect(open).not.toHaveBeenCalled()
      // 地址不对:流程被取消,回环监听不会一直挂着
      expect(cancels().length).toBe(before + 1)
      expect(cancels().at(-1)).toEqual(['auth.chatgpt.cancel', { flowId: 'f1' }])
    }
    await t.host.chatgptCancel('f1')
    expect(t.d.workerCalls.at(-1)).toEqual(['auth.chatgpt.cancel', { flowId: 'f1' }])
  })

  it('openExternal:只放行 https://chatgpt.com/ 开头的地址', async () => {
    const t = setup()
    const open = vi.fn()
    await t.host.openExternal('https://chatgpt.com/codex/settings/usage', open)
    expect(open).toHaveBeenCalledWith('https://chatgpt.com/codex/settings/usage')
    await t.host.openExternal('https://chatgpt.com/codex/../settings/usage', open)
    expect(open).toHaveBeenLastCalledWith('https://chatgpt.com/settings/usage')
    for (const bad of ['http://chatgpt.com/', 'https://chatgpt.com.evil.com/', 'https://chatgpt.com@evil.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://chatgpt.com', 42]) {
      await expect(t.host.openExternal(bad as string, open)).rejects.toThrow()
    }
    expect(open).toHaveBeenCalledTimes(2)
  })
})
