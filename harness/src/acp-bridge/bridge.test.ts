import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { client, type Stream } from '@agentclientprotocol/sdk'
import { createKernel, type Kernel } from '../kernel/kernel'
import { startRpcServer } from '../kernel/rpcServer'
import { HARNESS_VERSION } from '../kernel/version'
import { connectClient, type MffaiClient } from '../protocol/index'
import loopEcho from '../plugins/loop-echo'
import type { Plugin } from '../kernel/pluginHost'
import type { KernelEvent } from '../protocol/index'
import { EarlyBuffer, runBridge } from './bridge'

let dir: string
let work: string // 会话工作目录;不能是内核数据目录(在黑名单里)
let kernel: Kernel
let closers: Array<() => unknown> = []
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mffai-acp-'))
  work = join(dir, 'work')
  mkdirSync(work)
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
  kernel = await createKernel({ dataDir: join(dir, 'data'), plugins: ps, secrets: { osBackend: false } })
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
        const { sessionId } = await cx.request('session/new', { cwd: work, mcpServers: [] })
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
      const { sessionId } = await cx.request('session/new', { cwd: work, mcpServers: [] })
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
      const { sessionId } = await cx.request('session/new', { cwd: work, mcpServers: [] })
      await expect(cx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'x' }] })).rejects.toThrow('boom')
    })
  })

  it('worker connection closing mid-prompt rejects with 连接已断开', async () => {
    const { a, workers } = await boot([hang])
    await client({ name: 't' }).connectWith(a, async (cx) => {
      await cx.request('initialize', INIT)
      const { sessionId } = await cx.request('session/new', { cwd: work, mcpServers: [] })
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

  it('session/new passes cwd to session.create; a rejected cwd is -32602', async () => {
    const { a } = await boot([loopEcho])
    await client({ name: 't' }).connectWith(a, async (cx) => {
      await cx.request('initialize', INIT)
      const { sessionId } = await cx.request('session/new', { cwd: work, mcpServers: [] })
      const created = kernel.events.after(0).find(e => e.type === 'session.created' && e.sessionId === sessionId)
      expect((created?.payload as { cwd?: string }).cwd).toBe(realpathSync.native(work))
      await expect(cx.request('session/new', { cwd: join(work, 'missing'), mcpServers: [] })).rejects.toMatchObject({ code: -32602 })
    })
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

/** 假工作进程:session.prompt 时按脚本同步吐事件(先于响应 = 走 early 缓冲),记录全部调用 */
function fakeWorker(script: { beforeReply?: KernelEvent[]; afterReply?: KernelEvent[]; onRespond?: (p: any) => KernelEvent[] }) {
  const calls: Array<{ method: string; params: any }> = []
  let listener: (e: KernelEvent) => void = () => {}
  let seq = 0
  const emit = (es: KernelEvent[]) => { for (const e of es) listener({ ...e, seq: ++seq }) }
  const c: MffaiClient = {
    async call(method: string, params?: any): Promise<any> {
      calls.push({ method, params })
      if (method === 'snapshot') return { lastSeq: 0 }
      if (method === 'events.subscribe') return {}
      if (method === 'session.create') return { sessionId: 'S' }
      if (method === 'session.prompt') {
        emit(script.beforeReply ?? [])
        setTimeout(() => emit(script.afterReply ?? []), 0)
        return { accepted: true, turnId: 'T' }
      }
      if (method === 'approval.respond') {
        setTimeout(() => emit(script.onRespond?.(params) ?? []), 0)
        return { ok: true }
      }
      return {}
    },
    onEvent(cb) { listener = cb; return () => {} },
    onClose() { return () => {} },
    close() {},
  } as MffaiClient
  return { c, calls, emit }
}
const ev = (type: string, payload: Record<string, unknown>): KernelEvent => ({ seq: 0, ts: 0, type, sessionId: 'S', payload: { turnId: 'T', ...payload } } as KernelEvent)
const ended = ev('turn.ended', {})
const asked = ev('approval.requested', { approvalId: 'A1', callId: 'c1', tool: 'shell', summary: 'npm test' })
const resolvedBy = (by: string) => ev('approval.resolved', { approvalId: 'A1', callId: 'c1', decision: 'deny', by })

async function runFake(w: ReturnType<typeof fakeWorker>, answer?: (p: any, signal: AbortSignal) => any, onStop?: () => void) {
  const { a, b } = pair()
  void runBridge({ stream: b, connect: async () => w.c })
  const updates: any[] = []
  const perms: any[] = []
  const stop = await client({ name: 't' })
    .onNotification('session/update', (ctx) => { updates.push(ctx.params.update) })
    .onRequest('session/request_permission', async (ctx) => {
      perms.push(ctx.params)
      updates.push({ sessionUpdate: 'permission' })
      return answer!(ctx.params, ctx.signal)
    })
    .connectWith(a, async (cx) => {
      await cx.request('initialize', INIT)
      const { sessionId } = await cx.request('session/new', { cwd: '/x', mcpServers: [] })
      const r = await cx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] })
      onStop?.() // 仍在连接内:此时看到的收回不是断开连接引起的
      return r.stopReason
    })
  return { stop, updates, perms }
}

describe('ACP bridge: tools and approvals', () => {
  it('tool_call / tool_call_update come in order with text chunks', async () => {
    const w = fakeWorker({ afterReply: [
      ev('message.assistant.delta', { text: 'a' }),
      ev('tool.started', { callId: 'c1', name: 'read', argsPreview: '{"path":"' + 'x'.repeat(200) + '"}' }),
      ev('tool.ended', { callId: 'c1', name: 'read', ok: true, content: 'file body' }),
      ev('tool.started', { callId: 'c2', name: 'shell', argsPreview: '{"command":"false"}' }),
      ev('tool.ended', { callId: 'c2', name: 'shell', ok: false, isError: true, content: 'exit 1' }),
      ev('message.assistant.delta', { text: 'b' }),
      ended,
    ] })
    const { stop, updates } = await runFake(w)
    expect(stop).toBe('end_turn')
    expect(updates.map(u => u.sessionUpdate)).toEqual(['agent_message_chunk', 'tool_call', 'tool_call_update', 'tool_call', 'tool_call_update', 'agent_message_chunk'])
    expect(updates[1]).toEqual({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read ' + ('{"path":"' + 'x'.repeat(200)).slice(0, 80), kind: 'read', status: 'in_progress' })
    expect(updates[2]).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file body' } }] })
    expect(updates[3]).toMatchObject({ toolCallId: 'c2', kind: 'execute', title: 'shell {"command":"false"}' })
    expect(updates[4]).toMatchObject({ toolCallId: 'c2', status: 'failed' })
  })

  it('tool kinds: read/list -> read, glob/grep -> search, write/edit/apply_patch -> edit, shell -> execute', async () => {
    const names = ['read', 'list', 'glob', 'grep', 'write', 'edit', 'apply_patch', 'shell', 'mystery']
    const w = fakeWorker({ afterReply: [...names.map((name, i) => ev('tool.started', { callId: 'c' + i, name, argsPreview: '' })), ended] })
    const { updates } = await runFake(w)
    expect(updates[8].title).toBe('mystery') // 无参数摘要时不留尾随空格
    expect(updates.map(u => u.kind)).toEqual(['read', 'read', 'search', 'search', 'edit', 'edit', 'edit', 'execute', 'other'])
  })

  for (const [label, answer, decision] of [
    ['allow', { outcome: { outcome: 'selected', optionId: 'allow' } }, 'allow'],
    ['allow_session', { outcome: { outcome: 'selected', optionId: 'allow_session' } }, 'allow_session'],
    ['reject', { outcome: { outcome: 'selected', optionId: 'deny' } }, 'deny'],
    ['cancelled outcome', { outcome: { outcome: 'cancelled' } }, 'deny'],
    ['unknown option', { outcome: { outcome: 'selected', optionId: 'bogus' } }, 'deny'],
  ] as const) {
    it(`permission ${label} -> approval.respond ${decision}`, async () => {
      const w = fakeWorker({ afterReply: [asked], onRespond: () => [ended] })
      const { stop, perms } = await runFake(w, () => answer)
      expect(stop).toBe('end_turn')
      expect(perms).toEqual([{
        sessionId: 'S',
        toolCall: { toolCallId: 'c1', title: 'npm test' },
        options: [
          { optionId: 'allow', name: '允许', kind: 'allow_once' },
          { optionId: 'allow_session', name: '本会话允许', kind: 'allow_always' },
          { optionId: 'deny', name: '拒绝', kind: 'reject_once' },
        ],
      }])
      expect(w.calls.filter(c => c.method === 'approval.respond').map(c => c.params)).toEqual([{ approvalId: 'A1', decision }])
    })
  }

  it('a failing permission request -> deny', async () => {
    const w = fakeWorker({ afterReply: [asked], onRespond: () => [ended] })
    const { stop } = await runFake(w, () => { throw new Error('client broke') })
    expect(stop).toBe('end_turn')
    expect(w.calls.filter(c => c.method === 'approval.respond').map(c => c.params)).toEqual([{ approvalId: 'A1', decision: 'deny' }])
  })

  it('an approval that arrives before the prompt response is still asked, in order', async () => {
    const w = fakeWorker({
      beforeReply: [ev('tool.started', { callId: 'c1', name: 'shell', argsPreview: '{"command":"npm test"}' }), asked],
      onRespond: () => [ev('tool.ended', { callId: 'c1', name: 'shell', ok: true, content: 'ok' }), ended],
    })
    const { stop, updates, perms } = await runFake(w, () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }))
    expect(stop).toBe('end_turn')
    expect(perms).toHaveLength(1)
    expect(updates.map(u => u.sessionUpdate)).toEqual(['tool_call', 'permission', 'tool_call_update'])
    expect(w.calls.filter(c => c.method === 'approval.respond').map(c => c.params)).toEqual([{ approvalId: 'A1', decision: 'allow' }])
  })

  /** 客户端不应答,直到请求被收回;收回后回 cancelled */
  const untilWithdrawn = (seen: { aborted: boolean }, onAsked: () => void) => (_p: unknown, signal: AbortSignal) =>
    new Promise(res => {
      signal.addEventListener('abort', () => { seen.aborted = true; res({ outcome: { outcome: 'cancelled' } }) }, { once: true })
      onAsked()
    })

  it('kernel settles the approval (timeout) -> the open permission prompt is withdrawn', async () => {
    const w = fakeWorker({ afterReply: [asked] })
    const seen = { aborted: false }
    let atStop = false
    const { stop, perms } = await runFake(w, untilWithdrawn(seen, () => w.emit([resolvedBy('timeout'), ended])), () => { atStop = seen.aborted })
    expect(stop).toBe('end_turn')
    expect(perms).toHaveLength(1)
    expect(atStop).toBe(true)
  })

  it('turn ends while the prompt is unanswered -> end_turn, prompt withdrawn', async () => {
    const w = fakeWorker({ afterReply: [asked] })
    const seen = { aborted: false }
    let atStop = false
    const { stop } = await runFake(w, untilWithdrawn(seen, () => w.emit([ended])), () => { atStop = seen.aborted })
    expect(stop).toBe('end_turn')
    expect(atStop).toBe(true)
  })

  it('requested and resolved both in the early buffer -> the client is not asked', async () => {
    const w = fakeWorker({ beforeReply: [asked, resolvedBy('user')], afterReply: [ended] })
    const { stop, perms } = await runFake(w, () => { throw new Error('must not be asked') })
    expect(stop).toBe('end_turn')
    expect(perms).toHaveLength(0)
    expect(w.calls.some(c => c.method === 'approval.respond')).toBe(false)
  })

  it('a failed notify does not drop the queue: the next permission request still goes out and is denied at once', async () => {
    const w = fakeWorker({})
    const { a, b } = pair()
    void runBridge({ stream: b, connect: async () => w.c })
    await client({ name: 't' }).connectWith(a, async (cx) => {
      await cx.request('initialize', INIT)
      const { sessionId } = await cx.request('session/new', { cwd: '/x', mcpServers: [] })
      void cx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
      await wait(() => w.calls.some(c => c.method === 'session.prompt'))
    }) // 客户端断开:之后的 notify / request 都失败
    w.emit([ev('message.assistant.delta', { text: 'a' }), asked])
    await wait(() => w.calls.some(c => c.method === 'approval.respond'))
    expect(w.calls.filter(c => c.method === 'approval.respond').map(c => c.params)).toEqual([{ approvalId: 'A1', decision: 'deny' }])
  })
})
