import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream } from '@agentclientprotocol/sdk'
import { PROTOCOL_VERSION, connectClient, connectControlClient, runtimePaths, type KernelEvent } from '../src/protocol/index'
import { startTime } from '../src/lib/proc/pgids'
import { SYSTEM as CHECKPOINT_SYSTEM } from '../src/plugins/memory-default/checkpoints'
import { SYSTEM as EXTRACT_SYSTEM } from '../src/plugins/memory-default/consolidate'
import { cleanupFakes, installFake, waitDead, type FakeCli } from './fakeCli'
import { FAKE_MODEL, startFakeOpenai, textReply, toolCall, type FakeOpenai } from './fakeOpenai'
import { startFakeUpstream } from './fakeUpstream'

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
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const p of procs.splice(0)) killTree(p)
    for (const pid of pids.splice(0)) if (pid > 0 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
    cleanupFakes()
    for (const c of closers.splice(0)) await c()
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true })
  })

  const electron = () => process.env.ELECTRON_BIN ?? (createRequire(import.meta.url)('electron') as string)

  /** 起构建产物的监管进程(临时 HOME / 数据目录 / 全局 git 配置,去掉代理变量),等到 worker running。`extraEnv` 在去掉代理变量之后再加;`config` 换掉默认种子 */
  async function startDaemon(o: { extraEnv?: NodeJS.ProcessEnv; config?: object } = {}) {
    expect(existsSync(DAEMON) && existsSync(ACP)).toBe(true)
    const home = mkdtempSync(join(tmpdir(), 'mffai-e2e-home-'))
    const data = mkdtempSync(join(tmpdir(), 'mffai-e2e-data-'))
    temps.push(home, data, `${data}-worktrees`)
    // PATH 是真的:探测不能跑到机器上真的 codex、qodercli
    writeFileSync(join(data, 'config.json'), JSON.stringify(o.config ?? { executors: { disabled: ['codex', 'qoder'] } }))
    const gitConfig = join(home, 'gitconfig')
    writeFileSync(gitConfig, '')
    const env: NodeJS.ProcessEnv = {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'), MFFAI_DATA_DIR: data, MFFAI_AUTOSTART_DRY_RUN: '1', MFFAI_SECRETS_PLAINTEXT: '1',
      MFFAI_CATALOG_OFFLINE: '1', GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
    }
    for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k]
    Object.assign(env, o.extraEnv)
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
    return { env, home, data, paths, sup, ctl, tokenOf, workerPid, shutdown }
  }

  it.skipIf(process.platform === 'win32')('worker start removes stale proxy socket dirs under TMPDIR, keeps ones a live process owns (final review M4)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mffai-e2e-tmp-'))
    temps.push(tmp)
    const old = (Date.now() - 3_600_000) / 1000
    const plant = (name: string, owner?: object) => {
      const d = join(tmp, name)
      mkdirSync(d, { mode: 0o700 })
      writeFileSync(join(d, 'net.sock'), '')
      if (owner) writeFileSync(join(d, 'owner'), JSON.stringify(owner))
      utimesSync(d, old, old)
      return d
    }
    const stale = plant('mffai-net-stale1')
    const deadOwner = plant('mffai-net-dead01', { pid: process.pid, start: 'not the real start' })
    const live = plant('mffai-net-live01', { pid: process.pid, start: startTime(process.pid) })
    const { shutdown } = await startDaemon({ extraEnv: { TMPDIR: tmp } })
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(deadOwner)).toBe(false)
    expect(existsSync(live)).toBe(true)
    await shutdown()
  })

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

  // 真沙箱(darwin):真实探测;"互联网" = 127.0.0.1 上的假上游代理,经 HTTPS_PROXY 走正常的 upstreamFromEnv
  const sandboxed = process.platform === 'darwin'
    && execFileSync('/bin/sh', ['-c', "/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true && echo y || true"]).toString().trim() === 'y'
  it.skipIf(!sandboxed)('sandboxed coding round: writes stay in cwd, network only through the allowlist proxy', async () => {
    const hasCurl = existsSync('/usr/bin/curl')
    const script = [
      () => toolCall('call_in', 'shell', { command: 'echo ok > in.txt' }),
      () => toolCall('call_out', 'shell', { command: 'echo x > ../outside.txt' }),
      ...(hasCurl ? [() => toolCall('call_curl', 'shell', { command: 'curl -s -o /dev/null -w %{http_code} https://evil.example' })] : []),
    ]
    const fake = await startFakeOpenai({ script })
    const up = await startFakeUpstream()
    try {
      const { env, data, paths, tokenOf, shutdown } = await startDaemon({
        extraEnv: { HTTPS_PROXY: `http://127.0.0.1:${up.port}`, NO_PROXY: '127.0.0.1,localhost' },
      })
      const root = mkdtempSync(join(tmpdir(), 'mffai-e2e-sbx-'))
      temps.push(root)
      const repo = join(root, 'repo')
      execFileSync('mkdir', [repo])
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', '-c', 'commit.gpgSign=false', ...args], { cwd: repo, env, stdio: 'pipe' }).toString()
      git('init', '-q')
      writeFileSync(join(repo, 'a.txt'), 'a')
      git('add', 'a.txt')
      git('commit', '-q', '-m', 'init')

      const w = await connectClient({ addr: paths.workerAddr, token: tokenOf(), timeoutMs: 5000 })
      try {
        expect((await w.call('hello', { clientVersion: '0.0.0', protocolVersion: PROTOCOL_VERSION })).compatible).toBe(true)
        const events: KernelEvent[] = []
        w.onEvent(e => events.push(e))
        await w.call('events.subscribe', { after: 0 })
        expect((await w.call('status')).sandbox?.level).toBe('full')

        const acc = await w.call('models.addAccount', { commandId: 'e2e-sbx-add', presetId: 'custom-openai', baseUrl: fake.base, apiKey: 'sk-e2e-sandbox-0123456789' })
        await waitFor(async () => ((await w.call('models.accounts')).accounts.find(a => a.id === acc.id)?.models ?? []).some(m => m.id === FAKE_MODEL), 10_000, 'model list')
        await w.call('models.setDefault', { accountId: acc.id, modelId: FAKE_MODEL })

        const { sessionId } = await w.call('session.create', { commandId: 'e2e-sbx', cwd: repo, approvalMode: 'auto' })
        await w.call('session.prompt', { commandId: 'e2e-sbx-p', sessionId, text: 'run the commands' })
        const mine = () => events.filter(e => e.sessionId === sessionId)
        await waitFor(() => mine().some(e => e.type === 'turn.ended' || e.type === 'turn.failed'), 60_000, 'turn end')
        const end = mine().find(e => e.type === 'turn.ended' || e.type === 'turn.failed')!
        expect(end.type, JSON.stringify(end.payload)).toBe('turn.ended')
        // auto + full:不弹审批
        expect(mine().filter(e => e.type === 'approval.requested')).toEqual([])
        const ended = mine().filter(e => e.type === 'tool.ended').map(e => e.payload as { name?: string; content?: string })
        expect(ended.map(e => e.name)).toEqual(script.map(() => 'shell'))

        expect(readFileSync(join(repo, 'in.txt'), 'utf8')).toBe('ok\n')
        expect(existsSync(join(root, 'outside.txt'))).toBe(false)
        if (hasCurl) {
          const curl = ended[2].content ?? ''
          expect(curl, curl).not.toMatch(/\b200\b/)
          expect(mine().some(e => e.type === 'sandbox.netDenied'
            && (e.payload as { host?: string }).host === 'evil.example' && (e.payload as { port?: number }).port === 443)).toBe(true)
          // 被拒的主机不会到上游
          expect(up.connects.map(c => c.line).filter(l => l.includes('evil.example'))).toEqual([])
        }
        // 回合结束后没有留下进程组
        const pg = join(data, 'run', 'shell-pgids')
        await waitFor(() => !existsSync(pg) || readFileSync(pg, 'utf8').trim() === '', 5000, 'shell-pgids empty')
      } finally { w.close() }
      await shutdown()
    } finally {
      await up.close()
      await fake.close()
    }
  }, 120_000)

  // 04 委派:假 codex / qodercli 排在 PATH 最前面,真探测、真沙箱级别、真工作进程。真的 CLI 不跑
  describe.skipIf(!sandboxed)('delegation to a fake CLI', () => {
    const CODEX_LINES = readFileSync(join(__dirname, 'fixtures', 'executors', 'codex-exec-0.154.jsonl'), 'utf8').split('\n').filter(Boolean)
    const FINISH = '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    const PROMPT = 'write out.txt with one line'
    const OPENAI_KEY = 'sk-daemon-env-openai-0123456789abcdef'
    const QODER_KEY = 'sk-daemon-env-qoder-0123456789abcdef'
    // 带空格:工具描述和"已启动"结果里也写着 `<executor-notice>`,那些不是通知
    const notice = '<executor-notice '

    const execCalls = (f: FakeCli) => f.calls().filter(c => c.argv[0] === 'exec')
    const delegated = () => toolCall('c1', 'delegate_codex', { prompt: PROMPT })
    const chats = (fake: FakeOpenai) => fake.requests.filter(r => r.method === 'POST' && r.url.endsWith('/chat/completions')).map(r => r.body)
    type Client = Awaited<ReturnType<typeof connectClient>>

    /** 连上工作进程,事件从头订阅 */
    async function attach(paths: ReturnType<typeof runtimePaths>, token: string) {
      const w = await connectClient({ addr: paths.workerAddr, token, timeoutMs: 5000 })
      expect((await w.call('hello', { clientVersion: '0.0.0', protocolVersion: PROTOCOL_VERSION })).compatible).toBe(true)
      const events: KernelEvent[] = []
      w.onEvent(e => events.push(e))
      await w.call('events.subscribe', { after: 0 })
      return { w, events }
    }

    /** 两个执行器都探测完,工具才注册;之前模型调 delegate_codex 只会得到"没有这个工具" */
    const detected = (w: Client) => waitFor(async () => {
      const { executors } = await w.call('executor.list')
      return executors.length === 2 && executors.every(e => e.installed && !e.missing.includes('detecting'))
    }, 60_000, 'executors detected')

    async function rig(scenario: object) {
      const f = installFake(scenario, 'codex')
      // 机器上真的 qodercli 不能被探测到:同一份假 CLI,同一个目录(共用 scenario.json、calls.jsonl)
      copyFileSync(f.file, join(f.dir, 'qodercli'))
      chmodSync(join(f.dir, 'qodercli'), 0o755)
      const script = [delegated]
      const fake = await startFakeOpenai({ script })
      closers.push(() => fake.close())
      // 运行的 mffai-run-* 落在这里,结束后能查
      const tmp = mkdtempSync(join(tmpdir(), 'mffai-e2e-tmp-'))
      temps.push(tmp)
      const d = await startDaemon({
        config: {},
        extraEnv: { PATH: `${f.dir}:${process.env.PATH}`, TMPDIR: tmp, OPENAI_API_KEY: OPENAI_KEY, QODER_PAT: QODER_KEY },
      })
      const repo = mkdtempSync(join(tmpdir(), 'mffai-e2e-repo-'))
      temps.push(repo)
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', '-c', 'commit.gpgSign=false', ...args], { cwd: repo, env: d.env, stdio: 'pipe' }).toString()
      git('init', '-q')
      writeFileSync(join(repo, 'a.txt'), 'a')
      git('add', 'a.txt')
      git('commit', '-q', '-m', 'init')

      const { w, events } = await attach(d.paths, d.tokenOf())
      const acc = await w.call('models.addAccount', { commandId: 'e2e-exec-add', presetId: 'custom-openai', baseUrl: fake.base, apiKey: 'sk-e2e-delegation-0123456789' })
      await waitFor(async () => ((await w.call('models.accounts')).accounts.find(a => a.id === acc.id)?.models ?? []).some(m => m.id === FAKE_MODEL), 10_000, 'model list')
      await w.call('models.setDefault', { accountId: acc.id, modelId: FAKE_MODEL })
      await detected(w)
      const { executors } = await w.call('executor.list')
      expect(executors.find(e => e.id === 'codex')).toMatchObject({ auth: 'ok', isolation: 'own', missing: [] })
      expect(executors.find(e => e.id === 'qoder')).toMatchObject({ auth: 'ok', isolation: 'wrapped', missing: [] })
      // 探测到的确实是假的那个
      expect(f.calls().some(c => c.argv[0] === '--version')).toBe(true)
      expect(executors.every(e => e.version?.includes('fake-cli'))).toBe(true)

      const { sessionId } = await w.call('session.create', { commandId: 'e2e-exec', cwd: repo, approvalMode: 'auto' })
      return { f, fake, d, tmp, repo, w, events, sessionId }
    }

    const noRunLeftovers = async (data: string, tmp: string) => {
      const pg = join(data, 'run', 'shell-pgids')
      await waitFor(() => !existsSync(pg) || readFileSync(pg, 'utf8').trim() === '', 5000, 'shell-pgids empty')
      await waitFor(() => readdirSync(tmp).filter(n => n.startsWith('mffai-run-')).length === 0, 5000, 'no mffai-run-* left')
    }

    it('fake codex round: start, progress, notice to the model, rollback, nothing left', async () => {
      const r = await rig({
        selftest: 'pass',
        writeFiles: { 'out.txt': 'from codex\n' },
        // 模型先回完第二次请求、停下,运行才结束
        lines: CODEX_LINES.map(line => ({ line, delayMs: 400 })),
        exit: 0,
      })
      const { f, fake, d, tmp, repo, w, sessionId } = r
      try {
        const { turnId } = await w.call('session.prompt', { commandId: 'e2e-exec-p', sessionId, text: 'use codex' })
        const mine = () => r.events.filter(e => e.sessionId === sessionId)
        const terminal = () => mine().filter(e => e.type === 'turn.ended' || e.type === 'turn.failed')
        await waitFor(() => terminal().length > 0, 60_000, 'turn end')
        expect(terminal().map(e => e.type), JSON.stringify(terminal()[0].payload)).toEqual(['turn.ended'])
        // auto + full + own:不问
        expect(mine().filter(e => e.type === 'approval.requested')).toEqual([])

        const first = (type: string, ok: (p: any) => boolean = () => true) => mine().find(e => e.type === type && ok(e.payload))
        const toolEnded = first('tool.ended', p => p.name === 'delegate_codex')!
        expect((toolEnded.payload as { content?: string }).content).toContain('已启动')
        const started = first('executor.run.started')!
        const progress = mine().filter(e => e.type === 'executor.run.progress')
        const ended = first('executor.run.ended')!
        const noticed = first('executor.notice')!
        const end = terminal()[0]
        expect(progress.length).toBeGreaterThanOrEqual(1)
        const order = [toolEnded, started, progress[0], progress.at(-1)!, ended, noticed, end].map(e => e.seq)
        expect(order).toEqual([...order].sort((a, b) => a - b))
        expect(ended.payload).toMatchObject({ turnId, status: 'ok', usage: expect.anything() })
        expect((ended.payload as { changed: { files: string[]; source: string } }).changed.files).toContain('out.txt')

        // 通知到了模型:正好第三次请求,之前的请求里没有;模型的回答排在通知之后、turn.ended 之前
        const bodies = chats(fake)
        expect(bodies).toHaveLength(3)
        expect(bodies.map(b => b.includes(notice))).toEqual([false, false, true])
        const lastAnswer = mine().filter(e => e.type === 'message.assistant').at(-1)!
        expect(noticed.seq).toBeLessThan(lastAnswer.seq)
        expect(lastAnswer.seq).toBeLessThan(end.seq)

        // 实际传给 CLI 的
        const execs = execCalls(f)
        expect(execs).toHaveLength(1)
        expect(execs[0].argv.join(' ')).toContain('default_permissions')
        expect(execs[0].argv.join(' ')).not.toContain(PROMPT)
        expect(execs[0].stdin).toContain(PROMPT)
        expect(execs[0].cwd).toBe(realpathSync(repo))
        for (const name of ['OPENAI_API_KEY', 'QODER_PAT']) expect(execs[0].envNames).not.toContain(name)
        // daemon 环境里的密钥不进事件
        for (const key of [OPENAI_KEY, QODER_KEY]) expect(JSON.stringify(r.events)).not.toContain(key)

        expect(readFileSync(join(repo, 'out.txt'), 'utf8')).toBe('from codex\n')
        expect(await w.call('turn.rollback', { commandId: 'e2e-exec-rb', sessionId, turnId })).toMatchObject({ ok: true })
        expect(existsSync(join(repo, 'out.txt'))).toBe(false)

        await noRunLeftovers(d.data, tmp)
      } finally { w.close() }
      await d.shutdown()
    }, 180_000)

    it('follow-up round: a parked turn takes the message, the fake keeps running, one turn', async () => {
      const go = join(mkdtempSync(join(tmpdir(), 'mffai-e2e-go-')), 'go')
      temps.push(dirname(go))
      // 不用定长 sleep:跑多久由测试说了算,机器再慢,消息也一定落在运行结束之前
      const r = await rig({ selftest: 'pass', run: `while [ ! -e '${go}' ]; do sleep 0.02; done; printf '%s\\n' '${FINISH}'` })
      const { f, fake, d, tmp, w, sessionId } = r
      try {
        const { turnId } = await w.call('session.prompt', { commandId: 'e2e-fu-p', sessionId, text: 'use codex' })
        const mine = () => r.events.filter(e => e.sessionId === sessionId)
        const parked = () => mine().filter(e => e.type === 'turn.parked').length
        await waitFor(() => parked() === 1, 60_000, 'turn parked')
        const pid = await f.waitPid('cli')
        expect(chats(fake)).toHaveLength(2)

        const text = 'how is it going over there'
        expect(await w.call('session.prompt', { commandId: 'e2e-fu-q', sessionId, text })).toEqual({ accepted: true, turnId, followUp: true })
        await waitFor(() => parked() === 2, 30_000, 'parked again after the follow-up')
        expect(chats(fake)).toHaveLength(3)
        expect(chats(fake)[2]).toContain(text)
        expect(alive(pid)).toBe(true)
        expect(f.pids().filter(p => p.role === 'cli').map(p => p.pid)).toEqual([pid])

        writeFileSync(go, '')
        const terminal = () => mine().filter(e => e.type === 'turn.ended' || e.type === 'turn.failed')
        await waitFor(() => terminal().length > 0, 30_000, 'turn end')
        expect(terminal().map(e => e.type), JSON.stringify(terminal()[0].payload)).toEqual(['turn.ended'])
        const ofType = (t: string) => mine().filter(e => e.type === t)
        const end = terminal()[0]
        expect(ofType('executor.run.ended')[0].payload).toMatchObject({ turnId, status: 'ok' })
        expect(ofType('executor.notice')).toHaveLength(1)
        expect(ofType('executor.notice')[0].seq).toBeLessThan(end.seq)
        expect(chats(fake)).toHaveLength(4)
        expect(chats(fake)[3]).toContain(notice)
        expect(ofType('turn.started')).toHaveLength(1)
        expect(ofType('turn.snapshot').filter(e => (e.payload as { phase?: string }).phase === 'end')).toHaveLength(1)
        expect(execCalls(f)).toHaveLength(1)
        expect(f.pids().filter(p => p.role === 'cli').map(p => p.pid)).toEqual([pid])
        await waitDead(pid, 5000)
        expect(alive(pid)).toBe(false)
        await noRunLeftovers(d.data, tmp)
      } finally { w.close() }
      await d.shutdown()
    }, 180_000)

    it('SIGKILL round: the worker dies mid-run, the new worker reaps the CLI and reports it, never re-runs it', async () => {
      const r = await rig({ selftest: 'pass', forwarding: true, lines: [CODEX_LINES[0]] })
      const { f, d, tmp, sessionId } = r
      const { turnId } = await r.w.call('session.prompt', { commandId: 'e2e-kill-p', sessionId, text: 'use codex' })
      await waitFor(() => r.events.some(e => e.sessionId === sessionId && e.type === 'turn.parked'), 60_000, 'turn parked')
      const cli = await f.waitPid('cli')
      const child = await f.waitPid('child')
      await waitFor(() => execCalls(f).length === 1, 15_000, 'exec recorded')
      expect(alive(cli) && alive(child)).toBe(true)
      expect(readdirSync(tmp).filter(n => n.startsWith('mffai-run-'))).toHaveLength(1)

      r.w.close()
      process.kill(d.workerPid, 'SIGKILL')

      let worker = 0
      await waitFor(async () => {
        try {
          const c = await d.ctl()
          try { const s = await c.call('status'); worker = s.workerPid ?? 0; return s.state === 'running' && worker > 0 && worker !== d.workerPid } finally { c.close() }
        } catch { return false }
      }, 30_000, 'supervisor started a new worker')
      pids.push(worker)
      expect(alive(d.workerPid)).toBe(false)

      const { w, events } = await attach(d.paths, d.tokenOf())
      try {
        const mine = () => events.filter(e => e.sessionId === sessionId)
        await waitFor(() => mine().some(e => e.type === 'turn.failed' || e.type === 'turn.ended'), 15_000, 'recovery events')
        const ended = mine().filter(e => e.type === 'executor.run.ended')
        const notices = mine().filter(e => e.type === 'executor.notice')
        const failed = mine().filter(e => e.type === 'turn.failed')
        expect(ended).toHaveLength(1)
        expect(ended[0].payload).toMatchObject({ turnId, status: 'interrupted', reason: 'daemon_restart' })
        expect(notices).toHaveLength(1)
        expect((notices[0].payload as { text: string }).text).toContain('status="interrupted"')
        expect(failed).toHaveLength(1)
        expect(failed[0].payload).toMatchObject({ turnId, reason: 'interrupted' })
        expect(mine().some(e => e.type === 'turn.ended')).toBe(false)
        expect(ended[0].seq).toBeLessThan(notices[0].seq)
        expect(notices[0].seq).toBeLessThan(failed[0].seq)

        expect(await waitDead(cli, 15_000), 'fake CLI still alive').toBe(true)
        expect(await waitDead(child, 15_000), 'own-session child still alive').toBe(true)

        // 新工作进程又探测了一遍,但不重跑任务
        await detected(w)
        expect(execCalls(f)).toHaveLength(1)
        await noRunLeftovers(d.data, tmp)
      } finally { w.close() }
      await d.shutdown()
      await waitFor(() => !alive(worker), 35_000, 'new worker gone')
    }, 180_000)
  })

  // 06 记忆:构建产物、Electron 的 Node、真 FTS5、真监管。模型是假的,后台请求按 SYSTEM 文本认,和前台的先后无关
  describe('memory', () => {
    const NOTE = '包管理器用 pnpm'
    type Body = { messages: unknown[]; tools?: unknown }
    const parsed = (b: string) => JSON.parse(b) as Body
    const systemOf = (b: string) => {
      const m = parsed(b).messages[0] as { role?: string; content?: unknown }
      return typeof m?.content === 'string' ? m.content : ''
    }
    const background = (b: string) => [CHECKPOINT_SYSTEM, EXTRACT_SYSTEM].includes(systemOf(b))
    const bodies = (fake: FakeOpenai) => fake.requests.filter(r => r.method === 'POST' && r.url.endsWith('/chat/completions')).map(r => r.body)
    const foreground = (fake: FakeOpenai) => bodies(fake).filter(b => !background(b))
    /** 前一个请求的 messages 逐字节是后一个的前缀;system 和 tools 也一样(内容里没有密钥和循环提醒) */
    const expectPrefix = (before: string, after: string) => {
      const [a, b] = [parsed(before), parsed(after)]
      expect(b.messages.length).toBeGreaterThan(a.messages.length)
      expect(JSON.stringify(b.messages.slice(0, a.messages.length))).toBe(JSON.stringify(a.messages))
      expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools))
    }
    /** 真的按字节扫数据目录:库、WAL、笔记文件、日志 */
    const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(d => {
      const p = join(dir, d.name)
      return d.isDirectory() ? filesUnder(p) : d.isFile() ? [p] : []
    })
    const holding = (data: string, text: string) => filesUnder(data).filter(f => readFileSync(f).includes(Buffer.from(text)))
    type Daemon = Awaited<ReturnType<typeof startDaemon>>
    type Client = Awaited<ReturnType<typeof connectClient>>

    async function attach(d: Daemon, fromEnd = false) {
      // 删除时事件库要整个重写:调用的超时要盖得住
      const w = await connectClient({ addr: d.paths.workerAddr, token: d.tokenOf(), timeoutMs: 120_000 })
      expect((await w.call('hello', { clientVersion: '0.0.0', protocolVersion: PROTOCOL_VERSION })).compatible).toBe(true)
      const events: KernelEvent[] = []
      w.onEvent(e => events.push(e))
      // fromEnd:大日志从 0 订阅会同步读完整个日志,超过漏 ping 的上限就被杀(见计划的 Verification results)
      await w.call('events.subscribe', { after: fromEnd ? ((await w.call('events.tail', { limit: 1 })).events.at(-1)?.seq ?? 0) : 0 })
      return { w, events }
    }
    type Conn = Awaited<ReturnType<typeof attach>>

    async function boot(fake: FakeOpenai) {
      const d = await startDaemon()
      const conn = await attach(d)
      const acc = await conn.w.call('models.addAccount', { commandId: 'e2e-mem-add', presetId: 'custom-openai', baseUrl: fake.base, apiKey: 'sk-e2e-memory-0123456789' })
      await waitFor(async () => ((await conn.w.call('models.accounts')).accounts.find(a => a.id === acc.id)?.models ?? []).some(m => m.id === FAKE_MODEL), 10_000, 'model list')
      await conn.w.call('models.setDefault', { accountId: acc.id, modelId: FAKE_MODEL })
      const cwd = mkdtempSync(join(tmpdir(), 'mffai-e2e-mem-'))
      temps.push(cwd)
      return { d, conn, acc, cwd }
    }

    /** 杀掉工作进程,等监管起新的,重新连上 */
    async function killWorker(d: Daemon, conn: Conn, waitMs = 30_000, fromEnd = false): Promise<Conn> {
      const { workerPid } = await d.ctl().then(async c => { try { return await c.call('status') } finally { c.close() } })
      conn.w.close()
      process.kill(workerPid!, 'SIGKILL')
      let worker = 0
      await waitFor(async () => {
        try {
          const c = await d.ctl()
          try { const s = await c.call('status'); worker = s.workerPid ?? 0; return s.state === 'running' && worker > 0 && worker !== workerPid } finally { c.close() }
        } catch { return false }
      }, waitMs, 'supervisor started a new worker')
      pids.push(worker)
      return attach(d, fromEnd)
    }

    let commands = 0
    const newSession = async (w: Client, cwd: string) => (await w.call('session.create', { commandId: `e2e-mem-s${++commands}`, cwd, approvalMode: 'auto' })).sessionId
    /** 发一条,等这一轮结束。按 turnId 认:重连之后老事件还在重放 */
    async function say({ w, events }: Conn, sessionId: string, text: string) {
      const { turnId } = await w.call('session.prompt', { commandId: `e2e-mem-p${++commands}`, sessionId, text })
      const ended = () => events.find(e => e.sessionId === sessionId && (e.type === 'turn.ended' || e.type === 'turn.failed') && (e.payload as { turnId?: string }).turnId === turnId)
      await waitFor(() => ended() !== undefined, 30_000, `turn end: ${text.slice(0, 40)}`)
      expect(ended()!.type, JSON.stringify(ended()!.payload)).toBe('turn.ended')
    }
    const setFile = async (w: Client, file: 'USER.md' | 'MEMORY.md', content: string) => {
      const { hash } = await w.call('memory.file.get', { file })
      return w.call('memory.file.set', { commandId: `e2e-mem-f${++commands}`, file, content, expectedHash: hash })
    }

    it('memory and delete rounds: core block, exact prefix across a worker kill, Chinese search, delete survives another kill', async () => {
      const fake = await startFakeOpenai({ script: [] })
      closers.push(() => fake.close())
      const { d, conn: first, cwd } = await boot(fake)
      let conn = first
      await setFile(conn.w, 'USER.md', `- ${NOTE}\n`)

      const a = await newSession(conn.w, cwd)
      await say(conn, a, '依赖装不上,pnpm install 报错了')
      expect(foreground(fake)).toHaveLength(1)
      expect(foreground(fake)[0]).toContain('<memory kind=\\"core\\">') // 请求体是 JSON,引号转义过
      expect(foreground(fake)[0]).toContain(NOTE)

      await say(conn, a, '换个镜像再试试看')
      expect(foreground(fake)).toHaveLength(2)
      expectPrefix(foreground(fake)[0], foreground(fake)[1])

      conn = await killWorker(d, conn)
      await say(conn, a, '还是不行,接着看')
      expect(foreground(fake)).toHaveLength(3)
      expectPrefix(foreground(fake)[1], foreground(fake)[2])

      // 打包的运行时里 FTS5 trigram 真的能搜中文;接入的游标活过了 SIGKILL:正好一行,没有漏也没有重
      const notes = (await conn.w.call('memory.search', { query: '包管理器' })).items
      expect(notes.map(i => i.text)).toContain(NOTE)
      const raw = (await conn.w.call('memory.search', { query: 'pnpm', layer: 'raw' })).items
      expect(raw.filter(i => i.text.includes('pnpm install'))).toHaveLength(1)
      expect((await conn.w.call('memory.search', { query: '换个镜像', layer: 'raw' })).items).toHaveLength(1)
      const healthy = await conn.w.call('memory.health')
      expect(healthy.problems).toEqual([])

      // 删除:真工作进程要向真监管要时间,监管不确认就抛错
      const entry = notes.find(i => i.text === NOTE)!
      const { workerPid } = await d.ctl().then(async c => { try { return await c.call('status') } finally { c.close() } })
      expect(await conn.w.call('memory.delete', { commandId: 'e2e-mem-del', id: entry.id })).toMatchObject({ ok: true })
      const still = await d.ctl().then(async c => { try { return await c.call('status') } finally { c.close() } })
      expect(still).toMatchObject({ state: 'running', workerPid })
      expect(holding(d.data, NOTE)).toEqual([])
      expect((await conn.w.call('memory.search', { query: '包管理器' })).items).toEqual([])
      expect(conn.events.filter(e => e.type === 'memory.deleted')).toHaveLength(1)
      expect(conn.events.filter(e => e.type === 'events.redacted').length).toBeGreaterThan(0)

      await say(conn, a, '删掉之后再说一句')
      expect(foreground(fake).at(-1)).not.toContain(NOTE)
      const afterDelete = foreground(fake).at(-1)!
      await say(conn, a, '再说一句,看前缀')
      expectPrefix(afterDelete, foreground(fake).at(-1)!)

      const fresh = await newSession(conn.w, cwd)
      await say(conn, fresh, '新开一个会话问问')
      expect(foreground(fake).at(-1)).not.toContain(NOTE)
      expect(foreground(fake).at(-1)).not.toContain('<memory kind=')

      // 还是没有:重启后没有哪条路把它带回来
      conn = await killWorker(d, conn)
      expect(holding(d.data, NOTE)).toEqual([])
      expect((await conn.w.call('memory.search', { query: '包管理器' })).items).toEqual([])
      await say(conn, a, '重启之后再说一句')
      expect(foreground(fake).at(-1)).not.toContain(NOTE)
      const later = await newSession(conn.w, cwd)
      await say(conn, later, '重启之后的新会话')
      expect(foreground(fake).at(-1)).not.toContain(NOTE)
      expect((await conn.w.call('memory.health')).problems).toEqual([])
      conn.w.close()
      await d.shutdown()
    }, 180_000)

    it('delete on a large log: the VACUUM outlasts the ping limit, the supervisor holds off, the same worker answers afterwards', async () => {
      const fake = await startFakeOpenai({ script: [] })
      closers.push(() => fake.close())
      const { d, conn: first, cwd } = await boot(fake)
      let conn = first
      await setFile(conn.w, 'USER.md', `- ${NOTE}\n`)
      const a = await newSession(conn.w, cwd)
      await say(conn, a, '随便说一句')

      // 约 13 ms/MB,漏 3 次 ping(约 4 s)就杀:灌到 VACUUM 明显超过这条线。第二个连接直接写,新工作进程读得到
      const db = new DatabaseSync(join(d.data, 'db', 'events.sqlite'))
      const line = `src/x.ts:42: error TS2345 argument 端口 5173 ${'x'.repeat(60)}\n`
      const text = line.repeat(Math.ceil(8000 / line.length)).slice(0, 8000)
      const insert = db.prepare('INSERT INTO events(ts, type, session_id, payload) VALUES (?, ?, ?, ?)')
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('BEGIN')
      for (let n = 0; n < 65_000; n++) {
        insert.run(Date.now(), 'message.assistant.delta', a, JSON.stringify({ turnId: `seeded-${Math.floor(n / 100)}`, text: `${n} ${text}` }))
        if (n % 5000 === 4999) { db.exec('COMMIT'); db.exec('BEGIN') }
      }
      db.exec('COMMIT')
      db.exec('PRAGMA wal_checkpoint(PASSIVE)')
      db.close()
      const mb = Math.round(statSync(join(d.data, 'db', 'events.sqlite')).size / 1_048_576)
      expect(mb).toBeGreaterThan(450)

      const bootAt = Date.now()
      // 启动要读整个日志:读的这段时间回不了 ping,靠启动时要的 hold 才不被当成卡死
      conn = await killWorker(d, conn, 90_000, true)
      const bootMs = Date.now() - bootAt
      const status = () => d.ctl().then(async c => { try { return await c.call('status') } finally { c.close() } })
      const { workerPid } = await status()
      const notes = (await conn.w.call('memory.search', { query: '包管理器' })).items
      const at = Date.now()
      try {
      expect(await conn.w.call('memory.delete', { commandId: 'e2e-mem-big', id: notes.find(i => i.text === NOTE)!.id })).toMatchObject({ ok: true })
      } catch (err) {
        process.stderr.write(`DBGLOG at ${Date.now() - at} ${filesUnder(d.paths.logs).map(f => readFileSync(f, 'utf8')).join('\n').split('\n').slice(-14).join('\nDBGLOG ')}\n`)
        throw err
      }
      const deleteMs = Date.now() - at
      process.stderr.write(`MFFAI_E2E_DELETE logMb=${mb} bootMs=${bootMs} deleteMs=${deleteMs}\n`)
      expect(await status()).toMatchObject({ state: 'running', workerPid })
      expect(alive(workerPid!)).toBe(true)
      const log = filesUnder(d.paths.logs).map(f => readFileSync(f, 'utf8')).join('\n')
      expect(log).not.toContain('worker hung')
      expect(holding(join(d.data, 'db'), NOTE)).toEqual([])
      conn.w.close()
      const stopAt = Date.now()
      await d.shutdown()
      process.stderr.write(`MFFAI_E2E_SHUTDOWN logMb=${mb} ms=${Date.now() - stopAt}\n`)
    }, 300_000)

    it('compaction round: a small context gets a checkpoint from the route past 45%, a rebuild past 70%, and old text stays searchable', async () => {
      const CHECKPOINT = ['## 目标', '修 bug', '## 用户的要求与决定', '无', '## 关键事实', '端口 5173', '## 进展与待办', '继续'].join('\n')
      let calls = 0
      const fake = await startFakeOpenai({
        route: body => {
          if (systemOf(body) === CHECKPOINT_SYSTEM) return textReply(CHECKPOINT)
          const last = parsed(body).messages.at(-1) as { role?: string }
          return last.role === 'tool' ? textReply('看完了') : toolCall(`c${++calls}`, 'read', { path: 'big.txt' })
        },
      })
      closers.push(() => fake.close())
      const { d, conn: first, acc, cwd } = await boot(fake)
      const line = 'filler line with some long tool output to read 端口 '.padEnd(190, 'y') + '\n'
      // 一轮只涨几个百分点:45% 和 70% 之间走好几轮,检查点有时间写完,也够两次(第一次省得不够 20%)
      writeFileSync(join(cwd, 'big.txt'), line.repeat(24))

      // 这个账号的窗口改小:配置在磁盘上,新工作进程读到的就是它
      const configFile = join(d.data, 'config.json')
      const config = JSON.parse(readFileSync(configFile, 'utf8')) as { models: { accounts: { id: string; models: { id: string; context: number }[] }[] } }
      const entry = config.models.accounts.find(x => x.id === acc.id)!.models.find(m => m.id === FAKE_MODEL)!
      entry.context = 24_000
      writeFileSync(configFile, JSON.stringify(config))
      let conn = await killWorker(d, first)
      await waitFor(async () => ((await conn.w.call('models.accounts')).accounts.find(a => a.id === acc.id)?.models ?? []).some(m => m.id === FAKE_MODEL && m.context === 24_000), 10_000, 'small context')

      const s = await newSession(conn.w, cwd)
      const FIRST = '最开始说的话带一个记号 zebra-marker-7788'
      const mine = (type: string) => conn.events.filter(e => e.sessionId === s && e.type === type)
      await say(conn, s, FIRST)
      for (let i = 0; i < 40 && mine('context.rebuilt').length === 0; i++) {
        await say(conn, s, `第 ${i} 轮,再读一遍这个文件`)
        // 检查点在后台写:写完之前过了 70% 只会折叠
        await sleep(150)
      }
      expect(mine('memory.checkpoint').length).toBeGreaterThan(0)
      expect(mine('context.rebuilt').length).toBeGreaterThan(0)
      const rebuilt = mine('context.rebuilt')[0]
      const countBefore = fake.requests.length
      await say(conn, s, '重建之后接着说')
      expect(fake.requests.length).toBeGreaterThan(countBefore)
      expect(foreground(fake).at(-1)).toContain('<checkpoint')
      expect(rebuilt.seq).toBeGreaterThan(mine('memory.checkpoint')[0].seq)
      // 后台请求:不带工具
      const bg = bodies(fake).filter(background)
      expect(bg.length).toBeGreaterThan(0)
      for (const b of bg) expect(parsed(b).tools).toBeUndefined()
      // 重建不丢东西:最早的话不在请求里了,搜得到
      const found = (await conn.w.call('memory.search', { query: 'zebra-marker-7788', layer: 'raw' })).items
      expect(found.map(i => i.text)).toContain(FIRST)
      conn.w.close()
      await d.shutdown()
    }, 180_000)

    it('nightly round: a scripted extraction makes a proposal, nothing written until approved, then a new session has it', async () => {
      const FACT = '以后都用 tab 缩进写代码'
      const fake = await startFakeOpenai({
        route: body => {
          if (systemOf(body) !== EXTRACT_SYSTEM) return textReply('好的')
          const user = JSON.stringify(parsed(body).messages[1])
          const id = /\[(r_\d+) [^\]]*\][^\[]*tab 缩进/.exec(user)?.[1]
          return textReply(JSON.stringify({ items: id ? [{ text: FACT, kind: 'preference', evidence: [id] }] : [] }))
        },
      })
      closers.push(() => fake.close())
      const { d, conn, cwd } = await boot(fake)
      const s = await newSession(conn.w, cwd)
      await say(conn, s, FACT)
      const before = await conn.w.call('memory.file.get', { file: 'USER.md' })

      const result = await conn.w.call('memory.consolidate', { commandId: 'e2e-mem-night' })
      expect(result, JSON.stringify(result)).toMatchObject({ extracted: 1, proposed: 1 })
      await waitFor(() => conn.events.some(e => e.type === 'memory.proposal'), 5000, 'memory.proposal event')
      expect((await conn.w.call('memory.file.get', { file: 'USER.md' })).hash).toBe(before.hash)
      const next = await newSession(conn.w, cwd)
      await say(conn, next, '先开一个会话看看')
      expect(foreground(fake).at(-1)).not.toContain('<memory kind=')

      const { items } = await conn.w.call('memory.proposals.list', { status: 'pending' })
      expect(items).toHaveLength(1)
      expect(await conn.w.call('memory.proposals.decide', { commandId: 'e2e-mem-ok', id: items[0].id, decision: 'approve' })).toMatchObject({ ok: true })
      expect((await conn.w.call('memory.file.get', { file: 'USER.md' })).content).toContain(FACT)

      const after = await newSession(conn.w, cwd)
      await say(conn, after, '再开一个新会话')
      expect(foreground(fake).at(-1)).toContain('<memory kind=')
      expect(foreground(fake).at(-1)).toContain(FACT)
      conn.w.close()
      await d.shutdown()
    }, 120_000)
  })
})
