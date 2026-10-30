import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { Plugin } from '../../kernel/pluginHost'
import type { Sessions } from '../../kernel/sessions'
import type { ToolContext, ToolsService } from '../../lib/tools/types'
import toolsRegistry from '../tools-registry'
import { createToolsCoding } from './index'
import { clampTimeout, runShell, shellTool, MAX_OUTPUT } from './shell'

const posix = process.platform !== 'win32'

let root: string
let dataDir: string
let home: string
let cwd: string
let pidsFile: string
let kernels: Kernel[] = []

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(fn: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(20)
  }
  return fn()
}
/** 命令自己把 $$ / $! 追加到 pidsFile;afterEach 断言这些进程都已不在 */
const pidsOf = (f: string): number[] => (existsSync(f) ? readFileSync(f, 'utf8').split(/\s+/).filter(Boolean).map(Number) : [])
const recorded = (): number[] => pidsOf(pidsFile)
const track = (cmd: string) => `echo $$ >> '${pidsFile}'; ${cmd}`
const pidIn = (rel: string) => Number(readFileSync(join(cwd, rel), 'utf8').trim())

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-shell-')))
  dataDir = join(root, 'data')
  home = join(root, 'home')
  cwd = join(home, 'repo')
  pidsFile = join(root, 'pids')
  mkdirSync(dataDir)
  mkdirSync(cwd, { recursive: true })
})
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  const pids = [...recorded(), ...pidsOf(join(cwd, 'pid'))] // 孙进程的 pid 由命令写进 cwd/pid
  const allDead = await waitFor(() => pids.every(p => !alive(p)), 3000)
  for (const p of pids) if (alive(p)) process.kill(p, 'SIGKILL')
  rmSync(root, { recursive: true, force: true })
  expect(allDead, `still alive: ${pids.filter(alive).join(',')}`).toBe(true)
})

/** 注入的基础环境:家目录、git 全局配置指向临时目录;混进一个密钥看它被滤掉 */
const baseEnv = () => ({
  PATH: process.env.PATH ?? '',
  HOME: home,
  USERPROFILE: home,
  GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  OPENAI_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz0123',
  ...(process.platform === 'win32' && { ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT }),
})

async function boot(approvalMode: 'ask' | 'auto' = 'auto', loginPath: () => Promise<string> = async () => '') {
  let tools: ToolsService | undefined
  let sessions: Sessions | undefined
  const probe: Plugin = {
    manifest: { id: 'probe', version: '0', kernel: '^0.1.0', inject: ['tools'] },
    activate(ctx) {
      tools = ctx.services.get<ToolsService>('tools')
      sessions = ctx.services.get<Sessions>('sessions')
    },
  }
  const k = await createKernel({
    dataDir, home, secrets: { osBackend: false },
    plugins: [toolsRegistry, createToolsCoding({ shellEnv: baseEnv(), loginPath, minTimeoutMs: 100 }), probe],
  })
  kernels.push(k)
  const { sessionId } = (await k.handle('session.create', { commandId: `c${Math.random()}`, cwd, approvalMode })) as { sessionId: string }
  let n = 0
  const ctxOf = (signal = new AbortController().signal): ToolContext => ({
    sessionId, turnId: 't1', callId: `call${++n}`, cwd: sessions!.get(sessionId)!.cwd!, spillDir: sessions!.spillDir(sessionId), signal,
  })
  const call = (args: unknown, ctx = ctxOf()) => tools!.call('shell', JSON.stringify(args), ctx)
  return { k, tools: tools!, call, ctxOf }
}

describe('shell tool', () => {
  it('is registered; permission() = exec(command)', async () => {
    const { tools, ctxOf } = await boot()
    const t = tools.list().find(x => x.name === 'shell')!
    expect(t.parameters).toMatchObject({ type: 'object' })
    expect(t.permission({ command: 'npm test' }, ctxOf())).toEqual([{ actor: 'tools', action: 'exec', resource: 'npm test' }])
    expect(() => t.permission({ command: '' }, ctxOf())).toThrow()
  })

  it('timeoutMs: default 120 s, clamped to [min, 600 s]', () => {
    expect(clampTimeout(undefined, 1000)).toBe(120_000)
    expect(clampTimeout(5, 1000)).toBe(1000)
    expect(clampTimeout(10_000_000, 1000)).toBe(600_000)
    expect(clampTimeout(300, 100)).toBe(300)
    expect(shellTool({ loginPath: async () => '' }).description.length).toBeGreaterThan(10)
  })

  it.skipIf(!posix)('merges stdout and stderr, reports the exit code', async () => {
    const { call } = await boot()
    const r = await call({ command: track('echo hi; echo err >&2; exit 3') })
    expect(r.isError).toBeUndefined()
    expect(r.content).toBe('exit 3\nhi\nerr\n')
  })

  it.skipIf(!posix)('env is the allowlist: no API key; MFFAI/CI/GIT_TERMINAL_PROMPT set; HOME from the injected env', async () => {
    const { call } = await boot()
    const r = await call({ command: track('env') })
    expect(r.content.startsWith('exit 0\n')).toBe(true)
    expect(r.content).not.toContain('OPENAI_API_KEY')
    expect(r.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123')
    expect(r.content).not.toContain('GIT_CONFIG_GLOBAL')
    expect(r.content).toMatch(/^MFFAI=1$/m)
    expect(r.content).toMatch(/^CI=1$/m)
    expect(r.content).toMatch(/^GIT_TERMINAL_PROMPT=0$/m)
    expect(r.content).toContain(`HOME=${home}\n`)
  })

  it.skipIf(process.platform !== 'darwin')('darwin: PATH contains /opt/homebrew/bin', async () => {
    const { call } = await boot()
    const r = await call({ command: track('printf %s "$PATH"') })
    expect(r.content.replace(/^exit 0\n/, '').split(':')).toContain('/opt/homebrew/bin')
  })

  it.skipIf(!posix)('the login-shell PATH reaches the child, after the base PATH', async () => {
    const { call } = await boot('auto', async () => '/login/only/bin:relative/bin')
    const r = await call({ command: track('printf %s "$PATH"') })
    const parts = r.content.replace(/^exit 0\n/, '').split(':')
    expect(parts).toContain('/login/only/bin')
    expect(parts).not.toContain('relative/bin')
    expect(parts.indexOf('/login/only/bin')).toBeGreaterThan(parts.indexOf((process.env.PATH ?? '').split(':').find(p => p.startsWith('/'))!))
  })

  it.skipIf(!posix)('runs in the session cwd', async () => {
    const { call, ctxOf } = await boot()
    const ctx = ctxOf()
    const r = await call({ command: track('pwd -P') }, ctx)
    expect(r.content).toBe(`exit 0\n${ctx.cwd}\n`)
  })

  it.skipIf(!posix)('stdin is closed: cat returns immediately', async () => {
    const { call } = await boot()
    const t0 = Date.now()
    const r = await call({ command: track('cat'), timeoutMs: 5000 })
    expect(r.content).toBe('exit 0\n')
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it.skipIf(!posix)('Review Focus 3: timeout kills the grandchild', async () => {
    const { call } = await boot()
    const r = await call({ command: track(`sh -c 'sleep 60 & echo $! > pid; wait'`), timeoutMs: 300 })
    expect(r.isError).toBe(true)
    expect(r.content.startsWith('timeout after 300 ms\n')).toBe(true)
    const pid = pidIn('pid')
    expect(await waitFor(() => !alive(pid), 2000)).toBe(true)
  })

  it.skipIf(!posix)('timeoutMs below the floor is clamped up to it', async () => {
    const { call } = await boot()
    const r = await call({ command: track('sleep 5'), timeoutMs: 1 })
    expect(r.isError).toBe(true)
    expect(r.content.startsWith('timeout after 100 ms\n')).toBe(true)
  })

  it.skipIf(!posix)('abort kills the whole tree', async () => {
    const { call, ctxOf } = await boot()
    const ac = new AbortController()
    const p = call({ command: track(`sh -c 'sleep 60 & echo $! > pid; wait'`), timeoutMs: 60_000 }, ctxOf(ac.signal))
    expect(await waitFor(() => existsSync(join(cwd, 'pid')) && readFileSync(join(cwd, 'pid'), 'utf8').trim() !== '')).toBe(true)
    const pid = pidIn('pid')
    expect(alive(pid)).toBe(true)
    ac.abort()
    const r = await p
    expect(r.isError).toBe(true)
    expect(r.content.startsWith('已取消')).toBe(true)
    expect(await waitFor(() => !alive(pid), 2000)).toBe(true)
  })

  it.skipIf(!posix)('a grandchild ignoring SIGTERM is SIGKILLed', async () => {
    const { call } = await boot()
    const r = await call({ command: track(`trap '' TERM; sleep 60 & echo $! > pid; wait`), timeoutMs: 200 })
    expect(r.isError).toBe(true)
    const pid = pidIn('pid')
    expect(await waitFor(() => !alive(pid), 3500)).toBe(true)
  }, 10_000)

  it.skipIf(!posix)('Review Focus 3: cancel while waiting for approval → resolved by cancel / deny, command never runs', async () => {
    const { k, call, ctxOf } = await boot('ask')
    const ac = new AbortController()
    const marker = join(cwd, 'marker')
    const p = call({ command: track(`touch '${marker}'`) }, ctxOf(ac.signal))
    expect(await waitFor(() => k.events.after(0).some(e => e.type === 'approval.requested'))).toBe(true)
    ac.abort()
    const r = await p
    expect(r).toEqual({ content: '用户拒绝了该操作', isError: true })
    const resolved = k.events.after(0).filter(e => e.type === 'approval.resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0].payload).toMatchObject({ by: 'cancel', decision: 'deny' })
    await sleep(100)
    expect(existsSync(marker)).toBe(false)
    expect(recorded()).toEqual([])
  })
})

describe('runShell', () => {
  const env = () => ({ PATH: process.env.PATH ?? '', HOME: home })

  it.skipIf(!posix)('M2: abort then the timeout firing in the grace period → still reported as cancelled', async () => {
    const { call, ctxOf } = await boot()
    const ac = new AbortController()
    // 忽略 TERM:取消后还要等 2 s 才 SIGKILL,其间 100 ms 的超时也触发
    const p = call({ command: track(`trap '' TERM; sleep 60 & echo $! > pid; wait`), timeoutMs: 400 }, ctxOf(ac.signal))
    expect(await waitFor(() => existsSync(join(cwd, 'pid')) && readFileSync(join(cwd, 'pid'), 'utf8').trim() !== '')).toBe(true)
    ac.abort()
    const r = await p
    expect(r.content.startsWith('已取消')).toBe(true)
  }, 10_000)

  it.skipIf(!posix)('caps output at 1 MB and keeps the tail', async () => {
    const r = await runShell(track(`head -c 1500000 /dev/zero | tr '\\0' a; echo; echo TAIL-MARK`), {
      cwd, env: env(), timeoutMs: 20_000, signal: new AbortController().signal, platform: process.platform,
    })
    expect(r.code).toBe(0)
    expect(r.output.endsWith('a\nTAIL-MARK\n')).toBe(true)
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(MAX_OUTPUT + 200)
    expect(r.output).toMatch(/^…\[前 \d+ 字节已省略\]\n/)
  })

  it.skipIf(!posix)('already-aborted signal → nothing spawned', async () => {
    const ac = new AbortController()
    ac.abort()
    const marker = join(cwd, 'm')
    const r = await runShell(track(`touch '${marker}'`), { cwd, env: env(), timeoutMs: 5000, signal: ac.signal, platform: process.platform })
    expect(r).toMatchObject({ code: null, cancelled: true, timedOut: false })
    await sleep(100)
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(!posix)('I2: win32 path — taskkill fails / pipe stays open → the call still returns (close fallback)', async () => {
    // 在 POSIX 上用 platform:'win32' 走 Windows 分支:不建进程组,taskkill.exe 不存在 → child.kill() 只杀 sh;
    // 后台的 sleep 拿着 stdout,close 永远不来 —— 必须靠 2 s + 1 s 兜底返回
    const t0 = Date.now()
    const r = await runShell(`sleep 60 & echo $! > '${join(cwd, 'pid')}'; wait`, {
      cwd, env: env(), timeoutMs: 200, signal: new AbortController().signal, platform: 'win32',
    })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(5000)
    process.kill(pidIn('pid'), 'SIGKILL') // 这个分支杀不到孙进程(不在单独的组里);测试自己收尾
  }, 10_000)

  it('UTF-8 is never cut mid-character when the tail is trimmed', async () => {
    const r = await runShell(posix ? `node -e "process.stdout.write('€'.repeat(400000))"` : 'echo', {
      cwd, env: { ...env(), PATH: process.env.PATH ?? '' }, timeoutMs: 20_000, signal: new AbortController().signal, platform: process.platform,
    })
    if (posix) {
      expect(r.output).not.toContain('\uFFFD')
      expect(r.output.endsWith('€€€')).toBe(true)
    }
  })

  it.skipIf(!posix)('missing cwd → rejects', async () => {
    await expect(runShell('true', { cwd: join(root, 'nope'), env: env(), timeoutMs: 5000, signal: new AbortController().signal, platform: process.platform })).rejects.toThrow()
  })
})
