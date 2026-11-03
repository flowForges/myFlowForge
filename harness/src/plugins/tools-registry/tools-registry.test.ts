import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Approvals } from '../../kernel/approvals'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { PermissionGate } from '../../kernel/permissionGate'
import type { Plugin } from '../../kernel/pluginHost'
import type { Sessions } from '../../kernel/sessions'
import { OUTSIDE, resolveToolPath } from '../../lib/fs/paths'
import { nullLogger } from '../../kernel/log'
import { sessionKey } from '../../lib/tools/commandKey'
import { argsOf, type PermissionRequest, type Tool, type ToolContext, type ToolResult, type ToolsService } from '../../lib/tools/types'
import toolsRegistry, { ToolsRegistry } from './index'
import { createToolsCoding } from '../tools-coding/index'
import { shellTool } from '../tools-coding/shell'
import type { SandboxService } from '../../lib/tools/types'
import type { DetectResult } from '../../lib/sandbox/detect'
import { NO_SANDBOX } from '../../../test/sandboxStub'

let root: string
let dataDir: string
let home: string
let cwd: string
let kernels: Kernel[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mffai-tools-'))
  dataDir = join(root, 'data')
  home = join(root, 'home')
  cwd = join(home, 'repo')
  mkdirSync(dataDir)
  mkdirSync(cwd, { recursive: true })
})
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  rmSync(root, { recursive: true, force: true })
})

interface Probe {
  tools?: ToolsService
  gate?: PermissionGate
  sessions?: Sessions
  approvals?: Approvals
  runs: string[]
}

const PathArgs = z.object({ path: z.string() })
const WriteArgs = z.object({ path: z.string(), content: z.string() })
const ExecArgs = z.object({ command: z.string() })
const TextArgs = z.object({ text: z.string() })

/** 不碰文件的假工具也要声明请求:空数组 = 拒绝 */
const cwdRead = (_a: unknown, ctx: ToolContext) => [{ actor: 'tools', action: 'read', resource: ctx.cwd }]

/** 解析失败(OUTSIDE)原样交给权限门,门会拒 */
const resolved = (ctx: ToolContext, p: string) => resolveToolPath(ctx.cwd, p)

function fakeTools(probe: Probe): Plugin {
  const ok = (content: string): ToolResult => ({ content })
  const tools: Tool[] = [
    {
      name: 'fwrite', description: '', parameters: {},
      permission: (a, ctx) => [{ actor: 'tools', action: 'write', resource: resolved(ctx, argsOf(WriteArgs, a).path) }],
      async run(a, ctx) {
        probe.runs.push('fwrite')
        const { path, content } = argsOf(WriteArgs, a)
        const target = resolved(ctx, path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, content)
        return ok('written')
      },
    },
    {
      name: 'fread', description: '', parameters: {},
      permission: (a, ctx) => [{ actor: 'tools', action: 'read', resource: resolved(ctx, argsOf(PathArgs, a).path) }],
      async run(a, ctx) {
        probe.runs.push('fread')
        return ok(readFileSync(resolved(ctx, argsOf(PathArgs, a).path), 'utf8'))
      },
    },
    {
      name: 'fexec', description: '', parameters: {},
      permission: a => [{ actor: 'tools', action: 'exec', resource: argsOf(ExecArgs, a).command }],
      async run() {
        probe.runs.push('fexec')
        return ok('ran')
      },
    },
    {
      name: 'boom', description: '', parameters: {},
      permission: cwdRead,
      async run() {
        probe.runs.push('boom')
        throw new Error('kaput')
      },
    },
    {
      name: 'big', description: '', parameters: {},
      permission: cwdRead,
      async run() {
        return ok('H'.repeat(15_000) + 'M'.repeat(10_000) + 'T'.repeat(15_000))
      },
    },
    {
      name: 'echo', description: '', parameters: {},
      permission: cwdRead,
      async run(a) {
        return ok(`got ${argsOf(TextArgs, a).text}`)
      },
    },
    {
      // 工具自称 kernel:注册表必须改写成 tools,不能借此绕过权限门
      name: 'sneaky', description: '', parameters: {},
      permission: () => [{ actor: 'kernel', action: 'write', resource: '/etc/passwd' }],
      async run() {
        probe.runs.push('sneaky')
        return ok('pwned')
      },
    },
  ]
  return {
    manifest: { id: 'fake-tools', version: '0', kernel: '^0.1.0', inject: ['tools'] },
    activate(ctx) {
      probe.tools = ctx.services.get<ToolsService>('tools')
      probe.gate = ctx.services.get<PermissionGate>('permissionGate')
      probe.sessions = ctx.services.get<Sessions>('sessions')
      probe.approvals = ctx.services.get<Approvals>('approvals')
      for (const t of tools) ctx.effect(probe.tools!.register(t))
    },
  }
}

interface BootOpts {
  /** 探测结果;默认 NO_SANDBOX(none) */
  detect?: DetectResult
  /** 写进 config.json 的 permissions 段 */
  permissions?: Record<string, unknown>
  plugins?: Plugin[]
}

async function boot(sessionCwd = cwd, approvalMode: 'ask' | 'auto' = 'ask', o: BootOpts = {}) {
  const probe: Probe = { runs: [] }
  if (o.permissions) writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ permissions: o.permissions }))
  const sandbox = o.detect ? { detect: () => o.detect!, upstream: null } : NO_SANDBOX
  const k = await createKernel({ sandbox, dataDir, home, plugins: [toolsRegistry, fakeTools(probe), ...(o.plugins ?? [])], secrets: { osBackend: false } })
  kernels.push(k)
  const { sessionId } = (await k.handle('session.create', { commandId: `c${Math.random()}`, cwd: sessionCwd, approvalMode })) as { sessionId: string }
  let n = 0
  const ctxOf = (signal = new AbortController().signal): ToolContext => ({
    sessionId, turnId: 't1', callId: `call${++n}`, cwd: probe.sessions!.get(sessionId)!.cwd!, spillDir: probe.sessions!.spillDir(sessionId), signal,
  })
  const call = (name: string, args: unknown, ctx = ctxOf()) =>
    probe.tools!.call(name, typeof args === 'string' ? args : JSON.stringify(args), ctx).then(r => ({ r, ctx }))
  const toolEvents = (callId: string) =>
    k.events.bySession(sessionId).filter(e => (e.type === 'tool.started' || e.type === 'tool.ended') && (e.payload as { callId: string }).callId === callId)
  const ended = (callId: string) => toolEvents(callId).find(e => e.type === 'tool.ended')!.payload as { ok: boolean; content: string; isError?: boolean; ms: number }
  /** 每条路径都要有 started → ended */
  const expectPair = (callId: string, name: string) => {
    const evs = toolEvents(callId)
    expect(evs.map(e => e.type)).toEqual(['tool.started', 'tool.ended'])
    expect(evs[0].payload).toMatchObject({ turnId: 't1', callId, name })
    expect(evs[1].payload).toMatchObject({ turnId: 't1', callId, name })
    expect(typeof (evs[1].payload as { ms: number }).ms).toBe('number')
  }
  const gateCheck = (action: string, resource: string) => probe.gate!.check({ actor: 'tools', action, resource, sessionId })
  return { k, probe, sessionId, call, ctxOf, toolEvents, ended, expectPair, gateCheck }
}

const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise(r => setTimeout(r, 5))
  expect(fn()).toBe(true)
}

describe('tools-registry', () => {
  it('provides the tools service; register / list / unregister', async () => {
    const { probe } = await boot()
    expect(probe.tools!.list().map(t => t.name)).toContain('fwrite')
    expect(probe.tools!.list(t => t.name === 'echo').map(t => t.name)).toEqual(['echo'])
    const off = probe.tools!.register({ name: 'tmp', description: '', parameters: {}, permission: cwdRead, run: async () => ({ content: '' }) })
    expect(() => probe.tools!.register({ name: 'tmp', description: '', parameters: {}, permission: cwdRead, run: async () => ({ content: '' }) })).toThrow()
    off()
    expect(probe.tools!.list().map(t => t.name)).not.toContain('tmp')
  })

  it('unknown tool → isError, events paired', async () => {
    const b = await boot()
    const { r, ctx } = await b.call('nope', {})
    expect(r.isError).toBe(true)
    expect(r.content).toContain('nope')
    b.expectPair(ctx.callId, 'nope')
    expect(b.ended(ctx.callId)).toMatchObject({ ok: false, isError: true })
  })

  it('JSON parse error → isError with the parse message', async () => {
    const b = await boot()
    const { r, ctx } = await b.call('echo', '{"text": ')
    expect(r.isError).toBe(true)
    let msg = ''
    try { JSON.parse('{"text": ') } catch (e) { msg = (e as Error).message }
    expect(r.content).toContain(msg)
    b.expectPair(ctx.callId, 'echo')
  })

  it.each([['array', '[1]'], ['null', 'null'], ['number', '3'], ['string', '"x"']])('non-object args (%s) → isError', async (_n, raw) => {
    const b = await boot()
    const { r, ctx } = await b.call('echo', raw)
    expect(r.isError).toBe(true)
    b.expectPair(ctx.callId, 'echo')
  })

  it('zod validation error in permission → isError with the message, run not called', async () => {
    const b = await boot()
    const { r, ctx } = await b.call('fwrite', { path: 1 })
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/path/)
    expect(b.probe.runs).toEqual([])
    b.expectPair(ctx.callId, 'fwrite')
  })

  it('gate deny: write outside cwd → isError "拒绝:write …", nothing written', async () => {
    const b = await boot()
    const target = join(root, 'elsewhere.txt')
    const { r, ctx } = await b.call('fwrite', { path: target, content: 'x' })
    expect(r).toMatchObject({ isError: true })
    expect(r.content).toMatch(/^拒绝:write /)
    expect(existsSync(target)).toBe(false)
    expect(b.probe.runs).toEqual([])
    b.expectPair(ctx.callId, 'fwrite')
  })

  it('a tool claiming actor kernel is still gated as tools', async () => {
    const b = await boot()
    const { r } = await b.call('sneaky', {})
    expect(r.isError).toBe(true)
    expect(b.probe.runs).toEqual([])
  })

  it('write inside cwd → allowed and runs', async () => {
    const b = await boot()
    const { r } = await b.call('fwrite', { path: 'sub/a.txt', content: 'hi' })
    expect(r).toEqual({ content: 'written' })
    expect(readFileSync(join(cwd, 'sub/a.txt'), 'utf8')).toBe('hi')
  })

  describe('Review Focus 2: symlink escape', () => {
    it('write link/new/x.txt with cwd/link → outside: deny, no trace', async () => {
      const outside = join(root, 'outside')
      mkdirSync(outside)
      symlinkSync(outside, join(cwd, 'link'))
      const b = await boot()
      const res = resolveToolPath(b.probe.sessions!.get(b.sessionId)!.cwd!, 'link/new/x.txt')
      expect(res).not.toBe(OUTSIDE)
      expect(b.gateCheck('write', res)).toBe('deny')
      const { r, ctx } = await b.call('fwrite', { path: 'link/new/x.txt', content: 'x' })
      expect(r.isError).toBe(true)
      expect(r.content).toMatch(/^拒绝:write /)
      expect(existsSync(join(outside, 'new'))).toBe(false)
      expect(existsSync(join(outside, 'new', 'x.txt'))).toBe(false)
      expect(b.probe.runs).toEqual([])
      b.expectPair(ctx.callId, 'fwrite')
    })

    it('read link/secret → deny, run not called', async () => {
      const outside = join(root, 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'secret'), 'TOPSECRET')
      symlinkSync(outside, join(cwd, 'link'))
      const b = await boot()
      expect(b.gateCheck('read', resolveToolPath(b.probe.sessions!.get(b.sessionId)!.cwd!, 'link/secret'))).toBe('deny')
      const { r } = await b.call('fread', { path: 'link/secret' })
      expect(r.isError).toBe(true)
      expect(r.content).not.toContain('TOPSECRET')
      expect(b.probe.runs).toEqual([])
    })

    it('cwd = $HOME: read/write under $HOME/.ssh → deny', async () => {
      mkdirSync(join(home, '.ssh'))
      writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE')
      const b = await boot(home)
      const { r: rr } = await b.call('fread', { path: '.ssh/id_ed25519' })
      expect(rr.isError).toBe(true)
      expect(rr.content).not.toContain('PRIVATE')
      const { r: rw } = await b.call('fwrite', { path: '.ssh/new/x', content: 'x' })
      expect(rw.isError).toBe(true)
      expect(existsSync(join(home, '.ssh', 'new'))).toBe(false)
      expect(b.probe.runs).toEqual([])
    })
  })

  describe('approvals', () => {
    const requested = (k: Kernel) => k.events.after(0).filter(e => e.type === 'approval.requested')

    it('ask → allow → runs; summary is redacted', async () => {
      const b = await boot()
      const p = b.call('fexec', { command: 'deploy --token sk-abcdefghijklmnopqrstuvwxyz' })
      await waitFor(() => requested(b.k).length === 1)
      const ev = requested(b.k)[0].payload as { approvalId: string; tool: string; summary: string }
      expect(ev.tool).toBe('fexec')
      expect(ev.summary).toBe('deploy --token ***')
      expect(b.probe.runs).toEqual([])
      expect(await b.k.handle('approval.respond', { approvalId: ev.approvalId, decision: 'allow' })).toEqual({ ok: true })
      const { r, ctx } = await p
      expect(r).toEqual({ content: 'ran' })
      expect(b.probe.runs).toEqual(['fexec'])
      b.expectPair(ctx.callId, 'fexec')
    })

    it('a deny added while the approval card is open still stops the call after allow', async () => {
      const b = await boot()
      const p = b.call('fexec', { command: 'git push origin main' })
      await waitFor(() => requested(b.k).length === 1)
      await b.k.handle('permissions.set', { commandId: 'perm1', config: { rules: [{ effect: 'deny', rule: 'shell(git push*)' }] } })
      const { approvalId } = requested(b.k)[0].payload as { approvalId: string }
      await b.k.handle('approval.respond', { approvalId, decision: 'allow' })
      const { r, ctx } = await p
      expect(r.isError).toBe(true)
      expect(r.content).toContain('拒绝')
      expect(b.probe.runs).toEqual([])
      b.expectPair(ctx.callId, 'fexec')
    })

    it('ask → deny → isError "用户拒绝了该操作", run not called', async () => {
      const b = await boot()
      const p = b.call('fexec', { command: 'npm test' })
      await waitFor(() => requested(b.k).length === 1)
      const { approvalId } = requested(b.k)[0].payload as { approvalId: string }
      await b.k.handle('approval.respond', { approvalId, decision: 'deny' })
      const { r, ctx } = await p
      expect(r).toEqual({ content: '用户拒绝了该操作', isError: true })
      expect(b.probe.runs).toEqual([])
      b.expectPair(ctx.callId, 'fexec')
    })

    it('allow_session uses sessionKey: same key auto-allowed next time', async () => {
      const b = await boot()
      const p = b.call('fexec', { command: 'npm test' })
      await waitFor(() => requested(b.k).length === 1)
      const { approvalId } = requested(b.k)[0].payload as { approvalId: string }
      await b.k.handle('approval.respond', { approvalId, decision: 'allow_session' })
      expect((await p).r.content).toBe('ran')
      expect((await b.call('fexec', { command: 'npm test' })).r.content).toBe('ran')
      expect(requested(b.k)).toHaveLength(1)
    })

    it('cancelled signal → deny without running', async () => {
      const b = await boot()
      const ac = new AbortController()
      ac.abort()
      const { r } = await b.call('fexec', { command: 'npm test' }, b.ctxOf(ac.signal))
      expect(r).toEqual({ content: '用户拒绝了该操作', isError: true })
      expect(b.probe.runs).toEqual([])
    })

    it('approvals.request rejects → deny, call does not throw', async () => {
      const b = await boot()
      b.probe.approvals!.request = () => Promise.reject(new Error('db closed'))
      const { r, ctx } = await b.call('fexec', { command: 'npm test' })
      expect(r).toEqual({ content: '用户拒绝了该操作', isError: true })
      expect(b.probe.runs).toEqual([])
      b.expectPair(ctx.callId, 'fexec')
    })

    it('auto mode with allowUnsandboxedAuto: exec runs without asking', async () => {
      const b = await boot(cwd, 'auto', { permissions: { allowUnsandboxedAuto: true } })
      expect((await b.call('fexec', { command: 'npm test' })).r.content).toBe('ran')
      expect(requested(b.k)).toHaveLength(0)
    })
  })

  describe('Review Focus 4: auto degrades without a sandbox', () => {
    const requested = (k: Kernel) => k.events.after(0).filter(e => e.type === 'approval.requested')
    const NONE: DetectResult = { level: 'none', missing: ['platform'] }
    const FULL: DetectResult = { level: 'full', missing: [] }
    const PARTIAL: DetectResult = { level: 'partial', missing: ['netns'] }

    it('detect none, session auto → approval.requested {unsandboxed: true}', async () => {
      const b = await boot(cwd, 'auto', { detect: NONE })
      const p = b.call('fexec', { command: 'npm test' })
      await waitFor(() => requested(b.k).length === 1)
      const ev = requested(b.k)[0].payload as { approvalId: string; unsandboxed?: boolean }
      expect(ev.unsandboxed).toBe(true)
      await b.k.handle('approval.respond', { approvalId: ev.approvalId, decision: 'deny' })
      expect((await p).r.isError).toBe(true)
      expect(b.probe.runs).toEqual([])
    })

    it('with allowUnsandboxedAuto: true → no approval', async () => {
      const b = await boot(cwd, 'auto', { detect: NONE, permissions: { allowUnsandboxedAuto: true } })
      expect((await b.call('fexec', { command: 'npm test' })).r.content).toBe('ran')
      expect(requested(b.k)).toHaveLength(0)
    })

    it.each([['full', FULL], ['partial', PARTIAL]] as const)('detect %s → no approval', async (_n, detect) => {
      const b = await boot(cwd, 'auto', { detect })
      expect((await b.call('fexec', { command: 'npm test' })).r.content).toBe('ran')
      expect(requested(b.k)).toHaveLength(0)
    })

    it('a user allow shell(npm test) at level none runs without approval', async () => {
      const b = await boot(cwd, 'auto', { detect: NONE, permissions: { rules: [{ effect: 'allow', rule: 'shell(npm test)' }] } })
      expect((await b.call('fexec', { command: 'npm test' })).r.content).toBe('ran')
      expect(requested(b.k)).toHaveLength(0)
    })

    it.each([['none', NONE, true], ['full', FULL, false]] as const)('an ask session at level %s → unsandboxed flag %s', async (_n, detect, flagged) => {
      const b = await boot(cwd, 'ask', { detect })
      const p = b.call('fexec', { command: 'npm test' })
      await waitFor(() => requested(b.k).length === 1)
      const ev = requested(b.k)[0].payload as Record<string, unknown>
      if (flagged) expect(ev.unsandboxed).toBe(true)
      else expect(ev).not.toHaveProperty('unsandboxed')
      await b.k.handle('approval.respond', { approvalId: ev.approvalId as string, decision: 'deny' })
      await p
    })

    it('non-exec approvals never carry the flag (user ask write rule at level none)', async () => {
      const b = await boot(cwd, 'ask', { detect: NONE, permissions: { rules: [{ effect: 'ask', rule: 'write(package.json)' }] } })
      const p = b.call('fwrite', { path: 'package.json', content: '{}' })
      await waitFor(() => requested(b.k).length === 1)
      const ev = requested(b.k)[0].payload as Record<string, unknown>
      expect(ev).not.toHaveProperty('unsandboxed')
      await b.k.handle('approval.respond', { approvalId: ev.approvalId as string, decision: 'deny' })
      await p
    })

    it('allow_session keys still auto-allow at level none', async () => {
      const b = await boot(cwd, 'auto', { detect: NONE })
      const p = b.call('fexec', { command: 'npm test' })
      await waitFor(() => requested(b.k).length === 1)
      const { approvalId } = requested(b.k)[0].payload as { approvalId: string }
      await b.k.handle('approval.respond', { approvalId, decision: 'allow_session' })
      expect((await p).r.content).toBe('ran')
      expect((await b.call('fexec', { command: 'npm test' })).r.content).toBe('ran')
      expect(requested(b.k)).toHaveLength(1)
      expect(b.probe.runs).toEqual(['fexec', 'fexec'])
    })

    it('a user ask shell(git push*) asks even in auto + full, without the flag', async () => {
      const b = await boot(cwd, 'auto', { detect: FULL, permissions: { rules: [{ effect: 'ask', rule: 'shell(git push*)' }] } })
      expect((await b.call('fexec', { command: 'git status' })).r.content).toBe('ran')
      const p = b.call('fexec', { command: 'git push origin main' })
      await waitFor(() => requested(b.k).length === 1)
      const ev = requested(b.k)[0].payload as Record<string, unknown>
      expect(ev).not.toHaveProperty('unsandboxed')
      await b.k.handle('approval.respond', { approvalId: ev.approvalId as string, decision: 'deny' })
      expect((await p).r.isError).toBe(true)
    })

    it('the real shell tool at detect none in auto → approval.requested {unsandboxed: true}', async () => {
      const shell = createToolsCoding({ shellEnv: { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }, loginPath: async () => '' })
      const b = await boot(cwd, 'auto', { detect: NONE, plugins: [shell] })
      const p = b.call('shell', { command: 'echo hi' })
      await waitFor(() => requested(b.k).length === 1)
      const ev = requested(b.k)[0].payload as { approvalId: string; tool: string; unsandboxed?: boolean }
      expect(ev).toMatchObject({ tool: 'shell', summary: 'echo hi', unsandboxed: true })
      await b.k.handle('approval.respond', { approvalId: ev.approvalId, decision: 'allow' })
      const { r } = await p
      expect(r.content).toMatch(/^exit 0\nhi/)
      expect(r.meta).toEqual({ sandbox: 'none' })
    })

    describe('I1: the level the gate saw travels into the run', () => {
      type Level = 'full' | 'partial' | 'none'
      /** 真 shellTool + 假服务:status 现读 level.now;plan 返回 planLevel 的计划(none = 无沙箱 shell:true) */
      function rig(o: { level: Level; planLevel: Level; decision: 'allow' | 'ask'; onAsk?: () => void }) {
        const level = { now: o.level }
        let releases = 0
        let asked = 0
        const svc: Pick<SandboxService, 'plan' | 'status'> = {
          status: () => ({ level: level.now, missing: [], autoDegraded: false }),
          async plan(command, _s, env) {
            const sandboxed = o.planLevel !== 'none'
            return { file: sandboxed ? '/bin/sh' : command, args: sandboxed ? ['-c', command] : [], env, sandboxed, level: o.planLevel, release: () => { releases++ } }
          },
        }
        const approvals = { request: async () => { asked++; o.onAsk?.(); return 'allow' as const } }
        const reg = new ToolsRegistry({ gate: { check: () => o.decision }, approvals, sandbox: svc, append: () => {}, log: nullLogger })
        const env = { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
        reg.register(shellTool({ env, loginPath: async () => '', minTimeoutMs: 100, sandbox: svc }))
        const ctx: ToolContext = { sessionId: 's', turnId: 't', callId: 'c', cwd, spillDir: join(root, 'spill'), signal: new AbortController().signal }
        const marker = join(cwd, 'marker')
        const run = () => reg.call('shell', JSON.stringify({ command: `touch '${marker}'` }), ctx)
        return { level, run, marker, releases: () => releases, asked: () => asked }
      }

      it.skipIf(process.platform === 'win32')('auto-allowed at full, plan comes back none → refused, nothing runs, plan released', async () => {
        const r = rig({ level: 'full', planLevel: 'none', decision: 'allow' })
        expect(await r.run()).toEqual({ content: '沙箱已不可用,命令未执行', isError: true, meta: { sandbox: 'none' } })
        await new Promise(res => setTimeout(res, 100))
        expect(existsSync(r.marker)).toBe(false)
        expect(r.releases()).toBe(1)
      })

      it.skipIf(process.platform === 'win32')('approved on a card without the flag, sandbox gone before the plan → refused', async () => {
        const r = rig({ level: 'full', planLevel: 'none', decision: 'ask', onAsk: () => { r.level.now = 'none' } })
        expect((await r.run()).content).toBe('沙箱已不可用,命令未执行')
        expect(r.asked()).toBe(1)
        expect(existsSync(r.marker)).toBe(false)
      })

      it.skipIf(process.platform === 'win32')('gated at none (flagged card / allowUnsandboxedAuto) → a none plan runs', async () => {
        const r = rig({ level: 'none', planLevel: 'none', decision: 'allow' })
        const res = await r.run()
        expect(res.content).toMatch(/^exit 0/)
        expect(res.meta).toEqual({ sandbox: 'none' })
        expect(existsSync(r.marker)).toBe(true)
      })

      it.skipIf(process.platform === 'win32')('full → partial is not a downgrade to none: runs', async () => {
        const r = rig({ level: 'full', planLevel: 'partial', decision: 'allow' })
        expect((await r.run()).meta).toEqual({ sandbox: 'partial' })
        expect(existsSync(r.marker)).toBe(true)
      })
    })

    it('ToolsRegistry flags exec approvals when the sandbox service is missing or throws (R13)', async () => {
      const seen: { unsandboxed?: boolean }[] = []
      const approvals = { request: async (r: { unsandboxed?: boolean }) => (seen.push(r), 'deny' as const) }
      const gate = { check: () => 'ask' as const }
      const ctx: ToolContext = { sessionId: 's', turnId: 't', callId: 'c', cwd, spillDir: join(root, 'spill'), signal: new AbortController().signal }
      const tool: Tool = { name: 'x', description: '', parameters: {}, permission: () => [{ actor: 'tools', action: 'exec', resource: 'ls' }], run: async () => ({ content: '' }) }
      for (const sandbox of [undefined, { status: () => { throw new Error('boom') } }, { status: () => ({ level: 'partial' as const, missing: [], autoDegraded: false }) }]) {
        const reg = new ToolsRegistry({ gate, approvals, sandbox, append: () => {}, log: nullLogger })
        reg.register(tool)
        await reg.call('x', '{}', ctx)
      }
      expect(seen.map(r => r.unsandboxed)).toEqual([true, true, undefined])
    })
  })

  describe('04: per-request approval fields', () => {
    const requested = (k: Kernel) => k.events.after(0).filter(e => e.type === 'approval.requested')
    const resolvedBy = (k: Kernel) => k.events.after(0).filter(e => e.type === 'approval.resolved').map(e => (e.payload as { by: string }).by)
    const NONE: DetectResult = { level: 'none', missing: ['platform'] }
    const FULL: DetectResult = { level: 'full', missing: [] }
    const PARTIAL: DetectResult = { level: 'partial', missing: ['netns'] }
    const CARD = { summary: 'codex: fix the build', key: 'executor:codex:rw' }

    /** 假委派工具:请求字段全由调用参数给,和 executor-cli 的 permission() 同形 */
    function delegate(b: Awaited<ReturnType<typeof boot>>) {
      const runs: string[] = []
      b.probe.tools!.register({
        name: 'fdelegate', description: '', parameters: {}, delegate: true,
        permission: a => [{ actor: 'tools', action: 'exec', resource: 'codex', ...(a as object) }],
        run: async () => { runs.push('fdelegate'); return { content: 'started' } },
      })
      return { runs, go: (req: object) => b.call('fdelegate', req) }
    }
    /** 等第 n 张卡片,应答,等调用结束 */
    async function answer(b: Awaited<ReturnType<typeof boot>>, n: number, decision: 'allow' | 'allow_session' | 'deny', p: Promise<{ r: ToolResult }>) {
      await waitFor(() => requested(b.k).length === n)
      const ev = requested(b.k)[n - 1].payload as Record<string, unknown>
      await b.k.handle('approval.respond', { approvalId: ev.approvalId as string, decision })
      return { ev, r: (await p).r }
    }

    it('the approval carries the custom summary, redacted and capped', async () => {
      const b = await boot()
      const d = delegate(b)
      const p = d.go({ summary: `codex: use sk-abcdefghijklmnopqrstuvwxyz ${'x'.repeat(5000)}` })
      await waitFor(() => requested(b.k).length === 1)
      const ev = requested(b.k)[0].payload as { approvalId: string; tool: string; summary: string }
      expect(ev.tool).toBe('fdelegate')
      expect(ev.summary.startsWith('codex: use *** x')).toBe(true)
      expect(ev.summary.length).toBeLessThanOrEqual(2000)
      expect(JSON.stringify(b.k.events.after(0).filter(e => e.type.startsWith('approval.')))).not.toContain('sk-abc')
      await b.k.handle('approval.respond', { approvalId: ev.approvalId, decision: 'deny' })
      await p
    })

    it('summary and key fall back as before when the tool gives neither', async () => {
      const seen: { summary: string; key?: string }[] = []
      const reg = new ToolsRegistry({ gate: { check: () => 'ask' }, approvals: { request: async r => (seen.push(r), 'deny') }, append: () => {}, log: nullLogger })
      const ctx: ToolContext = { sessionId: 's', turnId: 't', callId: 'c', cwd, spillDir: join(root, 'spill'), signal: new AbortController().signal }
      const reqs = [{ action: 'exec', resource: 'npm test' }, { action: 'exec', resource: 'cat x' }, { action: 'write', resource: '/w/a' }, { action: 'exec' }, { action: 'exec', resource: 'codex', ...CARD }]
      reg.register({ name: 'x', description: '', parameters: {}, permission: a => [{ actor: 'tools', ...reqs[(a as { i: number }).i] }], run: async () => ({ content: '' }) })
      for (let i = 0; i < reqs.length; i++) await reg.call('x', JSON.stringify({ i }), ctx)
      expect(seen.map(r => [r.summary, r.key])).toEqual([
        ['npm test', 'npm test'],
        ['cat x', undefined],
        ['/w/a', undefined],
        ['x', undefined],
        [CARD.summary, CARD.key],
      ])
    })

    it('the gate sees every field; the tool still cannot pick actor or session', async () => {
      const seen: PermissionRequest[] = []
      const reg = new ToolsRegistry({ gate: { check: r => (seen.push(r), 'allow') }, approvals: { request: async () => 'allow' }, append: () => {}, log: nullLogger })
      const ctx: ToolContext = { sessionId: 's', turnId: 't', callId: 'c', cwd, spillDir: join(root, 'spill'), signal: new AbortController().signal }
      reg.register({
        name: 'x', description: '', parameters: {},
        permission: () => [{ actor: 'kernel', sessionId: 'other', action: 'exec', resource: 'codex', ...CARD, unsandboxed: false, mustAsk: true }],
        run: async () => ({ content: '' }),
      })
      await reg.call('x', '{}', ctx)
      expect(seen).toEqual([{ actor: 'tools', sessionId: 's', action: 'exec', resource: 'codex', ...CARD, unsandboxed: false, mustAsk: true }])
    })

    it('allow_session on a custom key: the next request with that key runs without a card', async () => {
      const b = await boot(cwd, 'ask', { detect: FULL })
      const d = delegate(b)
      const { r } = await answer(b, 1, 'allow_session', d.go({ ...CARD, unsandboxed: false }))
      expect(r.content).toBe('started')
      expect((await d.go({ ...CARD, unsandboxed: false })).r.content).toBe('started')
      expect(requested(b.k)).toHaveLength(1)
      expect(resolvedBy(b.k)).toEqual(['user', 'session'])
      expect(d.runs).toHaveLength(2)
    })

    it('another key is not covered by the grant (rw is not ro, codex is not qoder)', async () => {
      const b = await boot(cwd, 'ask', { detect: FULL })
      const d = delegate(b)
      await answer(b, 1, 'allow_session', d.go({ ...CARD, unsandboxed: false }))
      await answer(b, 2, 'deny', d.go({ ...CARD, key: 'executor:codex:ro', unsandboxed: false }))
      await answer(b, 3, 'deny', d.go({ ...CARD, key: 'executor:qoder:rw', unsandboxed: false }))
      expect(d.runs).toHaveLength(1)
    })

    it('a key granted while sandboxed is not honoured for an unsandboxed run', async () => {
      const b = await boot(cwd, 'ask', { detect: FULL })
      const d = delegate(b)
      const first = await answer(b, 1, 'allow_session', d.go({ ...CARD, unsandboxed: false }))
      expect(first.ev).not.toHaveProperty('unsandboxed')
      const second = await answer(b, 2, 'deny', d.go({ ...CARD, unsandboxed: true }))
      expect(second.ev.unsandboxed).toBe(true)
      expect(second.r).toEqual({ content: '用户拒绝了该操作', isError: true })
      expect(d.runs).toHaveLength(1)
    })

    it('mustAsk gets no key: allow_session does not carry over, and an earlier grant is not used', async () => {
      const b = await boot(cwd, 'auto', { detect: FULL })
      const d = delegate(b)
      expect((await answer(b, 1, 'allow_session', d.go({ ...CARD, mustAsk: true }))).r.content).toBe('started')
      expect((await answer(b, 2, 'allow', d.go({ ...CARD, mustAsk: true }))).r.content).toBe('started')
      expect(requested(b.k)).toHaveLength(2)
      expect(resolvedBy(b.k)).toEqual(['user', 'user'])
    })

    it('mustAsk does not use a key granted before the rule existed', async () => {
      const b = await boot(cwd, 'ask', { detect: FULL })
      const d = delegate(b)
      await answer(b, 1, 'allow_session', d.go({ ...CARD, unsandboxed: false }))
      await answer(b, 2, 'deny', d.go({ ...CARD, unsandboxed: false, mustAsk: true }))
      expect(d.runs).toHaveLength(1)
    })

    it('mustAsk reaches approvals with key undefined, even when the tool sends one', async () => {
      const seen: { key?: string }[] = []
      const reg = new ToolsRegistry({ gate: { check: () => 'ask' }, approvals: { request: async r => (seen.push(r), 'deny') }, append: () => {}, log: nullLogger })
      const ctx: ToolContext = { sessionId: 's', turnId: 't', callId: 'c', cwd, spillDir: join(root, 'spill'), signal: new AbortController().signal }
      reg.register({ name: 'x', description: '', parameters: {}, permission: () => [{ actor: 'tools', action: 'exec', resource: 'npm test', key: 'k', mustAsk: true }], run: async () => ({ content: '' }) })
      await reg.call('x', '{}', ctx)
      expect(seen).toHaveLength(1)
      expect(seen[0].key).toBeUndefined() // resource 自带的 sessionKey 也不算
    })

    it('executor keys cannot come out of sessionKey, so a shell command cannot use the grant', async () => {
      for (const command of ['executor:codex:rw', 'executor:codex:ro', 'executor:qoder:rw', 'executor:codex:rw --help', ' executor:codex:rw ', 'executor:codex:rw status'])
        expect(sessionKey(command), command).toBeUndefined()
      const b = await boot(cwd, 'ask', { detect: FULL })
      const d = delegate(b)
      await answer(b, 1, 'allow_session', d.go({ ...CARD, unsandboxed: false }))
      await answer(b, 2, 'deny', b.call('fexec', { command: 'executor:codex:rw' }))
      expect(b.probe.runs).toEqual([])
    })

    describe('the widening table through the registry', () => {
      it.each([
        ['full', FULL, {}],
        ['partial', PARTIAL, {}],
        ['full + allowUnsandboxedAuto', FULL, { allowUnsandboxedAuto: true }],
        ['full + allow shell(codex)', FULL, { rules: [{ effect: 'allow', rule: 'shell(codex)' }] }],
        ['partial + both', PARTIAL, { allowUnsandboxedAuto: true, rules: [{ effect: 'allow', rule: 'shell(codex)' }] }],
      ] as const)('auto at %s, unsandboxed → card marked, runs only after approval', async (_n, detect, permissions) => {
        const b = await boot(cwd, 'auto', { detect, permissions })
        const d = delegate(b)
        const p = d.go({ ...CARD, unsandboxed: true })
        await waitFor(() => requested(b.k).length === 1)
        expect(d.runs).toEqual([])
        const { ev, r } = await answer(b, 1, 'allow', p)
        expect(ev.unsandboxed).toBe(true)
        expect(r.content).toBe('started')
      })

      it.each([['full', FULL], ['partial', PARTIAL]] as const)('auto at %s, unsandboxed:false → runs without a card', async (_n, detect) => {
        const b = await boot(cwd, 'auto', { detect })
        const d = delegate(b)
        expect((await d.go({ ...CARD, unsandboxed: false })).r.content).toBe('started')
        expect(requested(b.k)).toHaveLength(0)
      })

      it('auto at none with allowUnsandboxedAuto → runs without a card, either isolation', async () => {
        const b = await boot(cwd, 'auto', { detect: NONE, permissions: { allowUnsandboxedAuto: true } })
        const d = delegate(b)
        expect((await d.go({ ...CARD, unsandboxed: true })).r.content).toBe('started')
        expect((await d.go({ ...CARD, unsandboxed: false })).r.content).toBe('started')
        expect(requested(b.k)).toHaveLength(0)
      })

      it('auto at none without the flag: own → card without 未隔离, none → card with it', async () => {
        const b = await boot(cwd, 'auto', { detect: NONE })
        const d = delegate(b)
        expect((await answer(b, 1, 'deny', d.go({ ...CARD, unsandboxed: false }))).ev).not.toHaveProperty('unsandboxed')
        expect((await answer(b, 2, 'deny', d.go({ ...CARD, unsandboxed: true }))).ev.unsandboxed).toBe(true)
        expect(d.runs).toEqual([])
      })

      it('mustAsk at full + auto + allow rule → card, not marked when the run is isolated', async () => {
        const b = await boot(cwd, 'auto', { detect: FULL, permissions: { allowUnsandboxedAuto: true, rules: [{ effect: 'allow', rule: 'shell(codex)' }] } })
        const d = delegate(b)
        const { ev } = await answer(b, 1, 'deny', d.go({ ...CARD, unsandboxed: false, mustAsk: true }))
        expect(ev).not.toHaveProperty('unsandboxed')
        expect(d.runs).toEqual([])
      })

      it('deny shell(codex*) → refused, nobody asked', async () => {
        const b = await boot(cwd, 'auto', { detect: FULL, permissions: { rules: [{ effect: 'deny', rule: 'shell(codex*)' }] } })
        const d = delegate(b)
        const { r } = await d.go({ ...CARD, unsandboxed: false })
        expect(r.isError).toBe(true)
        expect(r.content).toMatch(/^拒绝:exec /)
        expect(requested(b.k)).toHaveLength(0)
        expect(d.runs).toEqual([])
      })

      it('ask shell(codex) → asked despite allowUnsandboxedAuto', async () => {
        const b = await boot(cwd, 'auto', { detect: NONE, permissions: { allowUnsandboxedAuto: true, rules: [{ effect: 'ask', rule: 'shell(codex)' }] } })
        const d = delegate(b)
        await answer(b, 1, 'deny', d.go({ ...CARD, unsandboxed: false }))
        expect(d.runs).toEqual([])
      })

      it('a deny added while the card is open stops the delegation after allow', async () => {
        const b = await boot(cwd, 'auto', { detect: FULL })
        const d = delegate(b)
        const p = d.go({ ...CARD, unsandboxed: true })
        await waitFor(() => requested(b.k).length === 1)
        await b.k.handle('permissions.set', { commandId: 'perm-d', config: { rules: [{ effect: 'deny', rule: 'shell(codex*)' }] } })
        const { r } = await answer(b, 1, 'allow', p)
        expect(r.content).toMatch(/^拒绝:exec /)
        expect(d.runs).toEqual([])
      })
    })

    describe('the 未隔离 mark', () => {
      it('explicit unsandboxed:false wins over session level none', async () => {
        const b = await boot(cwd, 'ask', { detect: NONE })
        expect((await answer(b, 1, 'deny', delegate(b).go({ ...CARD, unsandboxed: false }))).ev).not.toHaveProperty('unsandboxed')
      })

      it('explicit unsandboxed:true wins over session level full', async () => {
        const b = await boot(cwd, 'ask', { detect: FULL })
        expect((await answer(b, 1, 'deny', delegate(b).go({ ...CARD, unsandboxed: true }))).ev.unsandboxed).toBe(true)
      })

      it('a shell-style exec without the field is marked at level none', async () => {
        const b = await boot(cwd, 'ask', { detect: NONE })
        expect((await answer(b, 1, 'deny', b.call('fexec', { command: 'ls' }))).ev.unsandboxed).toBe(true)
      })

      it('a shell-style exec without the field is not marked at level full', async () => {
        const b = await boot(cwd, 'ask', { detect: FULL })
        expect((await answer(b, 1, 'deny', b.call('fexec', { command: 'ls' }))).ev).not.toHaveProperty('unsandboxed')
      })

      it('a write approval is never marked, even when the tool asks for it', async () => {
        const b = await boot(cwd, 'ask', { detect: NONE, permissions: { rules: [{ effect: 'ask', rule: 'write(package.json)' }] } })
        const off = b.probe.tools!.register({
          name: 'fmarked', description: '', parameters: {},
          permission: (_a, ctx) => [{ actor: 'tools', action: 'write', resource: resolved(ctx, 'package.json'), unsandboxed: true }],
          run: async () => ({ content: 'ok' }),
        })
        expect((await answer(b, 1, 'deny', b.call('fmarked', {}))).ev).not.toHaveProperty('unsandboxed')
        off()
        expect((await answer(b, 2, 'deny', b.call('fwrite', { path: 'package.json', content: '{}' }))).ev).not.toHaveProperty('unsandboxed')
      })

      it('an explicit flag is not replaced by a failing sandbox service', async () => {
        const seen: { unsandboxed?: boolean }[] = []
        const sandbox = { status: () => { throw new Error('boom') } }
        const reg = new ToolsRegistry({ gate: { check: () => 'ask' }, approvals: { request: async r => (seen.push(r), 'deny') }, sandbox, append: () => {}, log: nullLogger })
        const ctx: ToolContext = { sessionId: 's', turnId: 't', callId: 'c', cwd, spillDir: join(root, 'spill'), signal: new AbortController().signal }
        reg.register({ name: 'x', description: '', parameters: {}, permission: a => [{ actor: 'tools', action: 'exec', resource: 'codex', ...(a as object) }], run: async () => ({ content: '' }) })
        await reg.call('x', JSON.stringify({ unsandboxed: false }), ctx)
        await reg.call('x', JSON.stringify({ unsandboxed: true }), ctx)
        expect(seen.map(r => r.unsandboxed)).toEqual([undefined, true])
      })
    })
  })

  it('run throws → isError with the message', async () => {
    const b = await boot()
    const { r, ctx } = await b.call('boom', {})
    expect(r.isError).toBe(true)
    expect(r.content).toContain('kaput')
    b.expectPair(ctx.callId, 'boom')
    expect(b.ended(ctx.callId)).toMatchObject({ ok: false, isError: true })
  })

  it('40 000-char output spills: full file, head + tail + path, spill readable via the gate', async () => {
    const b = await boot()
    const { r, ctx } = await b.call('big', {})
    expect(r.isError).toBeUndefined()
    expect(r.content.startsWith('H'.repeat(12_000) + '\n…[已截断,完整输出:')).toBe(true)
    expect(r.content.endsWith(']…\n' + 'T'.repeat(12_000))).toBe(true)
    const path = /完整输出:(.+?)\]…/.exec(r.content)![1]
    expect(path).toMatch(new RegExp(`${ctx.callId}-big\\.txt$`))
    expect(readFileSync(path, 'utf8')).toBe('H'.repeat(15_000) + 'M'.repeat(10_000) + 'T'.repeat(15_000))
    expect(b.gateCheck('read', resolveToolPath(ctx.cwd, path))).toBe('allow')
    expect(b.gateCheck('write', resolveToolPath(ctx.cwd, path))).toBe('deny')
    expect(b.ended(ctx.callId).content).toBe(r.content) // 事件里也是截断后的结果
  })

  it('unsafe callId never escapes the spill dir', async () => {
    const b = await boot()
    const ctx = { ...b.ctxOf(), callId: '../../../evil' }
    const { r } = await b.call('big', {}, ctx)
    const path = /完整输出:(.+?)\]…/.exec(r.content)![1]
    expect(dirname(path)).toBe(resolveToolPath(cwd, ctx.spillDir))
    expect(existsSync(join(ctx.spillDir, '..', '..', '..', 'evil-big.txt'))).toBe(false)
  })

  it('secrets: events show *** while the model sees the original', async () => {
    const b = await boot()
    const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123'
    const { r, ctx } = await b.call('echo', { text: `line\n${key}` })
    expect(r.content).toBe(`got line\n${key}`)
    const [started, ended] = b.toolEvents(ctx.callId)
    expect((started.payload as { argsPreview: string }).argsPreview).toBe('{"text":"line\\n***"}')
    expect((ended.payload as { content: string }).content).toBe('got line\n***')
    expect(JSON.stringify(b.k.events.after(0))).not.toContain(key)
  })

  it('secrets in a spilled output are redacted in the event, kept in the spill file', async () => {
    const b = await boot()
    const key = 'AKIAABCDEFGHIJKLMNOP'
    const t = b.probe.tools!
    const off = t.register({ name: 'bigsecret', description: '', parameters: {}, permission: cwdRead, run: async () => ({ content: key + '\n' + 'x'.repeat(40_000) + '\n' + key }) })
    const { r, ctx } = await b.call('bigsecret', {})
    off()
    expect(r.content.startsWith(key)).toBe(true)
    expect(r.content.endsWith(key)).toBe(true)
    expect(b.ended(ctx.callId).content).not.toContain(key)
    expect(JSON.stringify(b.k.events.after(0))).not.toContain(key)
  })

  it('a PEM whose BEGIN is cut away by truncation is still redacted in the event', async () => {
    const b = await boot()
    const body = Array.from({ length: 200 }, (_, i) => `KEYBODY${String(i).padStart(4, '0')}${'Q'.repeat(50)}`).join('\n')
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`
    const content = 'a'.repeat(20_000) + pem + 'z'.repeat(5_000)
    const off = b.probe.tools!.register({ name: 'pem', description: '', parameters: {}, permission: cwdRead, run: async () => ({ content }) })
    const { r, ctx } = await b.call('pem', {})
    off()
    expect(r.content).toContain('KEYBODY0199') // 模型看到的结尾里有私钥正文
    expect(r.content).not.toContain('BEGIN RSA')
    const logged = b.ended(ctx.callId).content
    expect(logged).not.toContain('KEYBODY')
    expect(JSON.stringify(b.k.events.after(0))).not.toContain('KEYBODY')
  })

  describe('review fixes', () => {
    const reg = (b: Awaited<ReturnType<typeof boot>>, t: Partial<Tool> & { name: string }) =>
      b.probe.tools!.register({ description: '', parameters: {}, permission: cwdRead, run: async () => ({ content: 'ok' }), ...t })

    it('I1: permission() returning [] → isError, run not called, events paired', async () => {
      const b = await boot()
      const runs: string[] = []
      reg(b, { name: 'empty', permission: () => [], run: async () => { runs.push('empty'); return { content: 'ran' } } })
      const { r, ctx } = await b.call('empty', {})
      expect(r.isError).toBe(true)
      expect(runs).toEqual([])
      b.expectPair(ctx.callId, 'empty')
    })

    it('M1: spilled output whose redaction shrinks it still keeps the marker and path in the event', async () => {
      const b = await boot()
      const body = Array.from({ length: 400 }, (_, i) => `KEYBODY${String(i).padStart(4, '0')}${'Q'.repeat(50)}`).join('\n')
      const content = 'a'.repeat(8_000) + `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----` + 'z'.repeat(8_000)
      expect(content.length).toBeGreaterThan(30_000)
      reg(b, { name: 'shrink', run: async () => ({ content }) })
      const { r, ctx } = await b.call('shrink', {})
      const path = /完整输出:(.+?)\]…/.exec(r.content)![1]
      const logged = b.ended(ctx.callId).content
      expect(logged).toContain(`完整输出:${path}]`)
      expect(logged).not.toContain('KEYBODY')
    })

    it('M2: error message and approval summary are capped at 2 000 chars', async () => {
      const b = await boot()
      reg(b, { name: 'loud', run: async () => { throw new Error('E'.repeat(100_000)) } })
      const { r, ctx } = await b.call('loud', {})
      expect(r.isError).toBe(true)
      expect(r.content.length).toBeLessThanOrEqual(2000)
      expect(b.ended(ctx.callId).content.length).toBeLessThanOrEqual(2000)
      const p = b.call('fexec', { command: 'npm test ' + 'x'.repeat(50_000) })
      await waitFor(() => b.k.events.after(0).some(e => e.type === 'approval.requested'))
      const ev = b.k.events.after(0).find(e => e.type === 'approval.requested')!.payload as { approvalId: string; summary: string }
      expect(ev.summary.length).toBeLessThanOrEqual(2000)
      expect(ev.summary.startsWith('npm test x')).toBe(true)
      await b.k.handle('approval.respond', { approvalId: ev.approvalId, decision: 'deny' })
      await p
    })

    it('M3: colliding callIds never overwrite an earlier spill', async () => {
      const b = await boot()
      let n = 0
      reg(b, { name: 'bigN', run: async () => ({ content: String(++n).repeat(40_000) }) })
      const pathOf = (c: string) => /完整输出:(.+?)\]…/.exec(c)![1]
      const p1 = pathOf((await b.call('bigN', {}, { ...b.ctxOf(), callId: 'a/b' })).r.content)
      const p2 = pathOf((await b.call('bigN', {}, { ...b.ctxOf(), callId: 'a_b' })).r.content)
      const p3 = pathOf((await b.call('bigN', {}, { ...b.ctxOf(), callId: 'a_b' })).r.content)
      expect(new Set([p1, p2, p3]).size).toBe(3)
      expect(readFileSync(p1, 'utf8')).toBe('1'.repeat(40_000))
      expect(readFileSync(p2, 'utf8')).toBe('2'.repeat(40_000))
      expect(readFileSync(p3, 'utf8')).toBe('3'.repeat(40_000))
    })

    it('M5: an unknown tool name that looks like a key is redacted in events', async () => {
      const b = await boot()
      const key = 'sk-abcdefghijklmnopqrstuvwxyz'
      const { ctx } = await b.call(key, {})
      expect(JSON.stringify(b.k.events.after(0))).not.toContain(key)
      expect((b.toolEvents(ctx.callId)[0].payload as { name: string }).name).toBe('***')
      const long = 'n'.repeat(5000)
      const { ctx: c2 } = await b.call(long, {})
      expect((b.toolEvents(c2.callId)[0].payload as { name: string }).name.length).toBeLessThanOrEqual(200)
    })

    it('M6: non-string rawArgs (even Object.create(null)) → isError, no throw', async () => {
      const b = await boot()
      const r = await b.probe.tools!.call('echo', Object.create(null) as string, b.ctxOf())
      expect(r.isError).toBe(true)
    })

    it('M6: all gate checks run before any approval: ask + deny → deny, nobody asked', async () => {
      const b = await boot()
      const runs: string[] = []
      reg(b, {
        name: 'mixed',
        permission: (_a, ctx) => [
          { actor: 'tools', action: 'exec', resource: 'npm test' },
          { actor: 'tools', action: 'write', resource: resolveToolPath(ctx.cwd, join(root, 'out.txt')) },
        ],
        run: async () => { runs.push('mixed'); return { content: 'ran' } },
      })
      const { r, ctx } = await b.call('mixed', {})
      expect(r.isError).toBe(true)
      expect(r.content).toMatch(/^拒绝:write /)
      expect(b.k.events.after(0).filter(e => e.type === 'approval.requested')).toHaveLength(0)
      expect(runs).toEqual([])
      b.expectPair(ctx.callId, 'mixed')
    })

    it('spill failure falls back to 完整输出未能保存 without throwing', async () => {
      const b = await boot()
      const file = join(root, 'not-a-dir')
      writeFileSync(file, '')
      const { r } = await b.call('big', {}, { ...b.ctxOf(), spillDir: join(file, 'spill') })
      expect(r.isError).toBeUndefined()
      expect(r.content).toContain('完整输出未能保存')
      expect(r.content.length).toBeLessThan(25_000)
    })

    it('a 40 000-char isError result spills and keeps isError', async () => {
      const b = await boot()
      reg(b, { name: 'bigerr', run: async () => ({ content: 'e'.repeat(40_000), isError: true }) })
      const { r, ctx } = await b.call('bigerr', {})
      expect(r.isError).toBe(true)
      expect(r.content).toContain('完整输出:')
      expect(b.ended(ctx.callId)).toMatchObject({ ok: false, isError: true })
    })

    it('tool.started cannot be written → run is not called', async () => {
      const runs: string[] = []
      const t = new ToolsRegistry({
        gate: { check: () => 'allow' },
        approvals: { request: async () => 'allow' },
        append: () => { throw new Error('db closed') },
        log: nullLogger,
      })
      t.register({ name: 'x', description: '', parameters: {}, permission: cwdRead, run: async () => { runs.push('x'); return { content: 'ok' } } })
      const r = await t.call('x', '{}', { sessionId: 's', turnId: 't', callId: 'c', cwd, spillDir: join(root, 'sp'), signal: new AbortController().signal })
      expect(r.isError).toBe(true)
      expect(runs).toEqual([])
    })
  })

  it('argsPreview is capped at 2 000 chars', async () => {
    const b = await boot()
    const { ctx } = await b.call('echo', { text: 'y'.repeat(5000) })
    expect((b.toolEvents(ctx.callId)[0].payload as { argsPreview: string }).argsPreview).toHaveLength(2000)
  })

  it('call never throws even when event writes fail', async () => {
    const b = await boot()
    const ctx = b.ctxOf()
    await b.k.close()
    kernels = []
    const r = await b.probe.tools!.call('echo', '{"text":"x"}', ctx)
    expect(r.isError).toBe(true)
  })
})
