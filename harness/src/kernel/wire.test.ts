import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from './kernel'
import { startRpcServer } from './rpcServer'
import { toWire, WIRE_CONTENT_MAX } from './wire'
import { connectClient, type KernelEvent } from '../protocol/index'

const ev = (type: KernelEvent['type'], payload: unknown): KernelEvent => ({ seq: 1, ts: 2, type, sessionId: 's', payload })
const ended = (content: string) => ({ turnId: 't', callId: 'c', name: 'read', ok: true, ms: 1, content })
const assistant = {
  turnId: 't', step: 1, text: 'hi',
  parts: [{ type: 'reasoning', text: 'r', replay: { secret: 'opaque' } }, { type: 'text', text: 'hi' }, { type: 'tool_call', id: 'i', name: 'n', args: '{}' }],
}

describe('toWire', () => {
  it('truncates tool.ended content above 2 000 chars and marks it', () => {
    expect(WIRE_CONTENT_MAX).toBe(2000)
    const e = ev('tool.ended', ended('x'.repeat(2500)))
    const w = toWire(e)
    expect((w.payload as { content: string }).content).toBe('x'.repeat(2000))
    expect(w.payload).toMatchObject({ truncated: true, name: 'read', ok: true })
    expect({ ...w, payload: undefined }).toEqual({ ...e, payload: undefined })
    // 原事件不被改写
    expect((e.payload as { content: string }).content).toHaveLength(2500)
  })
  it('content of exactly 2 000 chars is returned by identity', () => {
    const e = ev('tool.ended', ended('y'.repeat(2000)))
    expect(toWire(e)).toBe(e)
  })
  it('does not split a surrogate pair at the cut', () => {
    const w = toWire(ev('tool.ended', ended('a'.repeat(1999) + '😀' + 'b'.repeat(10))))
    const c = (w.payload as { content: string }).content
    expect(c).toBe('a'.repeat(1999))
  })
  it('strips replay from reasoning parts of message.assistant', () => {
    const e = ev('message.assistant', assistant)
    const w = toWire(e)
    expect((w.payload as typeof assistant).parts).toEqual([
      { type: 'reasoning', text: 'r' }, { type: 'text', text: 'hi' }, { type: 'tool_call', id: 'i', name: 'n', args: '{}' },
    ])
    expect((e.payload as typeof assistant).parts[0]).toHaveProperty('replay')
  })
  it('every other event is returned by identity', () => {
    for (const e of [
      ev('message.assistant', { turnId: 't', text: 'no parts' }),
      ev('message.assistant', { turnId: 't', text: 'x', parts: [{ type: 'text', text: 'x' }] }),
      ev('tool.started', { turnId: 't', callId: 'c', name: 'read', argsPreview: 'x'.repeat(5000) }),
      ev('message.user', { turnId: 't', text: 'x'.repeat(5000) }),
      ev('tool.ended', null),
      ev('kernel.started', { version: '1' }),
    ]) expect(toWire(e)).toBe(e)
  })
})

describe('wire view in the kernel and the server', () => {
  let dir: string
  let kernel: Kernel
  let closers: Array<() => unknown> = []
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mffai-wire-'))
    kernel = await createKernel({ dataDir: dir, plugins: [], secrets: { osBackend: false } })
    closers = [() => kernel.close()]
  })
  afterEach(async () => {
    for (const c of closers.reverse()) await Promise.resolve(c()).catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })
  const seed = () => {
    kernel.events.append({ type: 'tool.ended', sessionId: 's', payload: ended('z'.repeat(3000)) })
    kernel.events.append({ type: 'message.assistant', sessionId: 's', payload: assistant })
  }
  const check = (events: KernelEvent[]) => {
    const t = events.find(e => e.type === 'tool.ended')!
    expect(t.payload).toMatchObject({ content: 'z'.repeat(2000), truncated: true })
    const m = events.find(e => e.type === 'message.assistant')!
    expect((m.payload as typeof assistant).parts[0]).toEqual({ type: 'reasoning', text: 'r' })
  }

  it('events.tail is the wire view; the event log row stays full', async () => {
    seed()
    const { events } = (await kernel.handle('events.tail', { limit: 10 })) as { events: KernelEvent[] }
    check(events)
    const full = kernel.events.bySession('s')
    expect((full[0].payload as { content: string }).content).toHaveLength(3000)
    expect(full[0].payload).not.toHaveProperty('truncated')
    expect((full[1].payload as typeof assistant).parts[0]).toEqual(assistant.parts[0])
  })

  it('subscribe push (backlog and live) is the wire view', async () => {
    const addr = process.platform === 'win32' ? `\\\\.\\pipe\\mffai-wire-${process.pid}-${Date.now()}` : join(dir, 'w.sock')
    const s = await startRpcServer({ addr, token: 'tok', version: 'v', events: kernel.events, handle: (m, p) => kernel.handle(m, p) })
    closers.push(() => s.close())
    seed()
    const c = await connectClient({ addr, token: 'tok' })
    closers.push(() => c.close())
    const got: KernelEvent[] = []
    c.onEvent(e => got.push(e))
    await c.call('events.subscribe', { after: 0 })
    seed()
    for (let i = 0; i < 400 && got.filter(e => e.sessionId === 's').length < 4; i++) await new Promise(r => setTimeout(r, 5))
    const mine = got.filter(e => e.sessionId === 's')
    expect(mine).toHaveLength(4)
    check(mine.slice(0, 2))
    check(mine.slice(2))
  })
})
