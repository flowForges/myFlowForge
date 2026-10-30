import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { client, type Stream } from '@agentclientprotocol/sdk'
import { createKernel, type Kernel } from '../kernel/kernel'
import { startRpcServer } from '../kernel/rpcServer'
import { HARNESS_VERSION } from '../kernel/version'
import { connectClient } from '../protocol/index'
import loopEcho from '../plugins/loop-echo'
import type { Plugin } from '../kernel/pluginHost'
import type { KernelEvent } from '../protocol/index'
import { EarlyBuffer, runBridge } from './bridge'

let dir: string
let kernel: Kernel
let closers: Array<() => unknown> = []
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mffai-acp-'))
  closers = []
})
afterEach(async () => {
  for (const c of closers.reverse()) await Promise.resolve(c()).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

function pair(): { a: Stream; b: Stream } {
  const ab = new TransformStream<any, any>()
  const ba = new TransformStream<any, any>()
  return {
    a: { readable: ba.readable, writable: ab.writable },
    b: { readable: ab.readable, writable: ba.writable },
  }
}

const hang: Plugin = {
  manifest: { id: 'hang', version: '1', kernel: '*' },
  activate: ctx => {
    ctx.events.on('session.prompt', (r: { sessionId: string; turnId: string; signal: AbortSignal }) => new Promise(res => {
      ctx.append({ type: 'turn.started', sessionId: r.sessionId, payload: { turnId: r.turnId } })
      r.signal.addEventListener('abort', () => res(true))
    }))
  },
}
const failing: Plugin = {
  manifest: { id: 'failing', version: '1', kernel: '*' },
  activate: ctx => {
    ctx.events.on('session.prompt', (r: { sessionId: string; turnId: string }) => {
      ctx.append({ type: 'turn.failed', sessionId: r.sessionId, payload: { turnId: r.turnId, reason: 'boom' } })
      return true
    })
  },
}

async function boot(ps: Plugin[]) {
  kernel = await createKernel({ dataDir: dir, plugins: ps, secrets: { osBackend: false } })
  closers.push(() => kernel.close())
  const addr = process.platform === 'win32' ? `\\\\.\\pipe\\mffai-acp-${process.pid}-${Date.now()}` : join(dir, 'w.sock')
  const s = await startRpcServer({ addr, token: 'tok', version: HARNESS_VERSION, events: kernel.events, handle: (m, p) => kernel.handle(m, p) })
  closers.push(() => s.close())
  const workers: Array<{ close(): void }> = []
  const { a, b } = pair()
  void runBridge({ stream: b, connect: async () => { const c = await connectClient({ addr, token: 'tok' }); workers.push(c); return c } })
  return { a, workers }
}
const INIT = { protocolVersion: 1, clientCapabilities: {} }
const wait = async (fn: () => boolean) => {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise(r => setTimeout(r, 5))
  expect(fn()).toBe(true)
}

describe('ACP bridge', () => {
  it('initialize -> newSession -> prompt echoes via chunks', async () => {
    const { a } = await boot([loopEcho])
    const chunks: string[] = []
    const stop = await client({ name: 't' })
      .onNotification('session/update', (ctx) => {
        const u = ctx.params.update
        if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') chunks.push(u.content.text)
      })
      .connectWith(a, async (cx) => {
        await cx.request('initialize', INIT)
        const { sessionId } = await cx.request('session/new', { cwd: dir, mcpServers: [] })
        const r = await cx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
        return r.stopReason
      })
    expect(stop).toBe('end_turn')
    expect(chunks.join('')).toBe('echo: hi')
  })

  it('session/cancel during a turn -> stopReason cancelled', async () => {
    const { a } = await boot([hang])
    const stop = await client({ name: 't' }).connectWith(a, async (cx) => {
      await cx.request('initialize', INIT)
      const { sessionId } = await cx.request('session/new', { cwd: dir, mcpServers: [] })
      const p = cx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'x' }] })
      await wait(() => kernel.events.after(0).some(e => e.type === 'turn.started'))
      await cx.notify('session/cancel', { sessionId })
      return (await p).stopReason
    })
    expect(stop).toBe('cancelled')
  })

  it('turn.failed rejects the prompt with the reason', async () => {
    const { a } = await boot([failing])
    await client({ name: 't' }).connectWith(a, async (cx) => {
      await cx.request('initialize', INIT)
      const { sessionId } = await cx.request('session/new', { cwd: dir, mcpServers: [] })
      await expect(cx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'x' }] })).rejects.toThrow('boom')
    })
  })

  it('worker connection closing mid-prompt rejects with 连接已断开', async () => {
    const { a, workers } = await boot([hang])
    await client({ name: 't' }).connectWith(a, async (cx) => {
      await cx.request('initialize', INIT)
      const { sessionId } = await cx.request('session/new', { cwd: dir, mcpServers: [] })
      const p = cx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'x' }] })
      const assertion = expect(p).rejects.toThrow('mff-ai 连接已断开')
      await wait(() => kernel.events.after(0).some(e => e.type === 'turn.started'))
      workers[0].close()
      await assertion
    })
  })

  it('concurrent initialize shares one worker connection', async () => {
    const { a, workers } = await boot([loopEcho])
    await client({ name: 't' }).connectWith(a, async (cx) => {
      await Promise.all([cx.request('initialize', INIT), cx.request('initialize', INIT)])
    })
    expect(workers).toHaveLength(1)
  })

  it('initialize fails with 未运行 when the worker is unreachable', async () => {
    const { a, b } = pair()
    const bridge = runBridge({ stream: b, connect: () => Promise.reject(new Error('ENOENT')) })
    await client({ name: 't' }).connectWith(a, async (cx) => {
      await expect(cx.request('initialize', { protocolVersion: 1, clientCapabilities: {} })).rejects.toThrow('mff-ai 未运行')
    })
    void bridge
  })

  it('EarlyBuffer only buffers while a prompt is in flight and is capped', () => {
    const ev = (n: number): KernelEvent => ({ seq: n, ts: 0, type: 'message.assistant.delta', payload: { turnId: 'T' + n } })
    const b = new EarlyBuffer()
    b.add('T0', ev(0))
    expect(b.size).toBe(0) // 无在途 prompt:丢弃
    b.begin()
    for (let i = 0; i < 100; i++) b.add('T' + i, ev(i))
    expect(b.size).toBe(16)
    expect(b.take('T99')).toHaveLength(1)
    expect(b.take('T0')).toHaveLength(0) // 最旧的已被挤掉
    b.end()
    expect(b.size).toBe(0)
  })
})
