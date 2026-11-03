import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from './kernel'
import { startRpcServer } from './rpcServer'
import { toWire, WIRE_CONTENT_MAX, WIRE_LIST_MAX } from './wire'
import { connectClient, ExecutorNoticePayloadSchema, ExecutorRunEndedPayloadSchema, type KernelEvent } from '../protocol/index'
import { NO_SANDBOX } from '../../test/sandboxStub'

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

describe('toWire: 04 events', () => {
  const ended = (changed: object, extra: object = {}) =>
    ({ runId: 'r', turnId: 't', executor: 'codex', status: 'ok', ms: 1, changed, ...extra })
  const paths = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.ts`)

  it.each([
    ['executor.run.queued', { runId: 'r', turnId: 't', callId: 'c', executor: 'codex', summary: 'codex: x', readOnly: false, isolation: 'own', position: 0 }],
    ['executor.run.started', { runId: 'r', turnId: 't', executor: 'codex', cwd: '/w', isolation: 'own' }],
    ['executor.run.progress', { runId: 'r', turnId: 't', kind: 'text', text: 'x'.repeat(500) }],
    ['executor.run.ended', ended({ files: ['a.ts'], source: 'git' }, { violations: ['a.env'] })],
    ['executor.notice', { turnId: 't', step: 1, runId: 'r', text: 'n' }],
    ['turn.parked', { turnId: 't', step: 1, active: 1, pending: 0 }],
    ['turn.resumed', { turnId: 't', step: 1, cause: 'notice' }],
  ] as const)('%s at a normal size is returned by identity', (type, payload) => {
    const e = ev(type, payload)
    expect(toWire(e)).toBe(e)
  })

  it('cuts executor.notice text and marks it; the event itself keeps the full text', () => {
    const e = ev('executor.notice', { turnId: 't', step: 1, runId: 'r', text: 'x'.repeat(12000) })
    const w = toWire(e)
    expect(ExecutorNoticePayloadSchema.parse(w.payload)).toEqual({ turnId: 't', step: 1, runId: 'r', text: 'x'.repeat(WIRE_CONTENT_MAX), truncated: true })
    expect((e.payload as { text: string }).text).toHaveLength(12000)
  })
  it('a notice of exactly the limit is returned by identity', () => {
    const e = ev('executor.notice', { turnId: 't', runId: 'r', text: 'x'.repeat(WIRE_CONTENT_MAX) })
    expect(toWire(e)).toBe(e)
  })
  it('caps changed.files and violations and reports how many were dropped; the event keeps them all', () => {
    expect(WIRE_LIST_MAX).toBe(200)
    const e = ev('executor.run.ended', ended({ files: paths(250), source: 'git', concurrent: true }, { violations: paths(201), usage: { input: 1, output: 2 } }))
    const w = toWire(e)
    const p = ExecutorRunEndedPayloadSchema.parse(w.payload)
    expect(p.changed).toEqual({ files: paths(200), source: 'git', concurrent: true, filesTruncated: 50 })
    expect(p.violations).toEqual(paths(200))
    expect(p.violationsTruncated).toBe(1)
    expect(p.usage).toEqual({ input: 1, output: 2 })
    const stored = e.payload as { changed: { files: string[] }; violations: string[] }
    expect(stored.changed.files).toHaveLength(250)
    expect(stored.violations).toHaveLength(201)
  })
  it('caps each list on its own', () => {
    const w = toWire(ev('executor.run.ended', ended({ files: paths(201), source: 'git' }))).payload as Record<string, unknown>
    expect(w.changed).toMatchObject({ filesTruncated: 1 })
    expect(w).not.toHaveProperty('violationsTruncated')
    const v = toWire(ev('executor.run.ended', ended({ files: [], source: 'none' }, { violations: paths(201) }))).payload as Record<string, unknown>
    expect(v.changed).toEqual({ files: [], source: 'none' })
    expect(v.violationsTruncated).toBe(1)
  })
  it('lists of exactly the limit, and malformed payloads, are returned by identity', () => {
    for (const e of [
      ev('executor.run.ended', ended({ files: paths(200), source: 'git' }, { violations: paths(200) })),
      ev('executor.run.ended', { runId: 'r' }),
      ev('executor.run.ended', { changed: { files: 'nope' }, violations: 'nope' }),
      ev('executor.run.ended', null),
      ev('executor.notice', { text: 3 }),
      ev('executor.notice', null),
    ]) expect(toWire(e)).toBe(e)
  })
})

describe('toWire: 05 events', () => {
  it.each([
    ['sandbox.netDenied', { host: 'evil.example', port: 443, reason: 'not_allowed' }],
    ['permissions.updated', { rules: 3, network: 9 }],
    ['approval.requested', { approvalId: 'a', turnId: 't', callId: 'c', tool: 'shell', summary: 'x'.repeat(5000), unsandboxed: true }],
  ] as const)('%s passes unchanged (type and payload)', (type, payload) => {
    const e = ev(type, payload)
    const w = toWire(e)
    expect(w).toBe(e)
    expect(w.type).toBe(type)
    expect(w.payload).toEqual(payload)
  })
})

describe('wire view in the kernel and the server', () => {
  let dir: string
  let kernel: Kernel
  let closers: Array<() => unknown> = []
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mffai-wire-'))
    kernel = await createKernel({ sandbox: NO_SANDBOX, dataDir: dir, plugins: [], secrets: { osBackend: false } })
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

  it('permissions.updated from permissions.set reaches events.tail unchanged', async () => {
    await kernel.handle('permissions.set', { commandId: 'p1', config: { rules: [{ effect: 'deny', rule: 'shell(git push*)' }], network: { allow: ['a.example', 'b.example'] } } })
    const { events } = (await kernel.handle('events.tail', { limit: 50 })) as { events: KernelEvent[] }
    const u = events.filter(e => e.type === 'permissions.updated')
    expect(u.map(e => e.payload)).toEqual([{ rules: 1, network: 2 }])
    expect(u[0]).toEqual(kernel.events.after(0).find(e => e.type === 'permissions.updated'))
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
