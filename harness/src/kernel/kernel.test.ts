import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from './kernel'
import { PermissionGate } from './permissionGate'
import { Sessions } from './sessions'
import { RpcError } from './rpcError'
import { ERR_BUSY, ERR_DRAINING } from '../protocol/index'
import type { Plugin } from './pluginHost'
import loopEcho from '../plugins/loop-echo'
import { BUILTIN_PLUGINS } from '../plugins'
import type { Approvals } from './approvals'
import type { FollowUp, TurnInbox } from '../lib/tools/types'
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
    expect(BUILTIN_PLUGINS.map(p => p.manifest.id)).toEqual(['models-registry', 'model-openai', 'model-anthropic', 'model-chatgpt', 'tools-registry', 'tools-coding', 'loop-default', 'loop-direct', 'loop-echo'])
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
