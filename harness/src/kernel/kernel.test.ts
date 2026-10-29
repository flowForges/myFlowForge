import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from './kernel'
import { PermissionGate } from './permissionGate'
import { RpcError } from './rpcError'
import { ERR_DRAINING } from '../protocol/index'
import type { Plugin } from './pluginHost'
import loopEcho from '../plugins/loop-echo'
import { BUILTIN_PLUGINS } from '../plugins'

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
  const k = await createKernel({ dataDir: dir, plugins, injectTimeoutMs })
  kernels.push(k)
  return k
}
const types = (k: Kernel) => k.events.after(0).map(e => e.type)
const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 5))
  expect(fn()).toBe(true)
}

describe('kernel', () => {
  it('exports loop-echo as the only builtin plugin', () => {
    expect(BUILTIN_PLUGINS.map(p => p.manifest.id)).toEqual(['loop-echo'])
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
    const p = createKernel({ dataDir: dir, plugins: [needy] })
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

  it('permission gate denies non-kernel actors', () => {
    const g = new PermissionGate()
    expect(g.check({ actor: 'kernel', action: 'x' })).toBe('allow')
    expect(g.check({ actor: 'plugin:foo', action: 'x', resource: 'y' })).toBe('deny')
  })

  it('draining rejects new mutating commands; drain waits for in-flight turn', async () => {
    let release!: () => void
    const slow: Plugin = {
      manifest: { id: 'slow', version: '1', kernel: '*' },
      activate: ctx => {
        ctx.events.on('session.prompt', async (r: { sessionId: string; turnId: string }) => {
          ctx.append({ type: 'turn.started', sessionId: r.sessionId, payload: {} })
          await new Promise<void>(res => { release = res })
          ctx.append({ type: 'turn.ended', sessionId: r.sessionId, payload: {} })
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
