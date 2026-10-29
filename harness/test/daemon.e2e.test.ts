import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream } from '@agentclientprotocol/sdk'
import { PROTOCOL_VERSION, connectClient, connectControlClient, runtimePaths } from '../src/protocol/index'

// 构建产物端到端:MFFAI_E2E=1 且已 `npm run build`。环境全部封在临时目录里。
const E2E = process.env.MFFAI_E2E === '1'
const OUT = resolve(__dirname, '../../out/main')
const DAEMON = join(OUT, 'mffaiDaemon.js')
const ACP = join(OUT, 'mffaiAcp.js')

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const waitFor = async (fn: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(50) }
  throw new Error(`timeout: ${what}`)
}

describe.skipIf(!E2E)('built daemon e2e', () => {
  const procs: ChildProcess[] = []
  const pids: number[] = []
  const temps: string[] = []
  const killTree = (p: ChildProcess) => {
    try { if (p.pid) process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch { /* 已退出 */ } }
  }
  const sweep = () => { for (const p of procs) killTree(p) }
  beforeAll(() => { process.on('exit', sweep) })
  afterAll(() => { process.off('exit', sweep) })
  afterEach(() => {
    for (const p of procs.splice(0)) killTree(p)
    for (const pid of pids.splice(0)) if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true })
  })

  it('supervisor + worker + ACP bridge work from the built bundles', async () => {
    expect(existsSync(DAEMON) && existsSync(ACP)).toBe(true)
    const electron = process.env.ELECTRON_BIN ?? (createRequire(import.meta.url)('electron') as string)
    const home = mkdtempSync(join(tmpdir(), 'mffai-e2e-home-'))
    const data = mkdtempSync(join(tmpdir(), 'mffai-e2e-data-'))
    temps.push(home, data)
    const env: NodeJS.ProcessEnv = {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'), MFFAI_DATA_DIR: data, MFFAI_AUTOSTART_DRY_RUN: '1',
    }
    const paths = runtimePaths(data)
    const sup = spawn(electron, [DAEMON], { env, stdio: 'ignore', detached: true })
    procs.push(sup)
    const supExited = new Promise<void>(r => sup.once('exit', () => r()))

    const tokenOf = () => readFileSync(paths.token, 'utf8').trim()
    const ctl = async () => connectControlClient({ addr: paths.controlAddr, token: tokenOf() })
    let workerPid = 0
    await waitFor(async () => {
      try {
        const c = await ctl()
        try { const s = await c.call('status'); workerPid = s.workerPid ?? 0; return s.state === 'running' } finally { c.close() }
      } catch { return false }
    }, 10_000, 'control status running')
    pids.push(sup.pid!, workerPid)

    const w = await connectClient({ addr: paths.workerAddr, token: tokenOf(), timeoutMs: 3000 })
    try {
      const hello = await w.call('hello', { clientVersion: '0.0.0', protocolVersion: PROTOCOL_VERSION })
      expect(hello.compatible).toBe(true)
      const texts: string[] = []
      w.onEvent(e => { if (e.type === 'message.assistant') texts.push(JSON.stringify(e.payload)) })
      await w.call('events.subscribe', { after: 0 })
      const { sessionId } = await w.call('session.create', { commandId: 'e2e-create' })
      await w.call('session.prompt', { commandId: 'e2e-prompt', sessionId, text: 'hi' })
      await waitFor(() => texts.some(t => t.includes('echo: hi')), 5000, 'echo: hi')

      const st = await w.call('status')
      const supKb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(sup.pid)]).toString().trim())
      process.stderr.write(`MFFAI_RSS supervisor=${Math.round(supKb / 1024)} worker=${Math.round(st.rssMb)}\n`)
    } finally { w.close() }

    // ACP 转接器:经 stdio 用 SDK 客户端跑一轮
    const acp = spawn(electron, [ACP], { env, stdio: ['pipe', 'pipe', 'inherit'], detached: true })
    procs.push(acp)
    const chunks: string[] = []
    const stop = await client({ name: 'e2e' })
      .onNotification('session/update', (ctx) => {
        const u = ctx.params.update
        if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') chunks.push(u.content.text)
      })
      .connectWith(
        ndJsonStream(Writable.toWeb(acp.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(acp.stdout!) as ReadableStream<Uint8Array>),
        async (cx) => {
          await cx.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
          const { sessionId } = await cx.request('session/new', { cwd: data, mcpServers: [] })
          const r = await cx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'acp' }] })
          return r.stopReason
        },
      )
    expect(stop).toBe('end_turn')
    expect(chunks.join('')).toBe('echo: acp')
    killTree(acp)

    // shutdown:监管与工作进程都要在 35 s 内退出
    const c = await ctl()
    await c.call('shutdown')
    c.close()
    await Promise.race([supExited, sleep(35_000)])
    await waitFor(() => !alive(sup.pid!) && !alive(workerPid), 35_000, 'both processes gone')
  }, 90_000)
})
