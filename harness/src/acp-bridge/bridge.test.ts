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
import { runBridge } from './bridge'

let dir: string
let kernel: Kernel
let closers: Array<() => unknown> = []
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mffai-acp-'))
  kernel = await createKernel({ dataDir: dir, plugins: [loopEcho] })
  closers = [() => kernel.close()]
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

describe('ACP bridge', () => {
  it('initialize -> newSession -> prompt echoes via chunks', async () => {
    const addr = process.platform === 'win32' ? `\\\\.\\pipe\\mffai-acp-${process.pid}` : join(dir, 'w.sock')
    const s = await startRpcServer({ addr, token: 'tok', version: HARNESS_VERSION, events: kernel.events, handle: (m, p) => kernel.handle(m, p) })
    closers.push(() => s.close())
    const { a, b } = pair()
    const bridge = runBridge({ stream: b, connect: () => connectClient({ addr, token: 'tok' }) })
    const chunks: string[] = []
    const stop = await client({ name: 't' })
      .onNotification('session/update', (ctx) => {
        const u = ctx.params.update
        if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') chunks.push(u.content.text)
      })
      .connectWith(a, async (cx) => {
        await cx.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
        const { sessionId } = await cx.request('session/new', { cwd: dir, mcpServers: [] })
        const r = await cx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
        return r.stopReason
      })
    expect(stop).toBe('end_turn')
    expect(chunks.join('')).toBe('echo: hi')
    void bridge
  })

  it('initialize fails with 未运行 when the worker is unreachable', async () => {
    const { a, b } = pair()
    const bridge = runBridge({ stream: b, connect: () => Promise.reject(new Error('ENOENT')) })
    await client({ name: 't' }).connectWith(a, async (cx) => {
      await expect(cx.request('initialize', { protocolVersion: 1, clientCapabilities: {} })).rejects.toThrow('mff-ai 未运行')
    })
    void bridge
  })
})
