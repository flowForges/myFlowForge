import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import type { ControlStatus } from '../protocol/index'
import { connectControlClient, runtimePaths } from '../protocol/index'
import { Supervisor } from './supervisor'

const FAKE = resolve(__dirname, '../../test/fixtures/fakeWorker.mjs')
const DAEMON_TS = resolve(__dirname, '../entry/daemon.ts')

let dir: string
let sups: Supervisor[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mffai-sup-'))
  sups = []
})
afterEach(async () => {
  for (const s of sups) await s.shutdown().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

const waitFor = async (fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 10))
  expect(fn()).toBe(true)
}
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

function make(mode: string, extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) {
  const delays: number[] = []
  const states: ControlStatus[] = []
  const sup = new Supervisor({
    workerCmd: process.execPath,
    workerArgs: [FAKE],
    env: { ...process.env, FAKE_MODE: mode, FAKE_MARKER: join(dir, 'marker'), FAKE_LOG: join(dir, 'fake.log') },
    pingMs: 50,
    delayFn: async (ms) => { delays.push(ms) },
    onState: s => states.push(s),
    ...extra,
  })
  sups.push(sup)
  return { sup, delays, states }
}
const fakeLog = () => (existsSync(join(dir, 'fake.log')) ? readFileSync(join(dir, 'fake.log'), 'utf8') : '')

describe('Supervisor', () => {
  it('ready -> running with a worker pid', async () => {
    const { sup, states } = make('ready')
    await sup.start()
    await waitFor(() => sup.state().state === 'running')
    const s = sup.state()
    expect(s.workerPid).toBeGreaterThan(0)
    expect(s.restarts).toBe(0)
    expect(s.protocolVersion).toBe(1)
    expect(states.map(x => x.state)).toContain('starting')
    // 能回 pong 就不会被当成卡死
    await new Promise(r => setTimeout(r, 300))
    expect(sup.state()).toMatchObject({ state: 'running', workerPid: s.workerPid, restarts: 0 })
  })

  it('crash-once -> restarted after a 1 s backoff', async () => {
    const { sup, delays } = make('crash-once')
    await sup.start()
    await waitFor(() => sup.state().state === 'running')
    expect(delays).toEqual([1000])
    expect(sup.state().restarts).toBe(1)
  })

  it('hang -> killed after 3 missed pings and restarted', async () => {
    const { sup } = make('hang')
    await sup.start()
    await waitFor(() => sup.state().state === 'running')
    const first = sup.state().workerPid!
    await waitFor(() => sup.state().restarts >= 1 && sup.state().workerPid !== first)
    await waitFor(() => !alive(first))
  })

  it('no ready within startupMs -> killed and restarted (pongs alone are not enough)', async () => {
    const { sup } = make('no-ready', { startupMs: 300 })
    await sup.start()
    await waitFor(() => sup.state().workerPid !== undefined)
    const first = sup.state().workerPid!
    await waitFor(() => sup.state().restarts >= 1 && sup.state().workerPid !== first)
    expect(sup.state().state).toBe('restarting')
    expect(alive(first)).toBe(false)
  })

  it('crash-always -> tripped with crash-loop, no more restarts', async () => {
    const { sup, delays } = make('crash-always')
    await sup.start()
    await waitFor(() => sup.state().state === 'tripped')
    expect(sup.state().trippedReason).toBe('crash-loop')
    expect(sup.state().workerPid).toBeUndefined()
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000])
    const restarts = sup.state().restarts
    await new Promise(r => setTimeout(r, 200))
    expect(sup.state()).toMatchObject({ state: 'tripped', restarts })
  })

  it('resetTrip clears history and starts a worker again', async () => {
    const { sup } = make('crash-always')
    await sup.start()
    await waitFor(() => sup.state().state === 'tripped')
    sup.resetTrip()
    expect(sup.state().state).toBe('starting')
    expect(sup.state().trippedReason).toBeUndefined()
    await waitFor(() => sup.state().state === 'tripped')
  })

  it('restart from tripped clears failure history (needs 10 new failures to trip again)', async () => {
    const { sup, delays } = make('crash-always')
    await sup.start()
    await waitFor(() => sup.state().state === 'tripped')
    await sup.restart()
    await waitFor(() => sup.state().state === 'tripped')
    expect(delays).toHaveLength(18)
    expect(delays.slice(9, 10)).toEqual([1000])
  })

  it('startup timeout uses the injected clock', async () => {
    const { sup } = make('no-ready', { startupMs: 100, now: () => 0 })
    await sup.start()
    await waitFor(() => sup.state().workerPid !== undefined)
    const pid = sup.state().workerPid
    await new Promise(r => setTimeout(r, 400))
    expect(sup.state()).toMatchObject({ workerPid: pid, restarts: 0 })
  })

  it('restart drains the current worker and spawns a fresh one', async () => {
    const { sup } = make('ready')
    await sup.start()
    await waitFor(() => sup.state().state === 'running')
    const first = sup.state().workerPid!
    await sup.restart()
    await waitFor(() => sup.state().state === 'running')
    expect(sup.state().workerPid).not.toBe(first)
    expect(sup.state().restarts).toBe(1)
    expect(fakeLog()).toContain(`${first} drain`)
    expect(alive(first)).toBe(false)
  })

  it('shutdown with slow-drain -> worker gets drain, killed after drainMs', async () => {
    const { sup } = make('slow-drain', { drainMs: 300 })
    await sup.start()
    await waitFor(() => sup.state().state === 'running')
    const pid = sup.state().workerPid!
    const t0 = Date.now()
    await sup.shutdown()
    const took = Date.now() - t0
    expect(fakeLog()).toContain(`${pid} drain`)
    expect(took).toBeGreaterThanOrEqual(280)
    expect(took).toBeLessThan(5000)
    expect(alive(pid)).toBe(false)
    expect(sup.state().state).toBe('stopping')
    expect(sup.state().workerPid).toBeUndefined()
  })

  it('shutdown with a well-behaved worker returns as soon as it exits', async () => {
    const { sup } = make('ready', { drainMs: 10_000 })
    await sup.start()
    await waitFor(() => sup.state().state === 'running')
    const t0 = Date.now()
    await sup.shutdown()
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})

// 真实入口:打成 CJS(同 Task 10 的产物形态),两个监管进程同时启动
describe('daemon entry', () => {
  let bundle: string
  // 断言失败也要收尸:监管进程、它们的工作进程
  const procs: ChildProcess[] = []
  const pids: number[] = []
  let home: string
  // 真实守护进程的环境:HOME 等全指向临时目录,自启走演练模式
  const daemonEnv = (): NodeJS.ProcessEnv => ({
    ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    MFFAI_DATA_DIR: dir, MFFAI_AUTOSTART_DRY_RUN: '1',
  })
  const killTree = (p: ChildProcess) => {
    try { if (p.pid) process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch { /* 已退出 */ } }
  }
  const sweep = () => { for (const p of procs) killTree(p) }
  beforeAll(() => { process.on('exit', sweep) })
  afterAll(() => { process.off('exit', sweep) })
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mffai-home-')) })
  beforeAll(async () => {
    bundle = join(mkdtempSync(join(tmpdir(), 'mffai-bundle-')), 'mffaiDaemon.js')
    await build({ entryPoints: [DAEMON_TS], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  })
  afterEach(() => {
    const json = join(runtimePaths(dir).supervisorJson)
    try { pids.push(JSON.parse(readFileSync(json, 'utf8')).workerPid) } catch { /* 没有 */ }
    for (const p of procs.splice(0)) killTree(p)
    rmSync(home, { recursive: true, force: true })
    for (const pid of pids.splice(0)) if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
  })
  afterAll(() => rmSync(dirname(bundle), { recursive: true, force: true }))

  it.skipIf(process.platform === 'win32')('drain during worker startup -> waits for startup, exits 0 without ready', async () => {
    // 残留 socket(没人听)让启动走一次异步的探测 + 50 ms 复查,drain 必然落在启动中途
    const { workerAddr, logs } = runtimePaths(dir)
    if (process.platform !== 'win32') {
      mkdirSync(dirname(workerAddr), { recursive: true })
      execFileSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(workerAddr)}, () => process.exit(0))`])
    }
    const w = spawn(process.execPath, [bundle, '--worker'], {
      env: daemonEnv(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: true,
    })
    procs.push(w)
    const msgs: string[] = []
    w.on('message', (m: { t: string }) => msgs.push(m.t))
    w.send({ t: 'drain' })
    const code = await new Promise<number | null>(r => w.once('exit', c => r(c)))
    expect(code).toBe(0)
    expect(msgs).not.toContain('ready')
    const log = readdirSync(logs).filter(f => f.startsWith('worker-')).map(f => readFileSync(join(logs, f), 'utf8')).join('')
    expect(log).toContain('"why":"drain"')
    expect(log).not.toContain('failed')
  })

  it('two concurrent launches -> exactly one supervisor survives, the other exits 0', async () => {
    const env = { ...daemonEnv(), ELECTRON_RUN_AS_NODE: '1' }
    const launch = () => {
      const p = spawn(process.execPath, [bundle], { env, stdio: 'ignore', detached: true })
      procs.push(p)
      const exited = new Promise<number | null>(r => p.once('exit', code => r(code)))
      return { p, exited }
    }
    const a = launch()
    const b = launch()
    const first = await Promise.race([a.exited.then(c => ({ who: a, c })), b.exited.then(c => ({ who: b, c }))])
    expect(first.c).toBe(0)
    const survivor = first.who === a ? b : a
    expect(survivor.p.exitCode).toBeNull()

    const paths = runtimePaths(dir)
    const token = readFileSync(paths.token, 'utf8').trim()
    let status: ControlStatus | undefined
    await waitFor(() => existsSync(paths.supervisorJson))
    for (let i = 0; i < 200; i++) {
      const c = await connectControlClient({ addr: paths.controlAddr, token }).catch(() => undefined)
      status = await c?.call('status').catch(() => undefined)
      c?.close()
      if (status?.state === 'running') break
      await new Promise(r => setTimeout(r, 50))
    }
    if (status?.workerPid) pids.push(status.workerPid)
    expect(status).toMatchObject({ state: 'running', restarts: 0, protocolVersion: 1, pid: survivor.p.pid })
    const json = JSON.parse(readFileSync(paths.supervisorJson, 'utf8'))
    expect(json).toMatchObject({ pid: survivor.p.pid, workerPid: status!.workerPid, state: 'running', protocolVersion: 1 })
    expect(existsSync(join(paths.logs))).toBe(true)

    // 第三次启动(探测到已有实例)也直接退出 0
    expect(await launch().exited).toBe(0)

    const c = await connectControlClient({ addr: paths.controlAddr, token })
    // autostart 的真实行为在 controlServer.test(注入 exec);此处只校验参数校验仍生效,绝不触碰真实系统
    expect(await c.call('autostart', { on: 'yes' } as never).catch(e => e.code)).toBe(-32602)
    // 演练模式下合法请求只出计划:不执行命令,连临时 home 也不写
    expect(await c.call('autostart', { on: true, spec: { execPath: process.execPath, daemonJs: bundle } })).toMatchObject({ ok: true })
    expect(existsSync(join(home, 'Library/LaunchAgents/com.myflowforge.mffai.plist'))).toBe(false)
    expect(existsSync(join(home, '.config'))).toBe(false)
    expect(await c.call('shutdown')).toEqual({ ok: true })
    c.close()
    expect(await survivor.exited).toBe(0)
    expect(existsSync(paths.supervisorJson)).toBe(false)
    expect(alive(status!.workerPid!)).toBe(false)
  }, 30_000)
})
