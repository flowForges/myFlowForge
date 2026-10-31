import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { Plugin } from '../../kernel/pluginHost'
import type { Sessions } from '../../kernel/sessions'
import type { SandboxService, ShellPlan, ToolContext, ToolsService } from '../../lib/tools/types'
import type { PgidRegistry } from '../../lib/proc/pgids'
import toolsRegistry from '../tools-registry'
import { createToolsCoding } from './index'
import { clampTimeout, runShell, shellTool, unsandboxedPlan, MAX_OUTPUT } from './shell'
import { parseEntries, pgidFile } from '../../lib/proc/pgids'
import { NO_SANDBOX, seedUnsandboxedAuto } from '../../../test/sandboxStub'

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
/** runShell 直接跑一条命令(无沙箱计划) */
const direct = (command: string, env: NodeJS.ProcessEnv): ShellPlan => unsandboxedPlan(command, env)

/**
 * 03 的用例在两种情形下都要过:内核给的 none 级 sandbox 服务(NO_SANDBOX),以及 shell 根本拿不到 sandbox 服务
 * (另一个插件直接注册 shellTool,不传 sandbox);fake:注入的假服务(本文件末尾的用例)
 */
let svcMode: 'none service' | { fake: Pick<SandboxService, 'plan' | 'status'> } = 'none service'

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-shell-')))
  dataDir = join(root, 'data')
  home = join(root, 'home')
  cwd = join(home, 'repo')
  pidsFile = join(root, 'pids')
  mkdirSync(dataDir)
  mkdirSync(cwd, { recursive: true })
  svcMode = 'none service'
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
  const shellOnly = (sandbox: Pick<SandboxService, 'plan' | 'status'>): Plugin => ({
    manifest: { id: 'shell-only', version: '0', kernel: '^0.1.0', inject: ['tools'] },
    activate(ctx) {
      const registry = posix ? ctx.services.get<PgidRegistry>('pgids') : undefined
      ctx.effect(ctx.services.get<ToolsService>('tools')!.register(shellTool({ env: baseEnv(), loginPath, minTimeoutMs: 100, registry, sandbox })))
    },
  })
  const shellPlugin = svcMode === 'none service'
    ? createToolsCoding({ shellEnv: baseEnv(), loginPath, minTimeoutMs: 100 })
    : shellOnly(svcMode.fake)
  seedUnsandboxedAuto(dataDir) // NO_SANDBOX 下 auto 照 03 不审批
  const k = await createKernel({ sandbox: NO_SANDBOX,
    dataDir, home, secrets: { osBackend: false },
    plugins: [toolsRegistry, shellPlugin, probe],
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

describe('sandbox: none service', () => {
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
      expect(shellTool({ loginPath: async () => '', sandbox: undefined as never }).description.length).toBeGreaterThan(10)
    })

    it.skipIf(!posix)('merges stdout and stderr, reports the exit code', async () => {
      const { call } = await boot()
      const r = await call({ command: track('echo hi; echo err >&2; exit 3') })
      expect(r.isError).toBeUndefined()
      expect(r.content).toBe('exit 3\nhi\nerr\n')
    })

    it.skipIf(!posix)('result carries meta.sandbox = none', async () => {
      const { call } = await boot()
      expect(await call({ command: track('true') })).toEqual({ content: 'exit 0\n', meta: { sandbox: 'none' } })
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

  describe('process-group registry', () => {
    const entries = () => (existsSync(pgidFile(dataDir)) ? parseEntries(readFileSync(pgidFile(dataDir), 'utf8')) : [])

    it.skipIf(!posix)('runShell reports spawn and close with the group id', async () => {
      const seen: string[] = []
      const r = await runShell(direct(track('echo hi'), { PATH: process.env.PATH ?? '', HOME: home }), {
        cwd, timeoutMs: 5000, signal: new AbortController().signal, platform: process.platform,
        onSpawn: pid => seen.push(`spawn:${pid}`),
        onClose: pid => seen.push(`close:${pid}`),
      })
      expect(r.code).toBe(0)
      const pid = recorded()[0]
      expect(seen).toEqual([`spawn:${pid}`, `close:${pid}`])
    })

    it.skipIf(!posix)('a throwing hook never fails the command', async () => {
      const r = await runShell(direct(track('echo hi'), { PATH: process.env.PATH ?? '', HOME: home }), {
        cwd, timeoutMs: 5000, signal: new AbortController().signal, platform: process.platform,
        onSpawn: () => { throw new Error('boom') },
        onClose: () => { throw new Error('boom') },
      })
      expect(r).toMatchObject({ code: 0, output: 'hi\n' })
    })

    it.skipIf(!posix)('a finished command leaves no entry', async () => {
      const { call } = await boot()
      const r = await call({ command: track('echo ok') })
      expect(r.content).toBe('exit 0\nok\n')
      expect(existsSync(pgidFile(dataDir))).toBe(true) // 登记过,又在结束时删掉
      expect(entries()).toEqual([])
    })

    it.skipIf(!posix)('Review Focus 5: kernel.close() kills a group the shell left running', async () => {
      const { k, call } = await boot()
      const r = await call({ command: track(`sleep 60 >/dev/null 2>&1 & echo $! > pid`) })
      expect(r.content).toBe('exit 0\n')
      const pid = pidIn('pid')
      const leader = recorded()[0]
      expect(alive(pid)).toBe(true)
      expect(entries().map(e => e.pgid)).toEqual([leader])
      await k.close()
      kernels = kernels.filter(x => x !== k)
      expect(await waitFor(() => !alive(pid), 2000)).toBe(true)
      expect(readFileSync(pgidFile(dataDir), 'utf8')).toBe('')
    })
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
    const r = await runShell(direct(track(`head -c 1500000 /dev/zero | tr '\\0' a; echo; echo TAIL-MARK`), env()), {
      cwd, timeoutMs: 20_000, signal: new AbortController().signal, platform: process.platform,
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
    const r = await runShell(direct(track(`touch '${marker}'`), env()), { cwd, timeoutMs: 5000, signal: ac.signal, platform: process.platform })
    expect(r).toMatchObject({ code: null, cancelled: true, timedOut: false })
    await sleep(100)
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(!posix)('I2: win32 path — taskkill fails / pipe stays open → the call still returns (close fallback)', async () => {
    // 在 POSIX 上用 platform:'win32' 走 Windows 分支:不建进程组,taskkill.exe 不存在 → child.kill() 只杀 sh;
    // 后台的 sleep 拿着 stdout,close 永远不来 —— 必须靠 2 s + 1 s 兜底返回
    const t0 = Date.now()
    const r = await runShell(direct(`sleep 60 & echo $! > '${join(cwd, 'pid')}'; wait`, env()), {
      cwd, timeoutMs: 200, signal: new AbortController().signal, platform: 'win32',
    })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(5000)
    process.kill(pidIn('pid'), 'SIGKILL') // 这个分支杀不到孙进程(不在单独的组里);测试自己收尾
  }, 10_000)

  it('UTF-8 is never cut mid-character when the tail is trimmed', async () => {
    const r = await runShell(direct(posix ? `node -e "process.stdout.write('€'.repeat(400000))"` : 'echo', { ...env(), PATH: process.env.PATH ?? '' }), {
      cwd, timeoutMs: 20_000, signal: new AbortController().signal, platform: process.platform,
    })
    if (posix) {
      expect(r.output).not.toContain('\uFFFD')
      expect(r.output.endsWith('€€€')).toBe(true)
    }
  })

  it.skipIf(!posix)('missing cwd → rejects', async () => {
    await expect(runShell(direct('true', env()), { cwd: join(root, 'nope'), timeoutMs: 5000, signal: new AbortController().signal, platform: process.platform })).rejects.toThrow()
  })
})

describe('sandbox plan (injected service, 05 §10)', () => {
  type Seen = { command: string; s: { sessionId: string; cwd: string; spillDir: string }; env: NodeJS.ProcessEnv }
  /** 假服务:plan 返回 /bin/sh -c 的"沙箱"计划(走 shell:false + detached 那条路),记下每次 plan 与 release */
  function fakeService(o: { reject?: Error; file?: string; level?: ShellPlan['level'] } = {}) {
    const seen: Seen[] = []
    let releases = 0
    const svc: Pick<SandboxService, 'plan' | 'status'> = {
      status: () => ({ level: 'partial', missing: ['proxy'], autoDegraded: false }),
      async plan(command, s, env) {
        seen.push({ command, s, env })
        if (o.reject) throw o.reject
        return {
          file: o.file ?? '/bin/sh', args: ['-c', command], env: { ...env, MFFAI_SANDBOX: 'full' }, sandboxed: true, level: o.level ?? 'full',
          release: () => { releases++ },
        }
      },
    }
    return { svc, seen, releases: () => releases }
  }
  const useFake = (f: ReturnType<typeof fakeService>) => {
    svcMode = { fake: f.svc }
    return f
  }

  it('without a sandbox service the shell refuses; it never runs unsandboxed', async () => {
    const marker = join(cwd, 'marker')
    const t = shellTool({ env: baseEnv(), loginPath: async () => '', minTimeoutMs: 100, sandbox: undefined as never })
    const ctx: ToolContext = { sessionId: 's', turnId: 't', callId: 'c', cwd, spillDir: join(root, 'spill'), signal: new AbortController().signal }
    const r = await t.run({ command: `touch '${marker}'` }, ctx)
    expect(r).toEqual({ content: '沙箱服务不可用,命令未执行', isError: true, meta: { sandbox: 'none' } })
    await sleep(100)
    expect(existsSync(marker)).toBe(false)
  })

  it('tools-coding injects sandbox and refuses to activate without it', () => {
    const p = createToolsCoding()
    expect(p.manifest.inject).toContain('sandbox')
    const services = new Map<string, unknown>([['tools', { register: () => () => {} }], ['permissionGate', {}]])
    const ctx = { services: { get: (k: string) => services.get(k) }, effect: () => {} } as unknown as Parameters<typeof p.activate>[0]
    expect(() => p.activate(ctx)).toThrow(/sandbox/)
  })

  it.skipIf(!posix)('a rejected plan fails the command; it never runs unsandboxed', async () => {
    const f = useFake(fakeService({ reject: new Error('profile: bad path') }))
    const { call } = await boot()
    const marker = join(cwd, 'marker')
    const r = await call({ command: track(`touch '${marker}'`) })
    expect(r).toEqual({ content: '沙箱准备失败,命令未执行:profile: bad path', isError: true, meta: { sandbox: 'partial' } })
    expect(f.seen).toHaveLength(1)
    await sleep(100)
    expect(existsSync(marker)).toBe(false)
    expect(recorded()).toEqual([])
  })

  it.skipIf(!posix)('plan gets the 03 allowlist env and the session paths; the sandboxed plan runs with shell:false in its own group, registered and released once', async () => {
    const f = useFake(fakeService())
    const { call, ctxOf } = await boot()
    const ctx = ctxOf()
    const r = await call({ command: track('echo "$MFFAI_SANDBOX"; echo $$ > leader; ps -o pgid= -p $$') }, ctx)
    expect(r.meta).toEqual({ sandbox: 'full' })
    const [, mark, pgid] = r.content.split('\n')
    expect(mark).toBe('full') // 用的是计划给的 env
    const leader = pidIn('leader')
    expect(Number(pgid.trim())).toBe(leader) // detached:/bin/sh(计划的 file)是组长
    expect(f.seen).toHaveLength(1)
    expect(f.seen[0].s).toEqual({ sessionId: ctx.sessionId, cwd: ctx.cwd, spillDir: ctx.spillDir })
    expect(f.seen[0].env.OPENAI_API_KEY).toBeUndefined()
    expect(f.seen[0].env.MFFAI).toBe('1')
    expect(f.seen[0].env.HOME).toBe(home)
    expect(f.releases()).toBe(1)
  })

  it.skipIf(!posix)('the process-group registry records the sandboxed leader; kernel.close() kills what it left running', async () => {
    useFake(fakeService())
    const { k, call } = await boot()
    const r = await call({ command: track(`sleep 60 >/dev/null 2>&1 & echo $! > pid`) })
    expect(r.content).toBe('exit 0\n')
    const pid = pidIn('pid')
    const entries = parseEntries(readFileSync(pgidFile(dataDir), 'utf8'))
    expect(entries.map(e => e.pgid)).toEqual([recorded()[0]])
    await k.close()
    kernels = kernels.filter(x => x !== k)
    expect(await waitFor(() => !alive(pid), 2000)).toBe(true)
  })

  it.skipIf(!posix)('timeout: the sandboxed grandchild dies within 2 s; release is called once', async () => {
    const f = useFake(fakeService())
    const { call } = await boot()
    const r = await call({ command: track(`sh -c 'sleep 60 & echo $! > pid; wait'`), timeoutMs: 300 })
    expect(r).toMatchObject({ isError: true, meta: { sandbox: 'full' } })
    expect(r.content.startsWith('timeout after 300 ms\n')).toBe(true)
    expect(await waitFor(() => !alive(pidIn('pid')), 2000)).toBe(true)
    expect(f.releases()).toBe(1)
  })

  it.skipIf(!posix)('cancel: the group is killed and release is called once', async () => {
    const f = useFake(fakeService())
    const { call, ctxOf } = await boot()
    const ac = new AbortController()
    const p = call({ command: track(`sh -c 'sleep 60 & echo $! > pid; wait'`), timeoutMs: 60_000 }, ctxOf(ac.signal))
    expect(await waitFor(() => existsSync(join(cwd, 'pid')) && readFileSync(join(cwd, 'pid'), 'utf8').trim() !== '')).toBe(true)
    expect(f.releases()).toBe(0) // 命令在跑:代理还被持有
    ac.abort()
    const r = await p
    expect(r.content.startsWith('已取消')).toBe(true)
    expect(await waitFor(() => !alive(pidIn('pid')), 2000)).toBe(true)
    expect(f.releases()).toBe(1)
  })

  it.skipIf(!posix)('spawn failure (sandbox binary missing): the call fails and release is called once', async () => {
    const f = useFake(fakeService({ file: join(root, 'no-such-sandbox-exec') }))
    const { call } = await boot()
    const r = await call({ command: track('true') })
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/ENOENT/)
    expect(recorded()).toEqual([])
    expect(f.releases()).toBe(1)
  })

  it.skipIf(!posix)('runShell: already-aborted and synchronous spawn errors also release exactly once', async () => {
    let n = 0
    const plan = (over: Partial<ShellPlan> = {}): ShellPlan => ({ file: '/bin/sh', args: ['-c', 'true'], env: { PATH: '/usr/bin:/bin' }, sandboxed: true, level: 'full', release: () => { n++ }, ...over })
    const ac = new AbortController()
    ac.abort()
    expect(await runShell(plan(), { cwd, timeoutMs: 5000, signal: ac.signal, platform: process.platform })).toMatchObject({ cancelled: true })
    expect(n).toBe(1)
    // env 里带 NUL → spawn 同步抛
    await expect(runShell(plan({ env: { BAD: 'a\0b' } }), { cwd, timeoutMs: 5000, signal: new AbortController().signal, platform: process.platform })).rejects.toThrow()
    expect(n).toBe(2)
    const r = await runShell(plan({ release: () => { n++; throw new Error('boom') } }), { cwd, timeoutMs: 5000, signal: new AbortController().signal, platform: process.platform })
    expect(r.code).toBe(0) // release 抛错不影响结果
    expect(n).toBe(3)
  })
})
