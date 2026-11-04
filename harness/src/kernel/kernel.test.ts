import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from './kernel'
import { EventLog, openDb, REDACTED } from './eventLog'
import { EventBus } from './events'
import { nullLogger } from './log'
import { PluginHost, type PluginContext } from './pluginHost'
import { RpcRegistry } from './rpcRegistry'
import type { SecretStore } from './secrets/secretStore'
import { ServiceRegistry } from './services'
import { fakeClock, fakeModels, memoryKernel, say, type MemoryRig } from '../../test/memoryRig'
import { PermissionGate } from './permissionGate'
import { Sessions } from './sessions'
import { RpcError } from './rpcError'
import { ERR_BUSY, ERR_DRAINING } from '../protocol/index'
import type { Plugin } from './pluginHost'
import loopEcho from '../plugins/loop-echo'
import { BUILTIN_PLUGINS } from '../plugins'
import type { Approvals } from './approvals'
import type { FollowUp, SessionCommands, TurnInbox } from '../lib/tools/types'
import { sessionKey } from '../lib/tools/commandKey'
import { NO_SANDBOX } from '../../test/sandboxStub'

let dir: string
let kernels: Kernel[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mffai-kernel-')) })
afterEach(async () => {
  vi.useRealTimers()
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  rmSync(dir, { recursive: true, force: true })
})

async function boot(plugins: Plugin[] = [loopEcho], injectTimeoutMs?: number) {
  const k = await createKernel({ sandbox: NO_SANDBOX, dataDir: dir, plugins, injectTimeoutMs, secrets: { osBackend: false } })
  kernels.push(k)
  return k
}
const types = (k: Kernel) => k.events.after(0).map(e => e.type)
const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 5))
  expect(fn()).toBe(true)
}

describe('kernel', () => {
  it('builtin plugins in registration order', () => {
    expect(BUILTIN_PLUGINS.map(p => p.manifest.id)).toEqual(['models-registry', 'model-openai', 'model-anthropic', 'model-chatgpt', 'tools-registry', 'tools-coding', 'executor-cli', 'memory-default', 'loop-default', 'loop-direct', 'loop-echo', 'channel-telegram'])
  })

  it('close aborts turns with the kernel_stopping reason', async () => {
    let reason: unknown
    const holder: Plugin = {
      manifest: { id: 'holder', version: '0', kernel: '^0.1.0' },
      activate(ctx) {
        ctx.events.on('session.prompt', async ({ signal }: { signal: AbortSignal }) => {
          await new Promise<void>(res => signal.addEventListener('abort', () => res(), { once: true }))
          reason = signal.reason
          return true
        })
      },
    }
    const k = await createKernel({ sandbox: NO_SANDBOX, dataDir: dir, plugins: [holder], secrets: { osBackend: false } })
    const { sessionId } = (await k.handle('session.create', { commandId: 'c1' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'c2', sessionId, text: 'hi' })
    await k.close()
    expect(reason).toBe('kernel_stopping')
  })

  it('create + prompt runs the echo turn in order', async () => {
    const k = await boot()
    const { sessionId } = (await k.handle('session.create', { commandId: 'c1' })) as { sessionId: string }
    const r = (await k.handle('session.prompt', { commandId: 'c2', sessionId, text: 'hi' })) as { accepted: boolean; turnId: string }
    expect(r.accepted).toBe(true)
    await waitFor(() => types(k).includes('turn.ended'))
    const evs = k.events.after(0).filter(e => e.sessionId)
    expect(evs.map(e => e.type)).toEqual([
      'session.created', 'message.user', 'turn.started',
      'message.assistant.delta', 'message.assistant.delta', 'message.assistant', 'turn.ended',
    ])
    expect((evs[5].payload as { text: string }).text).toBe('echo: hi')
    const deltas = evs.filter(e => e.type === 'message.assistant.delta').map(e => (e.payload as { text: string }).text)
    expect(deltas.join('')).toBe('echo: hi')
  })

  it('ctx.events.history returns only that session\'s events in seq order', async () => {
    let history: (sid: string) => { type: string }[] = () => []
    const probe: Plugin = { manifest: { id: 'probe', version: '0', kernel: '^0.1.0' }, activate: ctx => { history = ctx.events.history } }
    const k = await boot([probe, loopEcho])
    const a = (await k.handle('session.create', { commandId: 'a' })) as { sessionId: string }
    const b = (await k.handle('session.create', { commandId: 'b' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'p', sessionId: a.sessionId, text: 'hi' })
    await waitFor(() => types(k).includes('turn.ended'))
    expect(history(a.sessionId).map(e => e.type)[0]).toBe('session.created')
    expect(history(a.sessionId).map(e => e.type)).toContain('message.user')
    expect(history(b.sessionId).map(e => e.type)).toEqual(['session.created'])
    expect(history('nope')).toEqual([])
  })

  it('same commandId replays the receipt without a second message', async () => {
    const k = await boot()
    const a = await k.handle('session.create', { commandId: 'c1' })
    const b = await k.handle('session.create', { commandId: 'c1' })
    expect(b).toEqual(a)
    const { sessionId } = a as { sessionId: string }
    const p1 = await k.handle('session.prompt', { commandId: 'p', sessionId, text: 'x' })
    const p2 = await k.handle('session.prompt', { commandId: 'p', sessionId, text: 'x' })
    expect(p2).toEqual(p1)
    await waitFor(() => types(k).includes('turn.ended'))
    expect(types(k).filter(t => t === 'message.user')).toHaveLength(1)
    expect(types(k).filter(t => t === 'session.created')).toHaveLength(1)
    expect(types(k).filter(t => t === 'turn.started')).toHaveLength(1)
  })

  it('failing plugin is isolated and recorded; loop-echo still works', async () => {
    const bad: Plugin = {
      manifest: { id: 'bad', version: '1', kernel: '*' },
      activate() { throw new Error('boom') },
    }
    const k = await boot([bad, loopEcho])
    const st = k.status().plugins
    expect(st).toEqual([{ id: 'bad', state: 'failed', error: 'boom' }, { id: 'loop-echo', state: 'active' }])
    expect(types(k)).toContain('plugin.failed')
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'p', sessionId, text: 'a' })
    await waitFor(() => types(k).includes('turn.ended'))
  })

  it('disabled plugin from config is not activated', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, plugins: { disabled: ['loop-echo'] } }))
    const k = await boot()
    expect(k.status().plugins).toEqual([{ id: 'loop-echo', state: 'disabled' }])
  })

  it('unmet inject fails after timeout', async () => {
    vi.useFakeTimers()
    const needy: Plugin = {
      manifest: { id: 'needy', version: '1', kernel: '*', inject: ['missing'] },
      activate() {},
    }
    const p = createKernel({ sandbox: NO_SANDBOX, dataDir: dir, plugins: [needy], secrets: { osBackend: false } })
    await vi.advanceTimersByTimeAsync(10_001)
    const k = await p
    kernels.push(k)
    const s = k.status().plugins[0]
    expect(s.state).toBe('failed')
    expect(s.error).toMatch(/inject timeout/)
    expect(types(k)).toContain('plugin.failed')
  })

  it('plugin services satisfy inject of a later plugin', async () => {
    const provider: Plugin = {
      manifest: { id: 'prov', version: '1', kernel: '*', provides: ['x'] },
      activate: ctx => ctx.services.provide('x', 1),
    }
    const user: Plugin = {
      manifest: { id: 'user', version: '1', kernel: '*', inject: ['x'] },
      activate: ctx => { if (ctx.services.get('x') !== 1) throw new Error('no x') },
    }
    const k = await boot([provider, user])
    expect(k.status().plugins.map(p => p.state)).toEqual(['active', 'active'])
  })

  it('status reports secretsBackend; ctx.secrets is scoped per plugin', async () => {
    let seenByB: string | undefined = 'unset'
    const a: Plugin = {
      manifest: { id: 'pa', version: '1', kernel: '*' },
      activate: async ctx => { await ctx.secrets.set('token', 'a-secret') },
    }
    const b: Plugin = {
      manifest: { id: 'pb', version: '1', kernel: '*' },
      activate: async ctx => { seenByB = await ctx.secrets.get('token') ?? (await ctx.secrets.get('../pa/token')) },
    }
    const k = await boot([a, b])
    expect(k.status().secretsBackend).toBe('plaintext-file')
    expect(k.status().plugins.map(p => p.state)).toEqual(['active', 'active'])
    expect(seenByB).toBeUndefined()
    const { readFileSync } = await import('node:fs')
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')))).toEqual(['pa/token'])
    // 密钥不进事件日志与 RPC 结果
    expect(JSON.stringify(k.events.after(0))).not.toContain('a-secret')
    expect(JSON.stringify(await k.handle('status', {}))).not.toContain('a-secret')
  })

  it('plugin id containing "/" is rejected (secret prefixes cannot collide)', async () => {
    let ran = false
    const sly: Plugin = { manifest: { id: 'pa/x', version: '1', kernel: '*' }, activate: () => { ran = true } }
    const k = await boot([sly])
    expect(k.status().plugins[0]).toMatchObject({ id: 'pa/x', state: 'failed' })
    expect(ran).toBe(false)
  })

  it('keychain hangs (prompt / locked) → secrets unavailable, kernel still starts', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'credentials.enc'), 'x')
    const hang = () => new Promise<never>(() => {})
    const t0 = Date.now()
    const k = await createKernel({ sandbox: NO_SANDBOX, dataDir: dir, plugins: [loopEcho], secrets: { platform: 'darwin', exec: hang, timeoutMs: 200 } })
    kernels.push(k)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(k.status()).toMatchObject({ state: 'running', secretsBackend: 'unavailable' })
    expect(k.status().plugins).toEqual([{ id: 'loop-echo', state: 'active' }])
  })

  it('permission gate allows the kernel and denies unknown actions', () => {
    const g = new PermissionGate({
      sessions: new Sessions(dir), home: dir, dataDir: dir, platform: process.platform, env: {},
      permissions: () => ({ rules: [], config: { allowUnsandboxedAuto: false } }),
      sandbox: () => ({ level: 'none', missing: ['platform'], autoDegraded: true }),
    })
    expect(g.check({ actor: 'kernel', action: 'x' })).toBe('allow')
    expect(g.check({ actor: 'plugin:foo', action: 'x', resource: 'y' })).toBe('deny')
  })

  it('draining rejects new mutating commands; drain waits for in-flight turn', async () => {
    let release!: () => void
    const slow: Plugin = {
      manifest: { id: 'slow', version: '1', kernel: '*' },
      activate: ctx => {
        ctx.events.on('session.prompt', async (r: { sessionId: string; turnId: string }) => {
          ctx.append({ type: 'turn.started', sessionId: r.sessionId, payload: { turnId: r.turnId } })
          await new Promise<void>(res => { release = res })
          ctx.append({ type: 'turn.ended', sessionId: r.sessionId, payload: { turnId: r.turnId } })
          return true
        })
      },
    }
    const k = await boot([slow])
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'p', sessionId, text: 'a' })
    await waitFor(() => !!release)
    let drained = false
    const d = k.drain(5000).then(() => { drained = true })
    expect(k.draining).toBe(true)
    expect(k.status().state).toBe('draining')
    await expect(k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'b' })).rejects.toMatchObject({ code: ERR_DRAINING, message: 'draining' })
    await new Promise(r => setTimeout(r, 20))
    expect(drained).toBe(false)
    release()
    await d
    expect(types(k)).toContain('turn.ended')
  })

  it('cancel aborts the signal and appends turn.failed cancelled', async () => {
    let signal!: AbortSignal
    const hang: Plugin = {
      manifest: { id: 'hang', version: '1', kernel: '*' },
      activate: ctx => {
        ctx.events.on('session.prompt', (r: { signal: AbortSignal }) => new Promise(res => {
          signal = r.signal
          r.signal.addEventListener('abort', () => res(true))
        }))
      },
    }
    const k = await boot([hang])
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'p', sessionId, text: 'a' })
    await waitFor(() => !!signal)
    expect(await k.handle('session.cancel', { commandId: 'x', sessionId })).toEqual({ ok: true })
    expect(signal.aborted).toBe(true)
    const failed = k.events.after(0).filter(e => e.type === 'turn.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].payload).toMatchObject({ reason: 'cancelled' })
  })

  it('cancel of a loop-echo turn does not leave it without a terminal event', async () => {
    const k = await boot()
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'p', sessionId, text: 'a' })
    await k.handle('session.cancel', { commandId: 'x', sessionId })
    await new Promise(r => setTimeout(r, 20))
    const t = types(k)
    expect(t.filter(x => x === 'turn.ended' || x === 'turn.failed')).toHaveLength(1)
  })

  it('second prompt on a busy session is rejected with ERR_BUSY and leaves no receipt', async () => {
    let release!: () => void
    const slow: Plugin = {
      manifest: { id: 'slow', version: '1', kernel: '*' },
      activate: ctx => {
        ctx.events.on('session.prompt', async (r: { sessionId: string; turnId: string }) => {
          await new Promise<void>(res => { release = res })
          ctx.append({ type: 'turn.ended', sessionId: r.sessionId, payload: { turnId: r.turnId } })
          return true
        })
      },
    }
    const k = await boot([slow])
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'p1', sessionId, text: 'a' })
    await expect(k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'b' })).rejects.toMatchObject({ code: ERR_BUSY, message: 'turn in progress' })
    expect(types(k).filter(t => t === 'message.user')).toHaveLength(1)
    release()
    await waitFor(() => types(k).includes('turn.ended'))
    await waitFor(() => k.status().state === 'running' && true)
    // 同一 commandId 重试:未存回执,现在可以成功
    await new Promise(r => setTimeout(r, 10))
    const ok = (await k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'b' })) as { accepted: boolean }
    expect(ok.accepted).toBe(true)
    release()
  })

  it('replayed cancel has no side effect on a newer turn', async () => {
    const aborts: AbortSignal[] = []
    const hang: Plugin = {
      manifest: { id: 'hang', version: '1', kernel: '*' },
      activate: ctx => {
        ctx.events.on('session.prompt', (r: { signal: AbortSignal }) => new Promise(res => {
          aborts.push(r.signal)
          r.signal.addEventListener('abort', () => res(true))
        }))
      },
    }
    const k = await boot([hang])
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'p1', sessionId, text: 'a' })
    await waitFor(() => aborts.length === 1)
    await k.handle('session.cancel', { commandId: 'x', sessionId })
    await k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'b' })
    await waitFor(() => aborts.length === 2)
    await k.handle('session.cancel', { commandId: 'x', sessionId })
    expect(aborts[1].aborted).toBe(false)
    expect(types(k).filter(t => t === 'turn.failed')).toHaveLength(1)
  })

  it('cancel is allowed while draining', async () => {
    const hang: Plugin = {
      manifest: { id: 'hang', version: '1', kernel: '*' },
      activate: ctx => {
        ctx.events.on('session.prompt', (r: { signal: AbortSignal }) => new Promise(res => {
          r.signal.addEventListener('abort', () => res(true))
        }))
      },
    }
    const k = await boot([hang])
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'p', sessionId, text: 'a' })
    const d = k.drain(5000)
    await k.handle('session.cancel', { commandId: 'x', sessionId })
    await d
    expect(types(k)).toContain('turn.failed')
  })

  it('startup marks orphan turns interrupted without replaying them', async () => {
    const k1 = await boot([])
    const { sessionId } = (await k1.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    k1.events.append({ type: 'message.user', sessionId, payload: { turnId: 'T1', text: 'x' } })
    k1.events.append({ type: 'message.user', sessionId, payload: { turnId: 'T2', text: 'y' } })
    k1.events.append({ type: 'turn.ended', sessionId, payload: { turnId: 'T2' } })
    await k1.close()
    kernels = []
    const k2 = await boot([loopEcho])
    const failed = k2.events.after(0).filter(e => e.type === 'turn.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].sessionId).toBe(sessionId)
    expect(failed[0].payload).toEqual({ turnId: 'T1', reason: 'interrupted' })
    expect(types(k2).filter(t => t === 'turn.started')).toHaveLength(0)
  })

  it('prompt with no handler fails the turn instead of hanging', async () => {
    const k = await boot([])
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'p', sessionId, text: 'a' })
    await waitFor(() => types(k).includes('turn.failed'))
  })

  it('validates params and method, treats undefined params as {}', async () => {
    const k = await boot()
    await expect(k.handle('session.prompt', { commandId: 'x' })).rejects.toMatchObject({ code: -32602 })
    await expect(k.handle('nope', {})).rejects.toMatchObject({ code: -32601 })
    await expect(k.handle('toString', {})).rejects.toBeInstanceOf(RpcError)
    expect(((await k.handle('status', undefined)) as { state: string }).state).toBe('running')
  })

  it('snapshot derives sessions from the log; title defaults', async () => {
    const k = await boot()
    const a = (await k.handle('session.create', { commandId: 'a', title: 'T' })) as { sessionId: string }
    const b = (await k.handle('session.create', { commandId: 'b' })) as { sessionId: string }
    const snap = k.snapshot()
    expect(snap.sessions.map(s => [s.id, s.title])).toEqual([[a.sessionId, 'T'], [b.sessionId, '新会话']])
    expect(snap.lastSeq).toBe(k.events.lastSeq())
    expect(snap.status.version).toBe('0.1.0')
  })
})

describe('kernel approvals', () => {
  type Gated = { approvals?: Approvals; modelRequests: number; marker: string; key?: string }
  // 模拟循环:请求一次模型 → 要审批 → 放行才"执行命令"(写标记文件);被取消就不再请求模型
  const gatedLoop = (g: Gated): Plugin => ({
    manifest: { id: 'gated', version: '1', kernel: '*' },
    activate: ctx => {
      g.approvals = ctx.services.get<Approvals>('approvals')
      ctx.events.on('session.prompt', async (r: { sessionId: string; turnId: string; signal: AbortSignal }) => {
        ctx.append({ type: 'turn.started', sessionId: r.sessionId, payload: { turnId: r.turnId } })
        g.modelRequests++
        const d = await g.approvals!.request({ sessionId: r.sessionId, turnId: r.turnId, callId: 'c1', tool: 'shell', summary: 'touch marker', key: g.key, signal: r.signal })
        if (d === 'allow') writeFileSync(g.marker, 'x')
        if (r.signal.aborted) return true
        g.modelRequests++
        ctx.append({ type: 'turn.ended', sessionId: r.sessionId, payload: { turnId: r.turnId } })
        return true
      })
    },
  })
  const bootGated = async (approvalTimeoutMs?: number, key?: string) => {
    const g: Gated = { modelRequests: 0, marker: join(dir, 'marker'), key }
    const k = await createKernel({ sandbox: NO_SANDBOX, dataDir: dir, plugins: [gatedLoop(g)], approvalTimeoutMs, secrets: { osBackend: false } })
    kernels.push(k)
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'p', sessionId, text: 'go' })
    await waitFor(() => types(k).includes('approval.requested'))
    const approvalId = (k.events.after(0).find(e => e.type === 'approval.requested')!.payload as { approvalId: string }).approvalId
    return { k, g, sessionId, approvalId }
  }
  const resolvedOf = (k: Kernel) => k.events.after(0).filter(e => e.type === 'approval.resolved')

  it('provides the approvals service', async () => {
    const { g } = await bootGated()
    expect(g.approvals).toBeDefined()
  })

  it('approval.respond allow runs the command; a second respond is ok:false', async () => {
    const { k, g, sessionId, approvalId } = await bootGated()
    expect(k.events.after(0).find(e => e.type === 'approval.requested')!.sessionId).toBe(sessionId)
    expect(await k.handle('approval.respond', { approvalId, decision: 'allow' })).toEqual({ ok: true })
    await waitFor(() => types(k).includes('turn.ended'))
    expect(existsSync(g.marker)).toBe(true)
    expect(resolvedOf(k)[0].payload).toMatchObject({ approvalId, decision: 'allow', by: 'user' })
    expect(resolvedOf(k)[0].sessionId).toBe(sessionId)
    expect(await k.handle('approval.respond', { approvalId, decision: 'deny' })).toEqual({ ok: false })
  })

  it('approval.respond allow_session: resolved allow by user, then the same key is allowed by session', async () => {
    const { k, g, sessionId, approvalId } = await bootGated(undefined, sessionKey('npm test'))
    expect(await k.handle('approval.respond', { approvalId, decision: 'allow_session' })).toEqual({ ok: true })
    await waitFor(() => types(k).includes('turn.ended'))
    expect(resolvedOf(k)[0].payload).toMatchObject({ approvalId, decision: 'allow', by: 'user' })
    const again = await g.approvals!.request({ sessionId, turnId: 't2', callId: 'c2', tool: 'shell', summary: 'npm test -- -t x', key: sessionKey('npm test -- -t x'), signal: new AbortController().signal })
    expect(again).toBe('allow')
    expect(resolvedOf(k)[1].payload).toMatchObject({ decision: 'allow', by: 'session' })
    expect(types(k).filter(t => t === 'approval.requested')).toHaveLength(1)
  })

  it('approval.respond on an unknown id → ok:false', async () => {
    const { k } = await bootGated()
    expect(await k.handle('approval.respond', { approvalId: 'nope', decision: 'allow' })).toEqual({ ok: false })
    expect(resolvedOf(k)).toHaveLength(0)
  })

  it('approvalTimeoutMs → deny by timeout', async () => {
    const { k, g } = await bootGated(30)
    await waitFor(() => types(k).includes('turn.ended'))
    expect(resolvedOf(k)[0].payload).toMatchObject({ decision: 'deny', by: 'timeout' })
    expect(existsSync(g.marker)).toBe(false)
  })

  it('cancel while waiting: resolved cancel/deny, no marker, turn.failed cancelled, no further model request', async () => {
    const { k, g, sessionId } = await bootGated()
    expect(g.modelRequests).toBe(1)
    await k.handle('session.cancel', { commandId: 'x', sessionId })
    expect(resolvedOf(k).map(e => e.payload)).toEqual([expect.objectContaining({ decision: 'deny', by: 'cancel' })])
    expect(existsSync(g.marker)).toBe(false)
    const failed = k.events.after(0).filter(e => e.type === 'turn.failed')
    expect(failed.map(e => e.payload)).toEqual([expect.objectContaining({ reason: 'cancelled' })])
    expect(types(k)).not.toContain('turn.ended')
    expect(g.modelRequests).toBe(1)
  })

  it('approval.respond cannot claim a channel: via is stripped by the schema; the service writes it', async () => {
    const { k, approvalId } = await bootGated()
    expect(await k.handle('approval.respond', { approvalId, decision: 'allow', via: 'telegram:42' })).toEqual({ ok: true })
    await waitFor(() => types(k).includes('turn.ended'))
    expect(Object.hasOwn(resolvedOf(k)[0].payload as object, 'via')).toBe(false)
  })

  it('approvals.respond with via ends up in the log', async () => {
    const { k, g, approvalId } = await bootGated()
    expect(g.approvals!.respond(approvalId, 'allow', 'telegram:42')).toBe(true)
    await waitFor(() => types(k).includes('turn.ended'))
    expect(resolvedOf(k)[0].payload).toMatchObject({ approvalId, decision: 'allow', by: 'user', via: 'telegram:42' })
  })

  it('kernel.close() with a pending approval → deny by cancel and the promise settles', async () => {
    const { k, g, approvalId } = await bootGated()
    const pending = g.approvals!.request({ sessionId: 's', turnId: 't', callId: 'c', tool: 'shell', summary: 'x', signal: new AbortController().signal })
    const byClose: unknown[] = []
    k.events.onAppend(e => { if (e.type === 'approval.resolved') byClose.push(e.payload) })
    await k.close()
    kernels = kernels.filter(x => x !== k)
    await expect(pending).resolves.toBe('deny')
    expect(byClose).toEqual(expect.arrayContaining([
      expect.objectContaining({ approvalId, decision: 'deny', by: 'cancel' }),
      expect.objectContaining({ decision: 'deny', by: 'cancel' }),
    ]))
    expect(byClose).toHaveLength(2)
    expect(existsSync(g.marker)).toBe(false)
  })
})

describe('kernel: session commands for plugins (07)', () => {
  async function bootProbe(over: { plugins?: Plugin[]; env?: NodeJS.ProcessEnv; home?: string } = {}) {
    let cmd!: SessionCommands
    const probe: Plugin = { manifest: { id: 'probe', version: '0', kernel: '*', inject: ['sessionCommands'] }, activate: ctx => { cmd = ctx.services.get<SessionCommands>('sessionCommands')! } }
    const k = await createKernel({ sandbox: NO_SANDBOX, dataDir: dir, plugins: [probe, ...(over.plugins ?? [])], secrets: { osBackend: false }, ...(over.env && { env: over.env }), ...(over.home && { home: over.home }) })
    kernels.push(k)
    return { k, cmd }
  }
  const prompts = (k: Kernel) => k.events.after(0).filter(e => e.type === 'message.user')

  it('anything off the closed list is refused and runs nothing', async () => {
    const { k, cmd } = await bootProbe()
    for (const m of ['permissions.set', 'approval.respond', 'memory.delete', 'channel.telegram.unpair', 'hasOwnProperty', '__proto__']) {
      await expect(cmd.call(m as never, { commandId: 'x', config: {} } as never)).rejects.toThrow(/not a session command/)
    }
    expect(types(k)).not.toContain('permissions.updated')
  })

  it('session.create returns a session, replays by commandId, and honours draining', async () => {
    const { k, cmd } = await bootProbe()
    const a = await cmd.call('session.create', { commandId: 'tg:1:1', origin: 'im', audience: 'owner', title: 'Telegram' })
    expect(a.sessionId).toEqual(expect.any(String))
    expect(await cmd.call('session.create', { commandId: 'tg:1:1', origin: 'im', audience: 'owner', title: 'Telegram' })).toEqual(a)
    expect(types(k).filter(t => t === 'session.created')).toHaveLength(1)
    expect(k.events.after(0).find(e => e.type === 'session.created')!.payload).toMatchObject({ origin: 'im', audience: 'owner' })
    await k.drain(0)
    await expect(cmd.call('session.create', { commandId: 'tg:1:2' })).rejects.toMatchObject({ code: ERR_DRAINING })
    expect(await cmd.call('session.create', { commandId: 'tg:1:1' })).toEqual(a)
  })

  it('params are checked exactly as for a client', async () => {
    const { cmd } = await bootProbe()
    await expect(cmd.call('session.prompt', { commandId: 'p' } as never)).rejects.toMatchObject({ code: -32602 })
  })

  it('a plugin method on the list goes through the same path: no provider is -32601', async () => {
    const { cmd } = await bootProbe()
    await expect(cmd.call('turn.changes', { sessionId: 's', turnId: 't' })).rejects.toMatchObject({ code: -32601 })
  })

  it('hasReceipt: false before, false after a refused command, true after success, and it runs nothing', async () => {
    const { k, cmd } = await bootProbe({ plugins: [loopEcho] })
    const { sessionId } = await cmd.call('session.create', { commandId: 'c' })
    expect(cmd.hasReceipt('p')).toBe(false)
    expect(prompts(k)).toHaveLength(0)
    await cmd.call('session.prompt', { commandId: 'p', sessionId, text: 'hi' })
    expect(cmd.hasReceipt('p')).toBe(true)
    expect(cmd.hasReceipt('c')).toBe(true)
    expect(prompts(k)).toHaveLength(1)
    await waitFor(() => types(k).includes('turn.ended'))
    expect(cmd.hasReceipt('p')).toBe(true)
    expect(prompts(k)).toHaveLength(1)
    await k.drain(0)
    await expect(cmd.call('session.prompt', { commandId: 'q', sessionId, text: 'hi' })).rejects.toMatchObject({ code: ERR_DRAINING })
    expect(cmd.hasReceipt('q')).toBe(false)
  })

  it('validateCwd uses the kernel\'s env snapshot: a credential root moved by env is refused, a plain directory passes', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mffai-cwd-'))
    try {
      const claude = join(outside, 'moved-claude')
      const work = join(outside, 'work')
      mkdirSync(claude)
      mkdirSync(work)
      const { cmd } = await bootProbe({ env: { CLAUDE_CONFIG_DIR: claude }, home: join(outside, 'home') })
      expect(() => cmd.validateCwd(claude)).toThrow('invalid cwd')
      expect(cmd.validateCwd(work)).toEqual(expect.stringContaining('work'))
      expect(() => cmd.validateCwd(join(outside, 'missing'))).toThrow('invalid cwd')
      expect(() => cmd.validateCwd(dir)).toThrow('invalid cwd') // 数据目录本身
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('kernel: channel methods and config (07)', () => {
  it('channel.* is not reserved: a plugin registers it, and before that it answers -32601', async () => {
    const k = await boot([])
    const calls: [string, object][] = [
      ['channel.telegram.status', {}], ['channel.telegram.setToken', { token: 'x' }], ['channel.telegram.clearToken', {}], ['channel.telegram.clearWebhook', { commandId: 'c1' }],
      ['channel.telegram.pairing.begin', {}], ['channel.telegram.pairing.cancel', {}], ['channel.telegram.unpair', { commandId: 'c2', accountId: '1' }],
      ['channel.telegram.config.get', {}], ['channel.telegram.config.set', { commandId: 'c3', config: {} }], ['channel.telegram.chats', {}], ['channel.telegram.worktree.discard', { commandId: 'c4', worktreeId: 'w' }],
    ]
    for (const [m, p] of calls) await expect(k.handle(m, p)).rejects.toMatchObject({ code: -32601 })
    await k.close()
    kernels = []
    let begun = 0
    const p: Plugin = { manifest: { id: 'channel-telegram', version: '0', kernel: '*' }, activate: ctx => {
      ctx.rpc.register('channel.telegram.status', async () => ({ state: 'no_token' }))
      ctx.rpc.register('channel.telegram.pairing.begin', async () => { begun++; return { code: 'CODE', expiresAt: 1 } })
    } }
    const k2 = await boot([p])
    expect(types(k2)).not.toContain('plugin.failed')
    expect(await k2.handle('channel.telegram.status', {})).toEqual({ state: 'no_token' })
    // 配对码方法即使被传了 commandId 也不走回执:schema 剥掉它,每次都执行,结果不进 receipts
    await k2.handle('channel.telegram.pairing.begin', { commandId: 'rc' })
    await k2.handle('channel.telegram.pairing.begin', { commandId: 'rc' })
    expect(begun).toBe(2)
  })

  it('a token of the wrong size is refused without quoting it', async () => {
    const k = await boot([])
    const token = 'S'.repeat(300)
    const err = (await k.handle('channel.telegram.setToken', { token }).catch(e => e)) as { message: string; data: unknown }
    expect(err).toMatchObject({ code: -32602 })
    expect(JSON.stringify({ message: err.message, data: err.data })).not.toContain('SSSS')
  })

  it('config.json with a junk channels value still loads, accounts intact; the plugin can read and write its section', async () => {
    const accounts = [{ id: 'a1', presetId: 'p', label: 'keep' }]
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, models: { accounts }, channels: 'junk' }))
    let ctx!: PluginContext
    const p: Plugin = { manifest: { id: 'channel-telegram', version: '0', kernel: '*' }, activate: c => { ctx = c } }
    await boot([p])
    expect(ctx.config.channels).toBe('junk')
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(cfg.models.accounts).toEqual(accounts)
    ctx.updateConfig('channels', { telegram: { enabled: false } })
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).channels).toEqual({ telegram: { enabled: false } })
    expect(() => ctx.updateConfig('models', {})).toThrow(/not writable/)
  })

  it('another plugin cannot write channels', async () => {
    let ctx!: PluginContext
    const p: Plugin = { manifest: { id: 'other', version: '0', kernel: '*' }, activate: c => { ctx = c } }
    await boot([p])
    expect(() => ctx.updateConfig('channels', {})).toThrow(/not writable/)
  })
})

describe('kernel: Review Focus 3a, a parked turn accepts the message', () => {
  type Req = { sessionId: string; turnId: string; text: string; signal: AbortSignal; inbox: TurnInbox }
  /** 只调 inbox 的假循环:醒来取走消息;then() 决定接着挂起、停在非挂起状态,还是结束 */
  function parkingLoop() {
    const c = {
      req: undefined as Req | undefined,
      parks: 0,
      taken: [] as FollowUp[],
      /** 下一次醒来之后:'park' 再挂起,'hold' 等 release,'end' 写 turn.ended */
      after: 'park' as 'park' | 'hold' | 'end',
      release: () => {},
      plugin: {
        manifest: { id: 'parking', version: '1', kernel: '*' },
        activate: ctx => {
          ctx.events.on('session.prompt', async (r: Req) => {
            c.req = r
            for (;;) {
              const woke = r.inbox.park()
              c.parks++
              await woke
              r.inbox.unpark()
              c.taken.push(...r.inbox.take())
              if (r.signal.aborted) {
                if (c.after === 'hold') await new Promise<void>(res => { c.release = res })
                return true
              }
              if (c.after === 'hold') await new Promise<void>(res => { c.release = res })
              if (c.after === 'end') {
                ctx.append({ type: 'turn.ended', sessionId: r.sessionId, payload: { turnId: r.turnId } })
                return true
              }
            }
          })
        },
      } as Plugin,
    }
    return c
  }
  async function parkedTurn() {
    const loop = parkingLoop()
    const k = await boot([loop.plugin])
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    const first = (await k.handle('session.prompt', { commandId: 'p1', sessionId, text: 'first' })) as { turnId: string }
    await waitFor(() => loop.parks === 1)
    return { k, loop, sessionId, turnId: first.turnId }
  }
  const users = (k: Kernel) => k.events.after(0).filter(e => e.type === 'message.user')
  const busy = { code: ERR_BUSY, message: 'turn in progress' }

  it('external: written on a new turn and on a follow-up to a parked turn, only when true; otherwise the payload is unchanged byte for byte', async () => {
    const loop = parkingLoop()
    const k = await boot([loop.plugin])
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    const first = (await k.handle('session.prompt', { commandId: 'p1', sessionId, text: 'first', external: true })) as { turnId: string }
    await waitFor(() => loop.parks === 1)
    const second = (await k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'second', external: true })) as { turnId: string; followUp?: boolean }
    await waitFor(() => loop.parks === 2)
    expect(second).toEqual({ accepted: true, turnId: first.turnId, followUp: true })
    const third = (await k.handle('session.prompt', { commandId: 'p3', sessionId, text: 'third', external: false })) as { followUp?: boolean }
    await waitFor(() => loop.parks === 3)
    expect(third.followUp).toBe(true)
    await k.handle('session.prompt', { commandId: 'p4', sessionId, text: 'fourth' })
    await waitFor(() => loop.parks === 4)
    expect(users(k).map(e => JSON.stringify(e.payload))).toEqual([
      JSON.stringify({ turnId: first.turnId, text: 'first', external: true }),
      JSON.stringify({ turnId: first.turnId, text: 'second', followUp: true, external: true }),
      JSON.stringify({ turnId: first.turnId, text: 'third', followUp: true }),
      JSON.stringify({ turnId: first.turnId, text: 'fourth', followUp: true }),
    ])
    expect(loop.taken.map(f => f.text)).toEqual(['second', 'third', 'fourth'])
    await k.handle('session.cancel', { commandId: 'x', sessionId })
    const fresh = (await k.handle('session.prompt', { commandId: 'p5', sessionId, text: 'plain', external: false })) as { turnId: string }
    expect(JSON.stringify(users(k).at(-1)!.payload)).toBe(JSON.stringify({ turnId: fresh.turnId, text: 'plain' }))
  })

  it('parked: same turn, followUp receipt and event, the inbox gets the text with that event\'s ts, and the handler wakes', async () => {
    const { k, loop, sessionId, turnId } = await parkedTurn()
    const r = await k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'second' })
    expect(r).toEqual({ accepted: true, turnId, followUp: true })
    expect(users(k).map(e => e.payload)).toEqual([{ turnId, text: 'first' }, { turnId, text: 'second', followUp: true }])
    await waitFor(() => loop.parks === 2)
    expect(loop.taken).toEqual([{ text: 'second', ts: users(k)[1].ts }])
  })

  it('the handler is not dispatched again', async () => {
    const { k, loop, sessionId } = await parkedTurn()
    const req = loop.req
    await k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'second' })
    await waitFor(() => loop.parks === 2)
    expect(loop.req).toBe(req)
  })

  it('not parked yet, or between parks → ERR_BUSY, no event, no receipt, and the same commandId can retry', async () => {
    const { k, loop, sessionId, turnId } = await parkedTurn()
    loop.after = 'hold'
    await k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'second' })
    await waitFor(() => loop.taken.length === 1)
    await expect(k.handle('session.prompt', { commandId: 'p3', sessionId, text: 'third' })).rejects.toMatchObject(busy)
    expect(users(k)).toHaveLength(2)
    loop.after = 'park'
    loop.release()
    await waitFor(() => loop.parks === 2)
    expect(await k.handle('session.prompt', { commandId: 'p3', sessionId, text: 'third' })).toEqual({ accepted: true, turnId, followUp: true })
  })

  it('two prompts in a row: the first is accepted, the second is busy at once; replaying the first wakes nothing', async () => {
    const { k, loop, sessionId } = await parkedTurn()
    // 同一个 tick:循环还没机会再挂起
    const accepted = k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'second' })
    const refused = k.handle('session.prompt', { commandId: 'p3', sessionId, text: 'third' })
    const one = await accepted
    await expect(refused).rejects.toMatchObject(busy)
    await waitFor(() => loop.parks === 2)
    expect(await k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'second' })).toEqual(one)
    await new Promise(r => setTimeout(r, 20))
    expect(loop.parks).toBe(2)
    expect(loop.taken).toHaveLength(1)
    expect(users(k)).toHaveLength(2)
  })

  it('after can\'t run if the transaction throws: still parked, nothing queued, nothing woken, and the commandId can retry', async () => {
    const { k, loop, sessionId, turnId } = await parkedTurn()
    const spy = vi.spyOn(k.events, 'append').mockImplementationOnce(() => { throw new Error('disk full') })
    await expect(k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'second' })).rejects.toThrow('disk full')
    spy.mockRestore()
    await new Promise(r => setTimeout(r, 20))
    expect(loop.parks).toBe(1)
    expect(loop.taken).toEqual([])
    expect(users(k)).toHaveLength(1)
    expect(await k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'second' })).toEqual({ accepted: true, turnId, followUp: true })
    await waitFor(() => loop.taken.length === 1)
  })

  it('session.cancel while parked resolves the inbox and the turn fails cancelled', async () => {
    const { k, loop, sessionId } = await parkedTurn()
    await k.handle('session.cancel', { commandId: 'x', sessionId })
    await waitFor(() => types(k).includes('turn.failed'))
    expect(k.events.after(0).filter(e => e.type === 'turn.failed').map(e => (e.payload as { reason: string }).reason)).toEqual(['cancelled'])
    await new Promise(r => setTimeout(r, 10))
    expect(loop.parks).toBe(1) // 循环已经返回,没有再挂起
    expect((await k.handle('session.prompt', { commandId: 'p9', sessionId, text: 'next' })) as { followUp?: boolean }).not.toHaveProperty('followUp')
  })

  it('park after the turn was aborted resolves at once', async () => {
    const { k, loop, sessionId } = await parkedTurn()
    loop.after = 'hold'
    const aborted = k.handle('session.cancel', { commandId: 'x', sessionId })
    await waitFor(() => loop.req!.signal.aborted)
    await expect(loop.req!.inbox.park()).resolves.toBeUndefined()
    await aborted
    loop.release()
  })

  it('after session.cancel with the handler still running → ERR_BUSY, no receipt', async () => {
    const { k, loop, sessionId } = await parkedTurn()
    loop.after = 'hold'
    const cancelling = k.handle('session.cancel', { commandId: 'x', sessionId })
    await waitFor(() => loop.req!.signal.aborted)
    await expect(k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'late' })).rejects.toMatchObject(busy)
    // 宽限过后内核写了 cancelled,处理者还没退:t.ended 也挡住
    await cancelling
    expect(types(k)).toContain('turn.failed')
    await expect(k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'late' })).rejects.toMatchObject(busy)
    expect(users(k)).toHaveLength(1)
    loop.release()
  })

  it('cancel and a prompt in the same tick: aborted but not yet unparked → ERR_BUSY', async () => {
    const { k, sessionId } = await parkedTurn()
    const cancelling = k.handle('session.cancel', { commandId: 'x', sessionId }) // 同步中止,循环的续延还没跑
    await expect(k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'late' })).rejects.toMatchObject(busy)
    expect(users(k)).toHaveLength(1)
    await cancelling
  })

  it('parked but the terminal event is already written → ERR_BUSY', async () => {
    let finish = () => {}
    let parked = false
    const late: Plugin = {
      manifest: { id: 'late', version: '1', kernel: '*' },
      activate: ctx => {
        ctx.events.on('session.prompt', async (r: Req) => {
          ctx.append({ type: 'turn.ended', sessionId: r.sessionId, payload: { turnId: r.turnId } })
          void r.inbox.park()
          parked = true
          await new Promise<void>(res => { finish = res })
          return true
        })
      },
    }
    const k = await boot([late])
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'p1', sessionId, text: 'first' })
    await waitFor(() => parked)
    await expect(k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'late' })).rejects.toMatchObject(busy)
    expect(users(k)).toHaveLength(1)
    finish()
  })

  it('a turn that parked and then ended no longer accepts: the next prompt is a new turn', async () => {
    const { k, loop, sessionId, turnId } = await parkedTurn()
    loop.after = 'end'
    await k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'second' })
    await waitFor(() => types(k).includes('turn.ended'))
    await new Promise(r => setTimeout(r, 10))
    loop.after = 'park'
    const next = (await k.handle('session.prompt', { commandId: 'p3', sessionId, text: 'third' })) as { turnId: string; followUp?: boolean }
    expect(next.turnId).not.toBe(turnId)
    expect(next.followUp).toBeUndefined()
  })

  it('draining while parked → ERR_DRAINING', async () => {
    const { k, sessionId } = await parkedTurn()
    void k.drain(1)
    await expect(k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'second' })).rejects.toMatchObject({ code: ERR_DRAINING })
    expect(users(k)).toHaveLength(1)
  })

  it('a loop that never parks stays busy', async () => {
    let release!: () => void
    const slow: Plugin = {
      manifest: { id: 'slow', version: '1', kernel: '*' },
      activate: ctx => {
        ctx.events.on('session.prompt', async (r: { sessionId: string; turnId: string; inbox: TurnInbox }) => {
          await new Promise<void>(res => { release = res })
          ctx.append({ type: 'turn.ended', sessionId: r.sessionId, payload: { turnId: r.turnId } })
          return true
        })
      },
    }
    const k = await boot([slow])
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'p1', sessionId, text: 'a' })
    await expect(k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'b' })).rejects.toMatchObject(busy)
    await waitFor(() => !!release)
    release()
    await waitFor(() => types(k).includes('turn.ended'))
  })

  it('each park replaces the last: abort listeners don\'t pile up, and an abandoned park is released', async () => {
    // 假循环不自己挂起,park 全由测试调
    let req: Req | undefined
    const idle: Plugin = {
      manifest: { id: 'idle', version: '1', kernel: '*' },
      activate: ctx => {
        ctx.events.on('session.prompt', (r: Req) => new Promise(res => {
          req = r
          r.signal.addEventListener('abort', () => res(true), { once: true })
        }))
      },
    }
    const k = await boot([idle])
    const { sessionId } = (await k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    await k.handle('session.prompt', { commandId: 'p1', sessionId, text: 'first' })
    await waitFor(() => !!req)
    const { inbox, signal } = req!
    const base = getEventListeners(signal, 'abort').length
    // 循环被通知叫醒:unpark 之后再 park,旧的 promise 没人再等
    for (let i = 0; i < 20; i++) {
      const old = inbox.park()
      inbox.unpark()
      await expect(old).resolves.toBeUndefined()
      expect(getEventListeners(signal, 'abort')).toHaveLength(base)
    }
    // 没有 unpark 就再 park:旧的也放开,监听器只留一个
    const a = inbox.park()
    const b = inbox.park()
    await expect(a).resolves.toBeUndefined()
    expect(getEventListeners(signal, 'abort')).toHaveLength(base + 1)
    await k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'second' })
    await expect(b).resolves.toBeUndefined()
    expect(getEventListeners(signal, 'abort')).toHaveLength(base)
  })

  it('killed after a follow-up: exactly one turn.failed interrupted, on this restart and the next', async () => {
    const { k, sessionId, turnId } = await parkedTurn()
    await k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'second' })
    // 库文件的拷贝就是崩溃时盘上的样子:旧内核没写终态
    const crashed = join(dir, 'crashed')
    cpSync(join(dir, 'db'), join(crashed, 'db'), { recursive: true })
    const open = () => createKernel({ sandbox: NO_SANDBOX, dataDir: crashed, plugins: [], secrets: { osBackend: false } })
    const failed = (x: Kernel) => x.events.after(0).filter(e => e.type === 'turn.failed').map(e => e.payload)
    const k2 = await open()
    expect(failed(k2)).toEqual([{ turnId, reason: 'interrupted' }])
    await k2.close()
    const k3 = await open()
    expect(failed(k3)).toEqual([{ turnId, reason: 'interrupted' }])
    expect(users(k3).map(e => (e.payload as { text: string }).text)).toEqual(['first', 'second'])
    await k3.close()
  })

  it('t.ended blocks a message.user after a terminal event, so recovery never sees one', async () => {
    const { k, loop, sessionId } = await parkedTurn()
    loop.after = 'hold'
    await k.handle('session.cancel', { commandId: 'x', sessionId }) // 终态已写,处理者还在
    await expect(k.handle('session.prompt', { commandId: 'p2', sessionId, text: 'late' })).rejects.toMatchObject(busy)
    const log = k.events.after(0)
    const terminalAt = log.findIndex(e => isEnd(e.type))
    expect(terminalAt).toBeGreaterThan(-1)
    expect(log.slice(terminalAt).some(e => e.type === 'message.user')).toBe(false)
    loop.release()
  })
})

const isEnd = (t: string) => t === 'turn.ended' || t === 'turn.failed'

describe('plugin event tap (06)', () => {
  const rigs: MemoryRig[] = []
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.close()
  })
  const probe = (id: string, onCtx: (ctx: PluginContext) => void): Plugin => ({ manifest: { id, version: '0', kernel: '^0.1.0' }, activate: onCtx })
  const rigWith = async (id = 'tap', config?: Record<string, unknown>) => {
    let ctx!: PluginContext
    const r = await memoryKernel({ plugins: [probe(id, c => { ctx = c })], config })
    rigs.push(r)
    return { r, ctx: () => ctx }
  }

  it('onAppend fires after commit: the event is already readable through after', async () => {
    const { r, ctx } = await rigWith()
    const seen: { type: string; readable: boolean }[] = []
    ctx().events.onAppend(e => seen.push({ type: e.type, readable: ctx().events.after(e.seq - 1, 1)[0]?.seq === e.seq }))
    await r.k.handle('session.create', { commandId: 'c' })
    expect(seen).toEqual([{ type: 'session.created', readable: true }])
  })

  it('a rolled-back transaction never reaches onAppend', async () => {
    const { r, ctx } = await rigWith()
    const seen: string[] = []
    ctx().events.onAppend(e => seen.push(e.type))
    // permissions.set 写事件和落盘在一个事务里;落盘的临时文件名被目录占了,事务回滚
    mkdirSync(join(r.dataDir, `config.json.tmp-${process.pid}`))
    const config = { rules: [], network: { allow: [] }, sandbox: { enabled: true, allowLoopback: false }, allowUnsandboxedAuto: false }
    await expect(r.k.handle('permissions.set', { commandId: 'p', config })).rejects.toThrow()
    expect(r.k.events.after(0).some(e => e.type === 'permissions.updated')).toBe(false)
    expect(seen).toEqual([])
  })

  it('onAppend stops after deactivate, and its own disposer works', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mffai-tap-'))
    const db = openDb(join(root, 'k.db'))
    const log = new EventLog(db)
    const host = new PluginHost({
      services: new ServiceRegistry(), events: new EventBus({}), rpc: new RpcRegistry(), append: e => log.append(e), log: nullLogger, dataDir: root,
      secrets: {} as SecretStore, eventLog: log,
    })
    const scoped: number[] = []
    const manual: number[] = []
    let off!: () => void
    await host.activateAll([probe('tap', c => {
      c.events.onAppend(e => scoped.push(e.seq))
      off = c.events.onAppend(e => manual.push(e.seq))
    })], [])
    scoped.length = manual.length = 0 // 去掉 plugin.activated
    const first = log.append({ type: 'turn.started', payload: {} })
    off()
    const second = log.append({ type: 'turn.started', payload: {} })
    await host.deactivateAll()
    log.append({ type: 'turn.started', payload: {} })
    expect(manual).toEqual([first.seq])
    expect(scoped).toEqual([first.seq, second.seq])
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('a plugin that fails to activate leaves no listener behind', async () => {
    const seen: number[] = []
    const r = await memoryKernel({ plugins: [probe('bad', c => {
      c.events.onAppend(e => seen.push(e.seq))
      throw new Error('boom')
    })] })
    rigs.push(r)
    await r.k.handle('session.create', { commandId: 'c' })
    expect(r.k.status().plugins.find(p => p.id === 'bad')?.state).toBe('failed')
    expect(seen).toEqual([])
  })

  it('a throwing listener does not stop the write', async () => {
    const { r, ctx } = await rigWith()
    ctx().events.onAppend(() => { throw new Error('boom') })
    await expect(r.k.handle('session.create', { commandId: 'c' })).resolves.toMatchObject({ sessionId: expect.any(String) })
  })

  describe('a tap cannot hurt anyone else', () => {
    const loud = () => {
      const errors: string[] = []
      const log = { info() {}, warn() {}, error: (m: string, d?: Record<string, unknown>) => void errors.push(`${m} ${JSON.stringify(d)}`) }
      return { errors, log }
    }
    it('a rejected async callback is logged, never unhandled, and the kernel carries on', async () => {
      const unhandled: unknown[] = []
      const onUnhandled = (e: unknown) => void unhandled.push(e)
      process.on('unhandledRejection', onUnhandled)
      try {
        const { errors, log } = loud()
        let ctx!: PluginContext
        const r = await memoryKernel({ kernel: { log }, plugins: [probe('tap', c => { ctx = c })] })
        rigs.push(r)
        ctx.events.onAppend(async () => { throw new Error('async boom') })
        await r.k.handle('session.create', { commandId: 'a' })
        await new Promise(res => setTimeout(res, 20))
        expect(unhandled).toEqual([])
        expect(errors.join()).toContain('[tap]')
        expect(errors.join()).toContain('async boom')
        await expect(r.k.handle('session.create', { commandId: 'b' })).resolves.toMatchObject({ sessionId: expect.any(String) })
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })

    it('a sync throw is logged under the plugin too', async () => {
      const { errors, log } = loud()
      let ctx!: PluginContext
      const r = await memoryKernel({ kernel: { log }, plugins: [probe('tap', c => { ctx = c })] })
      rigs.push(r)
      ctx.events.onAppend(() => { throw new Error('sync boom') })
      await r.k.handle('session.create', { commandId: 'a' })
      expect(errors.join()).toContain('sync boom')
    })

    it('a tap that changes its event changes nothing for the next tap, the caller or the log', async () => {
      let ctx!: PluginContext
      const r = await memoryKernel({ plugins: [probe('tap', c => { ctx = c })] })
      rigs.push(r)
      const later: unknown[] = []
      ctx.events.onAppend(e => { (e.payload as { text: string }).text = 'tampered'; e.seq = -1 })
      ctx.events.onAppend(e => void later.push(structuredClone(e.payload)))
      const written = r.k.events.append({ type: 'message.user', sessionId: 's', payload: { turnId: 't', text: 'real' } })
      expect(later).toEqual([{ turnId: 't', text: 'real' }])
      expect(written.payload).toEqual({ turnId: 't', text: 'real' })
      expect(written.seq).toBeGreaterThan(0)
      expect(r.k.events.after(written.seq - 1, 1)[0].payload).toEqual({ turnId: 't', text: 'real' })
    })

    it('a tap that appends loses no event for a client cursor', async () => {
      let ctx!: PluginContext
      const r = await memoryKernel({ plugins: [probe('tap', c => { ctx = c })] })
      rigs.push(r)
      let once = true
      ctx.events.onAppend(() => {
        if (!once) return
        once = false
        ctx.append({ type: 'memory.updated', payload: { op: 'x', source: 'y' } })
      })
      const got: string[] = []
      let sent = 0
      r.k.events.onAppend(e => {
        if (e.seq <= sent) return
        sent = e.seq
        got.push(e.type)
      })
      r.k.events.append({ type: 'turn.started', sessionId: 's', payload: {} })
      expect(got).toEqual(['turn.started', 'memory.updated'])
    })
  })

  it('after pages', async () => {
    const { r, ctx } = await rigWith()
    const start = r.k.events.lastSeq()
    for (const commandId of ['a', 'b', 'c']) await r.k.handle('session.create', { commandId })
    const one = ctx().events.after(start, 2)
    const two = ctx().events.after(one.at(-1)!.seq, 2)
    expect(one).toHaveLength(2)
    expect(two).toHaveLength(1)
    expect([...one, ...two].map(e => e.seq)).toEqual([start + 1, start + 2, start + 3])
    expect(ctx().events.after(start + 3, 2)).toEqual([])
  })

  it('redact: memory-default may, any other plugin throws, and on an unlisted type it throws too', async () => {
    let other!: PluginContext
    let owner!: PluginContext
    const r = await memoryKernel({ plugins: [probe('other', c => { other = c }), probe('memory-default', c => { owner = c })] })
    rigs.push(r)
    const { sessionId } = (await r.k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
    const created = r.k.events.bySession(sessionId)[0]
    const e = r.k.events.append({ type: 'message.user', sessionId, payload: { turnId: 't', text: 'SECRET' } })
    expect(() => other.events.redact([{ seq: e.seq }])).toThrow()
    await expect(other.events.purge()).rejects.toThrow()
    expect((r.k.events.after(e.seq - 1, 1)[0].payload as { text: string }).text).toBe('SECRET')
    expect(() => owner.events.redact([{ seq: created.seq }])).toThrow()
    expect(owner.events.redact([{ seq: e.seq }])).toBe(1)
    expect((r.k.events.after(e.seq - 1, 1)[0].payload as { text: string }).text).toBe(REDACTED)
    expect(r.k.events.after(e.seq).at(-1)).toMatchObject({ type: 'events.redacted', payload: { by: 'memory-default', seqs: [e.seq] } })
  })

  it('purge asks the supervisor for time scaled to the log, blocks only once it has it, and always gives it back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mffai-hold-'))
    const db = openDb(join(root, 'k.db'))
    const log = new EventLog(db)
    const order: string[] = []
    let refuse = false
    const realPurge = log.purge.bind(log)
    log.purge = () => {
      order.push('vacuum')
      realPurge()
    }
    let ctx!: PluginContext
    const holdWatchdog = async (ms: number) => {
      order.push(ms > 0 ? 'hold' : 'release')
      if (ms > 0) holds.push(ms)
      if (ms > 0 && refuse) throw new Error('no ack')
    }
    const holds: number[] = []
    const host = new PluginHost({
      services: new ServiceRegistry(), events: new EventBus({}), rpc: new RpcRegistry(), append: e => log.append(e), eventLog: log, holdWatchdog, log: nullLogger, dataDir: root, secrets: {} as SecretStore,
    })
    await host.activateAll([probe('memory-default', c => { ctx = c })], [])

    await ctx.events.purge({ then: () => order.push('then') })
    expect(order).toEqual(['hold', 'vacuum', 'then', 'release'])
    await ctx.events.purge({ extraBytes: 1024 * 1_048_576 })
    expect(holds[1] - holds[0]).toBeGreaterThanOrEqual(100_000)

    order.length = 0
    refuse = true
    await expect(ctx.events.purge()).rejects.toThrow('no ack')
    expect(order).toEqual(['hold'])

    refuse = false
    order.length = 0
    log.purge = () => {
      order.push('vacuum')
      throw new Error('disk full')
    }
    await expect(ctx.events.purge()).rejects.toThrow('disk full')
    expect(order).toEqual(['hold', 'vacuum', 'release'])
    await host.deactivateAll()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('without an event log the tap is inert and redact still refuses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mffai-tap-'))
    const db = openDb(join(root, 'k.db'))
    const log = new EventLog(db)
    let ctx!: PluginContext
    const host = new PluginHost({
      services: new ServiceRegistry(), events: new EventBus({}), rpc: new RpcRegistry(), append: e => log.append(e), log: nullLogger, dataDir: root, secrets: {} as SecretStore,
    })
    await host.activateAll([probe('memory-default', c => { ctx = c })], [])
    expect(ctx.events.after(0, 10)).toEqual([])
    expect(ctx.events.onAppend(() => {})).toBeTypeOf('function')
    expect(() => ctx.events.redact([{ seq: 1 }])).toThrow()
    await expect(ctx.events.purge()).rejects.toThrow()
    await host.deactivateAll()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('memory.* is unhandled until a plugin registers it, and it is not reserved', async () => {
    let ctx!: PluginContext
    const r = await memoryKernel({ plugins: [probe('memory-default', c => { ctx = c })] })
    rigs.push(r)
    await expect(r.k.handle('memory.health', {})).rejects.toMatchObject({ code: -32601, message: 'method not handled: memory.health' })
    await expect(r.k.handle('memory.file.get', { file: '../x' })).rejects.toMatchObject({ code: -32602 })
    const all = ['memory.list', 'memory.get', 'memory.search', 'memory.update', 'memory.delete', 'memory.file.get', 'memory.file.set', 'memory.changes', 'memory.health', 'memory.proposals.list', 'memory.proposals.decide', 'memory.consolidate', 'memory.habits.list', 'memory.habits.decide', 'memory.recommendations.set'] as const
    for (const m of all) expect(() => ctx.rpc.register(m, async () => ({}))).not.toThrow()
    await expect(r.k.handle('memory.health', {})).resolves.toEqual({})
  })

  it('memory-default owns the memory section and only that', async () => {
    let owner!: PluginContext
    let other!: PluginContext
    const r = await memoryKernel({
      config: { memory: { tokensPerDay: 5 }, models: { accounts: [] } },
      plugins: [probe('memory-default', c => { owner = c }), probe('other', c => { other = c })],
    })
    rigs.push(r)
    expect(owner.config.memory).toEqual({ tokensPerDay: 5 })
    expect(other.config.memory).toBeUndefined()
    owner.updateConfig('memory', { tokensPerDay: 6 })
    expect(JSON.parse(readFileSync(join(r.dataDir, 'config.json'), 'utf8')).memory).toEqual({ tokensPerDay: 6 })
    expect(owner.config.memory).toEqual({ tokensPerDay: 5 }) // 激活时的快照,插件自己留一份当前值
    expect(() => owner.updateConfig('permissions', {})).toThrow()
    expect(() => owner.updateConfig('models', {})).toThrow()
    expect(() => other.updateConfig('memory', {})).toThrow()
  })

  it('a broken memory section leaves the rest of the config alone', async () => {
    const account = { id: 'a', presetId: 'p', label: 'l' }
    const r = await memoryKernel({ config: { memory: 'garbage', models: { accounts: [account] } } })
    rigs.push(r)
    const saved = JSON.parse(readFileSync(join(r.dataDir, 'config.json'), 'utf8'))
    expect(saved.models.accounts).toEqual([account])
    expect(saved.memory).toBe('garbage')
  })

  describe('snapshot', () => {
    afterEach(() => vi.restoreAllMocks())
    const appendAt = (r: MemoryRig, ts: number, type: Parameters<Kernel['events']['append']>[0]['type'], sessionId: string) => {
      const spy = vi.spyOn(Date, 'now').mockReturnValue(ts)
      r.k.events.append({ type, sessionId, payload: { turnId: 't', text: 'x', throughSeq: 1, asOfSeq: 1, model: 'm', tokens: 1, covers: 1 } })
      spy.mockRestore()
    }
    it('updatedAt ignores a memory.checkpoint, and not other events', async () => {
      const { r } = await rigWith()
      const { sessionId } = (await r.k.handle('session.create', { commandId: 'c' })) as { sessionId: string }
      const at = () => r.k.snapshot().sessions.find(s => s.id === sessionId)!.updatedAt
      const base = at()
      appendAt(r, base + 1000, 'memory.checkpoint', sessionId)
      expect(at()).toBe(base)
      appendAt(r, base + 2000, 'memory.injected', sessionId)
      expect(at()).toBe(base + 2000)
    })
  })
})

describe.skipIf(process.platform === 'win32')('database file modes (06 spec §5)', () => {
  const mode = (p: string) => statSync(p).mode & 0o777

  it('a new kernel: db/ is 0700, events.sqlite and its WAL are 0600', async () => {
    const k = await boot()
    await k.handle('session.create', { commandId: 'c' })
    expect(mode(join(dir, 'db'))).toBe(0o700)
    expect(mode(join(dir, 'db', 'events.sqlite'))).toBe(0o600)
    expect(mode(join(dir, 'db', 'events.sqlite-wal'))).toBe(0o600)
    expect(mode(join(dir, 'db', 'events.sqlite-shm'))).toBe(0o600)
  })

  it('an existing data directory from before 06 is tightened', async () => {
    const k1 = await boot()
    await k1.handle('session.create', { commandId: 'c' })
    await k1.close()
    kernels = []
    chmodSync(join(dir, 'db'), 0o755)
    chmodSync(join(dir, 'db', 'events.sqlite'), 0o644)
    const k2 = await boot()
    await k2.handle('session.create', { commandId: 'c2' })
    expect(mode(join(dir, 'db'))).toBe(0o700)
    expect(mode(join(dir, 'db', 'events.sqlite'))).toBe(0o600)
    expect(mode(join(dir, 'db', 'events.sqlite-wal'))).toBe(0o600)
    expect(k2.snapshot().sessions).toHaveLength(2) // 旧数据还在
  })
})

describe('a filesystem that refuses or ignores modes (06)', () => {
  const warnsOf = () => {
    const warns: string[] = []
    return { warns, log: { info() {}, warn: (m: string) => void warns.push(m), error() {} } }
  }
  const open = (extra: Partial<Parameters<typeof createKernel>[0]>) =>
    createKernel({ sandbox: NO_SANDBOX, dataDir: dir, plugins: [], secrets: { osBackend: false }, ...extra }).then(k => (kernels.push(k), k))

  it('chmod throwing: the kernel starts, warns and status says so', async () => {
    const { warns, log } = warnsOf()
    const k = await open({ log, chmod: () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }) } })
    expect(k.status().dbUnprotected).toBe(true)
    expect(warns.filter(w => w.includes('events database'))).not.toEqual([])
    await expect(k.handle('session.create', { commandId: 'c' })).resolves.toMatchObject({ sessionId: expect.any(String) })
    expect((await k.handle('status', {}) as { dbUnprotected?: boolean }).dbUnprotected).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('chmod that succeeds without taking effect is reported as well', async () => {
    mkdirSync(join(dir, 'db'), { mode: 0o755 })
    chmodSync(join(dir, 'db'), 0o755)
    const { warns, log } = warnsOf()
    const k = await open({ log, chmod: () => {} })
    expect(k.status().dbUnprotected).toBe(true)
    expect(warns).not.toEqual([])
  })

  it.skipIf(process.platform === 'win32')('a normal start reports nothing', async () => {
    const { warns, log } = warnsOf()
    const k = await open({ log })
    expect(k.status()).not.toHaveProperty('dbUnprotected')
    expect(warns).toEqual([])
  })
})

describe('memoryRig', () => {
  it('uses a temp home and data dir, restarts on the same data, removes everything on close', async () => {
    const r = await memoryKernel()
    expect(r.home.startsWith(r.root) && r.dataDir.startsWith(r.root) && r.cwd.startsWith(r.root)).toBe(true)
    const { sessionId } = (await r.k.handle('session.create', { commandId: 'c', cwd: r.cwd })) as { sessionId: string }
    await r.restart()
    expect(r.k.snapshot().sessions.map(s => s.id)).toEqual([sessionId])
    await r.close()
    expect(existsSync(r.root)).toBe(false)
  })

  it('fakeModels records foreground and background calls, with costs, restriction and quota per account', async () => {
    const seen: string[] = []
    const fm = fakeModels({
      accounts: [
        { id: 'cheap', billing: 'metered', models: [{ id: 'mini', cost: { input: 0.1, output: 0.2 } }, { id: 'old', deprecated: true }] },
        { id: 'plan', billing: 'subscription', restriction: 'coding-tools-only', models: [{ id: 'big', context: 500_000 }] },
      ],
      script: (n, _req, ref) => say(`${n}:${ref.accountId}/${ref.modelId}`),
      onRequest: c => seen.push(c.ref.modelId),
      quota: id => (id === 'cheap' ? { windows: [{ label: 'd', usedPercent: 80 }] } : { link: 'https://example.invalid' }),
    })
    const signal = new AbortController().signal
    const message = { role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }] }
    const texts: string[] = []
    const run = async (ref: Parameters<typeof fm.service.stream>[0], interactive: boolean) => {
      for await (const e of fm.service.stream(ref, { messages: [message], interactive, signal })) if (e.type === 'text') texts.push(e.delta)
    }
    await run('default', true)
    await run({ accountId: 'plan', modelId: 'big' }, false)
    expect(texts).toEqual(['1:cheap/mini', '2:plan/big'])
    expect(seen).toEqual(['mini', 'big'])
    expect(fm.foreground().map(c => c.ref)).toEqual([{ accountId: 'cheap', modelId: 'mini' }])
    expect(fm.background().map(c => c.ref)).toEqual([{ accountId: 'plan', modelId: 'big' }])
    expect(fm.calls[0].req.messages).toEqual([message])
    expect(fm.calls[0].req.signal).toBe(signal)
    const presets = fm.service.catalog().presets
    expect(presets.find(p => p.id === 'preset-plan')).toMatchObject({ billing: 'subscription', restriction: 'coding-tools-only' })
    const cheap = fm.service.accounts().find(a => a.id === 'cheap')!
    expect(cheap.models![0]).toMatchObject({ id: 'mini', cost: { input: 0.1, output: 0.2 }, context: 100_000 })
    expect(cheap.models![1].deprecated).toBe(true)
    expect(fm.service.catalog().default).toEqual({ accountId: 'cheap', modelId: 'mini' })
    expect(await fm.service.quota('cheap')).toEqual({ windows: [{ label: 'd', usedPercent: 80 }] })
    expect(await fm.service.quota('plan')).toEqual({ link: 'https://example.invalid' })
  })

  it('the fake is a plugin that provides models', async () => {
    const fm = fakeModels()
    let got: unknown
    const r = await memoryKernel({
      models: fm,
      plugins: [{ manifest: { id: 'p', version: '0', kernel: '^0.1.0', inject: ['models'] }, activate: c => { got = c.services.get('models') } }],
    })
    expect(got).toBe(fm.service)
    expect(r.k.status().plugins.map(p => p.id)).toEqual(['fake-models', 'p'])
    await r.close()
  })

  it('fakeClock runs due timers in order, cancels, and can reschedule within one advance', () => {
    const c = fakeClock(1000)
    const fired: [string, number][] = []
    const mark = (n: string) => () => void fired.push([n, c.now()])
    c.timers.setTimeout(mark('b'), 20)
    c.timers.setTimeout(mark('a'), 10)
    const gone = c.timers.setTimeout(mark('gone'), 15).unref()
    c.timers.clearTimeout(gone)
    c.timers.setTimeout(() => { fired.push(['first', c.now()]); c.timers.setTimeout(mark('again'), 5) }, 12)
    c.advance(19)
    expect(c.now()).toBe(1019)
    expect(fired).toEqual([['a', 1010], ['first', 1012], ['again', 1017]])
    c.advance(1)
    expect(fired.at(-1)).toEqual(['b', 1020])
  })
})
