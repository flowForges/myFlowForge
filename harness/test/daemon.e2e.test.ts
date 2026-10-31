import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream } from '@agentclientprotocol/sdk'
import { PROTOCOL_VERSION, connectClient, connectControlClient, runtimePaths, type KernelEvent } from '../src/protocol/index'
import { FAKE_MODEL, startFakeOpenai } from './fakeOpenai'

// 构建产物端到端:MFFAI_E2E=1 且已 `npm run build`。环境全部封在临时目录里。
const E2E = process.env.MFFAI_E2E === '1'
const OUT = resolve(__dirname, '../../out/main')
const DAEMON = join(OUT, 'mffaiDaemon.js')
const ACP = join(OUT, 'mffaiAcp.js')

// pid 0 / 负数指向进程组(含 vitest 自己):一律视为不存在
const alive = (pid: number) => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true } catch { return false } }
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
    for (const pid of pids.splice(0)) if (pid > 0 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true })
  })

  const electron = () => process.env.ELECTRON_BIN ?? (createRequire(import.meta.url)('electron') as string)

  /** 起构建产物的监管进程(临时 HOME / 数据目录 / 全局 git 配置,去掉代理变量),等到 worker running */
  async function startDaemon() {
    expect(existsSync(DAEMON) && existsSync(ACP)).toBe(true)
    const home = mkdtempSync(join(tmpdir(), 'mffai-e2e-home-'))
    const data = mkdtempSync(join(tmpdir(), 'mffai-e2e-data-'))
    temps.push(home, data)
    const gitConfig = join(home, 'gitconfig')
    writeFileSync(gitConfig, '')
    const env: NodeJS.ProcessEnv = {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'), MFFAI_DATA_DIR: data, MFFAI_AUTOSTART_DRY_RUN: '1', MFFAI_SECRETS_PLAINTEXT: '1',
      MFFAI_CATALOG_OFFLINE: '1', GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
    }
    for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k]
    const paths = runtimePaths(data)
    const sup = spawn(electron(), [DAEMON], { env, stdio: 'ignore', detached: true })
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
    // 只记 >0 的 pid:alive(0) / kill(0) 会指向 vitest 自己的进程组
    for (const pid of [sup.pid, workerPid]) if (pid && pid > 0) pids.push(pid)
    const shutdown = async () => {
      const c = await ctl()
      await c.call('shutdown')
      c.close()
      await Promise.race([supExited, sleep(35_000)])
      await waitFor(() => !alive(sup.pid!) && !(workerPid > 0 && alive(workerPid)), 35_000, 'both processes gone')
    }
    return { env, home, data, paths, sup, tokenOf, workerPid, shutdown }
  }

  it('supervisor + worker + ACP bridge work from the built bundles', async () => {
    const { env, paths, sup, tokenOf, shutdown } = await startDaemon()

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
    // 会话 cwd 不能落在 mff-ai 数据目录里(validateCwd 会拒),另开一个临时目录
    const acpCwd = mkdtempSync(join(tmpdir(), 'mffai-e2e-acp-'))
    temps.push(acpCwd)
    const acp = spawn(electron(), [ACP], { env, stdio: ['pipe', 'pipe', 'inherit'], detached: true })
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
          const { sessionId } = await cx.request('session/new', { cwd: acpCwd, mcpServers: [] })
          const r = await cx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'acp' }] })
          return r.stopReason
        },
      )
    expect(stop).toBe('end_turn')
    expect(chunks.join('')).toBe('echo: acp')
    killTree(acp)

    // shutdown:监管与工作进程都要在 35 s 内退出
    await shutdown()
  }, 90_000)

  it('coding round against a fake OpenAI server: read → edit → done, snapshot, changes, rollback', async () => {
    const fake = await startFakeOpenai()
    try {
      const { env, home, paths, tokenOf, shutdown } = await startDaemon()
      // 临时仓库:git 走同一套注入环境(临时 HOME / 全局配置)
      const repo = mkdtempSync(join(tmpdir(), 'mffai-e2e-repo-'))
      temps.push(repo)
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', '-c', 'commit.gpgSign=false', ...args], { cwd: repo, env, stdio: 'pipe' }).toString()
      git('init', '-q')
      writeFileSync(join(repo, 'hello.txt'), 'hello world')
      git('add', 'hello.txt')
      git('commit', '-q', '-m', 'init')
      expect(home).not.toBe(process.env.HOME)

      const apiKey = `sk-e2e-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
      const w = await connectClient({ addr: paths.workerAddr, token: tokenOf(), timeoutMs: 5000 })
      try {
        expect((await w.call('hello', { clientVersion: '0.0.0', protocolVersion: PROTOCOL_VERSION })).compatible).toBe(true)
        const events: KernelEvent[] = []
        w.onEvent(e => events.push(e))
        await w.call('events.subscribe', { after: 0 })

        const acc = await w.call('models.addAccount', { commandId: 'e2e-add', presetId: 'custom-openai', baseUrl: fake.base, apiKey })
        await waitFor(async () => ((await w.call('models.accounts')).accounts.find(a => a.id === acc.id)?.models ?? []).some(m => m.id === FAKE_MODEL), 10_000, 'model list')
        await w.call('models.setDefault', { accountId: acc.id, modelId: FAKE_MODEL })

        const { sessionId } = await w.call('session.create', { commandId: 'e2e-code', cwd: repo, approvalMode: 'auto' })
        const { turnId } = await w.call('session.prompt', { commandId: 'e2e-code-p', sessionId, text: 'replace world with mff in hello.txt' })
        const mine = () => events.filter(e => e.sessionId === sessionId)
        await waitFor(() => mine().some(e => e.type === 'turn.ended' || e.type === 'turn.failed'), 30_000, 'turn end')
        const end = mine().find(e => e.type === 'turn.ended' || e.type === 'turn.failed')!
        expect(end.type, JSON.stringify(end.payload)).toBe('turn.ended')

        expect(readFileSync(join(repo, 'hello.txt'), 'utf8')).toBe('hello mff')
        const tools = mine().filter(e => e.type === 'tool.started').map(e => (e.payload as { name?: string }).name)
        expect(tools).toEqual(['read', 'edit'])
        const snap = mine().find(e => e.type === 'turn.snapshot' && (e.payload as { phase?: string }).phase === 'end')
        expect(snap?.payload).toMatchObject({ turnId, phase: 'end', ref: expect.any(String), changed: 1 })
        expect((await w.call('turn.changes', { sessionId, turnId })).files).toEqual([{ path: 'hello.txt', status: 'M' }])
        expect(fake.requests.filter(r => r.method === 'POST' && r.url.endsWith('/chat/completions'))).toHaveLength(3)
        expect(fake.requests.every(r => r.authorization === `Bearer ${apiKey}`)).toBe(true)

        const rb = await w.call('turn.rollback', { commandId: 'e2e-rb', sessionId, turnId })
        expect(rb).toMatchObject({ ok: true, files: 1 })
        expect(readFileSync(join(repo, 'hello.txt'), 'utf8')).toBe('hello world')

        // 密钥不进事件、不进日志
        const tail = await w.call('events.tail', { limit: 1000 })
        expect(tail.events.length).toBeGreaterThan(0)
        expect(JSON.stringify(tail.events)).not.toContain(apiKey)
        expect(JSON.stringify(events)).not.toContain(apiKey)
        const logFiles = (dir: string): string[] => readdirSync(dir).flatMap(f => {
          const p = join(dir, f)
          return statSync(p).isDirectory() ? logFiles(p) : [p]
        })
        const logs = existsSync(paths.logs) ? logFiles(paths.logs) : []
        expect(logs.length).toBeGreaterThan(0)
        for (const f of logs) expect(readFileSync(f, 'utf8'), f).not.toContain(apiKey)
      } finally { w.close() }
      await shutdown()
      // 关停后再查一次(退出时可能还会落日志)
      for (const f of existsSync(paths.logs) ? readdirSync(paths.logs) : []) {
        const p = join(paths.logs, f)
        if (statSync(p).isFile()) expect(readFileSync(p, 'utf8'), p).not.toContain(apiKey)
      }
    } finally { await fake.close() }
  }, 120_000)
})
