// 真跑:内核真实探测 → full 级 sandbox 服务 → shell 工具经 sandbox-exec 执行(05 Review Focus 1、2 的沙箱一半、03 Review Focus 3)。
// 临时 HOME / 仓库 / 数据目录;"互联网" = 测试自己在 127.0.0.1:0 起的假上游代理(KernelOpts.sandbox.upstream)。
// 测试进程自己在沙箱里时不能嵌套 → 整个文件跳过(探测只跑一次)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { Plugin } from '../../kernel/pluginHost'
import type { Sessions } from '../../kernel/sessions'
import { upstreamFromEnv } from '../../lib/sandbox/net/proxy'
import { parseEntries, pgidFile } from '../../lib/proc/pgids'
import type { ToolContext, ToolResult, ToolsService } from '../../lib/tools/types'
import { startFakeUpstream, type FakeServer } from '../../../test/fakeUpstream'
import toolsRegistry from '../tools-registry'
import { createToolsCoding } from './index'

function sandboxExecUsable(): boolean {
  if (process.platform !== 'darwin') return false
  return spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }).status === 0
}
const usable = sandboxExecUsable()

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(20)
  }
  return fn()
}
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** 沙箱里跑的探针:direct = 直连某端口;proxy = 经 $HTTPS_PROXY 发 CONNECT,通了再在隧道里发一个 GET */
const PROBE_JS = `
const net = require('net'), [, , mode, a, b] = process.argv
const out = s => { process.stdout.write(s + '\\n'); process.exit(0) }
setTimeout(() => out('TIMEOUT'), 3000)
if (mode === 'direct') {
  const s = net.connect(+a, '127.0.0.1'); let d = ''
  s.on('data', x => { d += x }); s.on('end', () => out('DATA ' + d.trim())); s.on('error', e => out('ERR ' + e.code))
}
if (mode === 'proxy') {
  const u = new URL(process.env.HTTPS_PROXY)
  const s = net.connect(+u.port, u.hostname); let d = '', sent = false
  s.on('error', e => out('ERR ' + e.code))
  s.on('connect', () => s.write('CONNECT ' + a + ' HTTP/1.1\\r\\nHost: ' + a + '\\r\\n\\r\\n'))
  s.on('data', x => {
    d += x
    if (!sent && d.includes('\\r\\n\\r\\n')) {
      const status = d.split(' ')[1]
      if (status !== '200') return out('STATUS ' + status)
      sent = true; d = ''
      s.write('GET /x HTTP/1.1\\r\\nHost: ' + a.split(':')[0] + '\\r\\n\\r\\n')
    }
  })
  s.on('end', () => out('BODY ' + d.split('\\r\\n\\r\\n').pop()))
}
`

let root = ''
let home = ''
let repo = ''
let outside = ''
let probe = ''
let up: FakeServer
let local: Server
let localPort = 0
let kernels: Kernel[] = []
let bootN = 0

const baseEnv = () => ({
  PATH: process.env.PATH ?? '',
  HOME: home,
  USERPROFILE: home,
  GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  LC_ALL: 'C',
  OPENAI_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz0123',
})

async function boot(o: { idleMs?: number } = {}) {
  let tools: ToolsService | undefined
  let sessions: Sessions | undefined
  const grab: Plugin = {
    manifest: { id: 'probe', version: '0', kernel: '^0.1.0', inject: ['tools'] },
    activate(ctx) {
      tools = ctx.services.get<ToolsService>('tools')
      sessions = ctx.services.get<Sessions>('sessions')
    },
  }
  const dataDir = join(root, `data${++bootN}`)
  mkdirSync(dataDir)
  const upstream = upstreamFromEnv({ HTTPS_PROXY: `http://127.0.0.1:${up.port}` }).upstream!
  // 不给 detect:真实探测
  const k = await createKernel({
    dataDir, home, env: baseEnv(), secrets: { osBackend: false },
    sandbox: { upstream, idleMs: o.idleMs ?? 60_000 },
    plugins: [toolsRegistry, createToolsCoding({ shellEnv: baseEnv(), loginPath: async () => '', minTimeoutMs: 100 }), grab],
  })
  kernels.push(k)
  const { sessionId } = (await k.handle('session.create', { commandId: `c${Math.random()}`, cwd: repo, approvalMode: 'auto' })) as { sessionId: string }
  let n = 0
  const ctxOf = (signal = new AbortController().signal): ToolContext => ({
    sessionId, turnId: 't1', callId: `call${++n}`, cwd: sessions!.get(sessionId)!.cwd!, spillDir: sessions!.spillDir(sessionId), signal,
  })
  const call = (command: string, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    tools!.call('shell', JSON.stringify({ command, ...(extra.timeoutMs && { timeoutMs: extra.timeoutMs }) }), ctxOf(extra.signal))
  return { k, call, sessionId, dataDir }
}

const exitOf = (r: ToolResult) => Number(/^exit (\d+)/.exec(r.content)?.[1] ?? NaN)
const body = (r: ToolResult) => r.content.replace(/^exit \S+\n/, '')
const node = q(process.execPath)
const pidFiles = () => ['pid', 'pid2'].map(f => join(repo, f)).filter(existsSync).map(f => Number(readFileSync(f, 'utf8').trim())).filter(Boolean)

describe.skipIf(!usable)('shell tool in the real macOS sandbox', () => {
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-shsbx-')))
    home = join(root, 'home')
    repo = join(root, 'repo')
    outside = join(root, 'outside')
    for (const d of [join(home, '.ssh'), repo, outside]) mkdirSync(d, { recursive: true })
    writeFileSync(join(home, '.ssh', 'id'), 'SECRET\n')
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = t\n\temail = t@example.invalid\n[commit]\n\tgpgsign = false\n')
    symlinkSync(join(home, '.ssh'), join(repo, 'link'))
    probe = join(root, 'probe.js')
    writeFileSync(probe, PROBE_JS)
    const git = spawnSync('/bin/sh', ['-c', 'git init -q -b main && echo a > a.txt && git add a.txt && git commit -qm init'], { cwd: repo, env: baseEnv(), encoding: 'utf8' })
    expect(git.status, git.stderr).toBe(0)
    up = await startFakeUpstream()
    local = createServer(s => s.end('LOCAL\n'))
    await new Promise<void>(r => local.listen(0, '127.0.0.1', () => r()))
    localPort = (local.address() as { port: number }).port
  })
  afterEach(async () => {
    for (const k of kernels) await k.close().catch(() => {})
    kernels = []
    const pids = pidFiles()
    const dead = await waitFor(() => pids.every(p => !alive(p)), 3000)
    for (const p of pids) if (alive(p)) process.kill(p, 'SIGKILL')
    for (const f of ['pid', 'pid2', 'leader']) rmSync(join(repo, f), { force: true })
    expect(dead, `still alive: ${pids.filter(alive).join(',')}`).toBe(true)
  })
  afterAll(async () => {
    await up?.close()
    if (local) await new Promise(r => local.close(() => r(undefined)))
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('real detection gives full; the result says meta.sandbox = full and the env is the 03 allowlist plus the sandbox overlay', async () => {
    const { k, call, sessionId, dataDir } = await boot()
    expect(k.status().sandbox).toMatchObject({ level: 'full', missing: [] })
    const r = await call('env')
    expect(r.meta).toEqual({ sandbox: 'full' })
    expect(exitOf(r)).toBe(0)
    const env = body(r)
    expect(env).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123')
    expect(env).not.toContain('GIT_CONFIG_GLOBAL')
    expect(env).toMatch(/^MFFAI=1$/m)
    expect(env).toMatch(/^MFFAI_SANDBOX=full$/m)
    expect(env).toContain(`TMPDIR=${join(dataDir, 'sessions', sessionId, 'tmp')}\n`)
    expect(env).toMatch(/^HTTPS_PROXY=http:\/\/127\.0\.0\.1:\d+$/m)
    expect(env).toMatch(/^NO_PROXY=$/m)
    expect(env).not.toContain(`:${up.port}`) // 子进程只看到内核代理,看不到上游
  })

  it('Review Focus 4: detect full, session auto → no approval, and the command runs sandboxed', async () => {
    const { k, call, sessionId } = await boot()
    const r = await call('echo $MFFAI_SANDBOX')
    expect(r.meta).toEqual({ sandbox: 'full' })
    expect(body(r).trim()).toBe('full')
    expect(k.events.bySession(sessionId).filter(e => e.type === 'approval.requested')).toHaveLength(0)
  })

  // ── Review Focus 1 ──

  it('Review Focus 1: writes outside cwd fail', async () => {
    const { call } = await boot()
    const r = await call('echo x > ../outside/f')
    expect(exitOf(r)).not.toBe(0)
    expect(existsSync(join(outside, 'f'))).toBe(false)
  })

  it('Review Focus 1: ~/.ssh is unreadable by path, by case variant and through a symlink in cwd', async () => {
    const { call } = await boot()
    for (const cmd of ['cat $HOME/.ssh/id', 'cat $HOME/.SSH/id', 'cat link/id']) {
      const r = await call(cmd)
      expect(r.content, cmd).not.toContain('SECRET')
      expect(exitOf(r), cmd).not.toBe(0)
    }
  })

  it('06 Review Focus 2: the memory files in the data directory cannot be read from a command', async () => {
    const { call, dataDir } = await boot()
    const dir = join(dataDir, 'plugins', 'memory-default', 'files')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'USER.md')
    writeFileSync(file, '- MEMORY-SECRET-MARKER\n')
    const r = await call(`cat ${q(file)}`)
    expect(exitOf(r)).not.toBe(0)
    expect(r.content).not.toContain('MEMORY-SECRET-MARKER')
  })

  it('Review Focus 1: .git/hooks is not writable, but git add + commit works', async () => {
    const { call } = await boot()
    const hook = await call('echo x > .git/hooks/pre-commit')
    expect(exitOf(hook)).not.toBe(0)
    expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false)
    const commit = await call('echo c > c.txt && git add -A && git commit -m t && git rev-list --count HEAD')
    expect(exitOf(commit), commit.content).toBe(0)
    expect(commit.content.trim().split('\n').pop()).toMatch(/^\d+$/)
    expect(Number(commit.content.trim().split('\n').pop())).toBeGreaterThanOrEqual(2)
  })

  it('Review Focus 1: writes in cwd and $TMPDIR succeed', async () => {
    const { call, sessionId, dataDir } = await boot()
    const r = await call('echo x > in.txt && echo y > $TMPDIR/t')
    expect(exitOf(r), r.content).toBe(0)
    expect(readFileSync(join(repo, 'in.txt'), 'utf8')).toBe('x\n')
    expect(readFileSync(join(dataDir, 'sessions', sessionId, 'tmp', 't'), 'utf8')).toBe('y\n')
    rmSync(join(repo, 'in.txt'))
  })

  // ── Review Focus 2(沙箱一半)──

  it('Review Focus 2: direct connections fail; an allowlisted host goes through $HTTPS_PROXY to the upstream; a denied host gets 403 and a sandbox.netDenied event', async () => {
    up.connects.length = 0
    const { k, call, sessionId } = await boot()
    // 直连假上游、直连测试自己的本地服务器:都不通
    const toUp = await call(`${node} ${q(probe)} direct ${up.port}`)
    expect(body(toUp)).toMatch(/^ERR (EPERM|ECONNREFUSED)$/m)
    const toLocal = await call(`${node} ${q(probe)} direct ${localPort}`)
    expect(body(toLocal)).toMatch(/^ERR (EPERM|ECONNREFUSED)$/m)
    expect(up.connects).toEqual([])
    // 经代理:白名单里的主机到达上游,字节往返
    const ok = await call(`${node} ${q(probe)} proxy registry.npmjs.org:443`)
    expect(body(ok)).toContain('BODY ok /x')
    expect(up.connects.map(c => c.line)).toEqual(['CONNECT registry.npmjs.org:443 HTTP/1.1'])
    // 不在白名单:403,上游什么都没收到,记一条 netDenied
    const bad = await call(`${node} ${q(probe)} proxy evil.example:443`)
    expect(body(bad)).toContain('STATUS 403')
    expect(up.connects).toHaveLength(1)
    const denied = k.events.after(0).filter(e => e.type === 'sandbox.netDenied')
    expect(denied.map(e => [e.sessionId, e.payload])).toEqual([[sessionId, { host: 'evil.example', port: 443, reason: 'not_allowed' }]])
  })

  it('allowLoopback (R6): local servers are reachable directly, the level is partial, the proxy still filters', async () => {
    up.connects.length = 0
    const { k, call } = await boot()
    expect(await k.handle('permissions.set', { commandId: 'p1', config: { sandbox: { enabled: true, allowLoopback: true } } })).toEqual({ ok: true })
    const env = await call('env')
    expect(env.meta).toEqual({ sandbox: 'partial' })
    expect(body(env)).toMatch(/^NO_PROXY=localhost,127\.0\.0\.1,::1$/m)
    expect(body(env)).toMatch(/^MFFAI_SANDBOX=partial$/m)
    expect(body(await call(`${node} ${q(probe)} direct ${localPort}`))).toContain('DATA LOCAL')
    expect(body(await call(`${node} ${q(probe)} proxy registry.npmjs.org:443`))).toContain('BODY ok /x')
    expect(body(await call(`${node} ${q(probe)} proxy evil.example:443`))).toContain('STATUS 403')
    expect(up.connects.map(c => c.line)).toEqual(['CONNECT registry.npmjs.org:443 HTTP/1.1'])
    // 关掉:同一个内核里马上回到 full,直连又被拒
    await k.handle('permissions.set', { commandId: 'p2', config: { sandbox: { enabled: true, allowLoopback: false } } })
    const again = await call(`${node} ${q(probe)} direct ${localPort}`)
    expect(again.meta).toEqual({ sandbox: 'full' })
    expect(body(again)).toMatch(/^ERR (EPERM|ECONNREFUSED)$/m)
  })

  it('sandbox.enabled:false keeps the 03 behaviour (no sandbox, meta none, ../outside writable)', async () => {
    const { k, call } = await boot()
    // 关掉沙箱 = 级别 none:auto 要显式放开才不审批(Task 11)
    await k.handle('permissions.set', { commandId: 'p1', config: { sandbox: { enabled: false, allowLoopback: false }, allowUnsandboxedAuto: true } })
    const r = await call('echo x > ../outside/g && echo "[$MFFAI_SANDBOX][$HTTPS_PROXY]"')
    expect(r).toEqual({ content: 'exit 0\n[][]\n', meta: { sandbox: 'none' } })
    expect(existsSync(join(outside, 'g'))).toBe(true)
    rmSync(join(outside, 'g'))
  })

  // ── 进程:03 Review Focus 3、进程组登记、代理的持有与释放 ──

  it('03 Review Focus 3 under the sandbox: timeout kills the sandboxed grandchild within 2 s', async () => {
    const { call } = await boot()
    const r = await call(`sh -c 'sleep 60 & echo $! > pid; wait'`, { timeoutMs: 300 })
    expect(r).toMatchObject({ isError: true, meta: { sandbox: 'full' } })
    expect(r.content.startsWith('timeout after 300 ms\n')).toBe(true)
    const pid = Number(readFileSync(join(repo, 'pid'), 'utf8').trim())
    expect(await waitFor(() => !alive(pid), 2000)).toBe(true)
  })

  it('cancel kills the sandboxed tree', async () => {
    const { call } = await boot()
    const ac = new AbortController()
    const p = call(`sh -c 'sleep 60 & echo $! > pid; wait'`, { timeoutMs: 60_000, signal: ac.signal })
    expect(await waitFor(() => existsSync(join(repo, 'pid')) && readFileSync(join(repo, 'pid'), 'utf8').trim() !== '')).toBe(true)
    const pid = Number(readFileSync(join(repo, 'pid'), 'utf8').trim())
    ac.abort()
    const r = await p
    expect(r.meta).toEqual({ sandbox: 'full' })
    expect(r.content.startsWith('已取消')).toBe(true)
    expect(await waitFor(() => !alive(pid), 2000)).toBe(true)
  })

  it('the pgid registry records the sandboxed group (leader = the spawned sandbox-exec process); kernel.close() kills a job it left running', async () => {
    const { k, call, dataDir } = await boot()
    const r = await call('sleep 60 >/dev/null 2>&1 & echo $! > pid; echo $$ > leader')
    expect(exitOf(r), r.content).toBe(0)
    expect(r.meta).toEqual({ sandbox: 'full' })
    const leader = Number(readFileSync(join(repo, 'leader'), 'utf8').trim())
    const pid = Number(readFileSync(join(repo, 'pid'), 'utf8').trim())
    // 沙箱里看不到进程表(ps 被拒),从外面查:后台任务与组长同组,组号就是登记的那个
    const pgid = Number(spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim())
    expect(pgid).toBe(leader)
    expect(parseEntries(readFileSync(pgidFile(dataDir), 'utf8')).map(e => e.pgid)).toEqual([leader])
    expect(alive(pid)).toBe(true)
    await k.close()
    kernels = kernels.filter(x => x !== k)
    expect(await waitFor(() => !alive(pid), 2000)).toBe(true)
    expect(readFileSync(pgidFile(dataDir), 'utf8')).toBe('')
  })

  it('the session proxy stays up while a command runs past idleMs, and release() lets it close once idle', async () => {
    up.connects.length = 0
    const { call } = await boot({ idleMs: 300 })
    // 命令先睡过 idleMs 再用代理:命令在跑时代理被持有
    const r = await call(`sleep 0.8; printf '%s\\n' "$HTTPS_PROXY"; ${node} ${q(probe)} proxy registry.npmjs.org:443`)
    expect(exitOf(r), r.content).toBe(0)
    expect(body(r)).toContain('BODY ok /x')
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(body(r))![1])
    // 命令结束 → release → 空闲 300 ms 后代理关闭。只探一次:每次连接都算活动,轮询会让它一直不关
    await sleep(1500)
    const refused = await new Promise<boolean>(resolve => {
      const s = connect(port, '127.0.0.1')
      s.on('connect', () => { s.destroy(); resolve(false) })
      s.on('error', () => resolve(true))
    })
    expect(refused).toBe(true)
  })
})
