import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { Plugin } from '../../kernel/pluginHost'
import type { Message, ModelEvent, ModelRequest, ModelsService } from '../../lib/models/types'
import type { ModelRef } from '../../protocol/models'
import { ERR_BUSY, type KernelEvent } from '../../protocol/index'
import loopDirect, { buildHistory } from './index'
import loopEcho from '../loop-echo'
import { createLoopDefault } from '../loop-default'
import toolsRegistry from '../tools-registry'
import { NO_SANDBOX } from '../../../test/sandboxStub'
import { fakeModels as rigModels, memoryKernel, say, type MemoryRig } from '../../../test/memoryRig'
import { createMemoryDefault } from '../memory-default/index'

let dir: string
let kernels: Kernel[] = []
let cleanups: (() => void)[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mffai-loopdirect-')) })
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  rmSync(dir, { recursive: true, force: true })
  for (const c of cleanups) c()
  cleanups = []
})

interface Fake { calls: { ref: ModelRef | 'default'; req: Omit<ModelRequest, 'model'> }[] }
/** 假 models 服务:script 决定每次 stream 产出的事件 */
function fakeModels(fake: Fake, script: (req: Omit<ModelRequest, 'model'>) => AsyncIterable<ModelEvent>, def?: ModelRef): Plugin {
  const service = {
    catalog: () => ({ default: def }),
    stream(ref: ModelRef | 'default', req: Omit<ModelRequest, 'model'>) {
      fake.calls.push({ ref, req })
      return script(req)
    },
  } as unknown as ModelsService
  return {
    manifest: { id: 'fake-models', version: '0', kernel: '^0.1.0', provides: ['models'] },
    activate: ctx => ctx.services.provide('models', service),
  }
}
async function* seq(...evs: ModelEvent[]) { for (const e of evs) yield e }
const done = (reason: 'stop' | 'length' | 'tool_calls' | 'cancelled' = 'stop'): ModelEvent => ({ type: 'done', reason })

async function boot(plugins: Plugin[]) {
  const k = await createKernel({ sandbox: NO_SANDBOX, dataDir: dir, plugins, secrets: { osBackend: false } })
  kernels.push(k)
  return k
}
const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise(r => setTimeout(r, 5))
  expect(fn()).toBe(true)
}
const create = async (k: Kernel, model?: ModelRef) =>
  ((await k.handle('session.create', { commandId: `c${Math.random()}`, ...(model && { model }) })) as { sessionId: string }).sessionId
const prompt = (k: Kernel, sessionId: string, text: string) =>
  k.handle('session.prompt', { commandId: `p${Math.random()}`, sessionId, text })
const terminal = (k: Kernel, sid: string) => k.events.bySession(sid).filter(e => e.type === 'turn.ended' || e.type === 'turn.failed')
const REF: ModelRef = { accountId: 'a', modelId: 'm' }
const texts = (m: Message[]) => m.map(x => `${x.role}:${x.parts.map(p => (p.type === 'text' ? p.text : '?')).join('')}`)

describe('loop-direct', () => {
  it('no session model and no default: loop-echo answers', async () => {
    const fake: Fake = { calls: [] }
    const k = await boot([fakeModels(fake, () => seq(done())), loopDirect, loopEcho])
    const sid = await create(k)
    await prompt(k, sid, 'hi')
    await waitFor(() => terminal(k, sid).length > 0)
    expect(fake.calls).toHaveLength(0)
    expect(k.events.bySession(sid).find(e => e.type === 'message.assistant')?.payload).toMatchObject({ text: 'echo: hi' })
  })

  it('session model is stored in session.created and used; events in order incl. usage', async () => {
    const fake: Fake = { calls: [] }
    const k = await boot([
      fakeModels(fake, () => seq(
        { type: 'text', delta: 'He' }, { type: 'text', delta: 'llo' },
        { type: 'usage', input: 3, output: 2, cacheRead: 1 }, done())),
      loopDirect, loopEcho,
    ])
    const sid = await create(k, REF)
    expect(k.events.bySession(sid)[0].payload).toMatchObject({ model: REF })
    await prompt(k, sid, 'hi')
    await waitFor(() => terminal(k, sid).length > 0)
    expect(fake.calls[0].ref).toEqual(REF)
    expect(fake.calls[0].req).toMatchObject({ interactive: true, reasoning: 'medium' })
    const evs = k.events.bySession(sid)
    expect(evs.map(e => e.type)).toEqual([
      'session.created', 'message.user', 'turn.started', 'message.assistant.delta', 'message.assistant.delta',
      'turn.usage', 'message.assistant', 'turn.ended',
    ])
    expect(evs.find(e => e.type === 'turn.usage')?.payload).toMatchObject({ input: 3, output: 2, cacheRead: 1 })
    expect(evs.find(e => e.type === 'message.assistant')?.payload).toMatchObject({ text: 'Hello' })
  })

  it('uses the registry default when the session has no model', async () => {
    const fake: Fake = { calls: [] }
    const k = await boot([fakeModels(fake, () => seq({ type: 'text', delta: 'x' }, done()), REF), loopDirect, loopEcho])
    const sid = await create(k)
    await prompt(k, sid, 'hi')
    await waitFor(() => terminal(k, sid).length > 0)
    expect(fake.calls[0].ref).toBe('default')
  })

  it('passes prior turns in order, skips failed turns, current prompt last exactly once', async () => {
    const fake: Fake = { calls: [] }
    let n = 0
    const k = await boot([
      fakeModels(fake, () => {
        n++
        if (n === 2) return seq({ type: 'text', delta: 'part' }, { type: 'done', reason: 'error', error: { kind: 'network', message: 'cut', retryable: true } })
        return seq({ type: 'text', delta: `a${n}` }, done())
      }),
      loopDirect, loopEcho,
    ])
    const sid = await create(k, REF)
    for (const t of ['q1', 'q2', 'q3', 'q4']) {
      await prompt(k, sid, t)
      const want = terminal(k, sid).length + 1
      await waitFor(() => terminal(k, sid).length === want)
    }
    expect(texts(fake.calls[0].req.messages)).toEqual(['user:q1'])
    expect(texts(fake.calls[2].req.messages)).toEqual(['user:q1', 'assistant:a1', 'user:q3'])
    expect(texts(fake.calls[3].req.messages)).toEqual(['user:q1', 'assistant:a1', 'user:q3', 'assistant:a3', 'user:q4'])
  })

  it('records reasoning deltas', async () => {
    const fake: Fake = { calls: [] }
    const k = await boot([
      fakeModels(fake, () => seq({ type: 'reasoning', delta: 'think' }, { type: 'reasoning', replay: { s: 1 } }, { type: 'text', delta: 'ok' }, done())),
      loopDirect, loopEcho,
    ])
    const sid = await create(k, REF)
    await prompt(k, sid, 'hi')
    await waitFor(() => terminal(k, sid).length > 0)
    const r = k.events.bySession(sid).filter(e => e.type === 'message.reasoning.delta')
    expect(r.map(e => e.payload)).toMatchObject([{ text: 'think' }])
  })

  it('partial text then network error keeps the deltas and fails the turn with reason network', async () => {
    const fake: Fake = { calls: [] }
    const k = await boot([
      fakeModels(fake, () => seq(
        { type: 'text', delta: 'par' }, { type: 'text', delta: 'tial' },
        { type: 'done', reason: 'error', error: { kind: 'network', message: 'socket reset', retryable: true } })),
      loopDirect, loopEcho,
    ])
    const sid = await create(k, REF)
    await prompt(k, sid, 'hi')
    await waitFor(() => terminal(k, sid).length > 0)
    const evs = k.events.bySession(sid)
    expect(evs.filter(e => e.type === 'message.assistant.delta').map(e => (e.payload as { text: string }).text)).toEqual(['par', 'tial'])
    expect(evs.some(e => e.type === 'message.assistant')).toBe(false)
    const t = terminal(k, sid)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ type: 'turn.failed', payload: { reason: 'network', message: 'socket reset' } })
  })

  it('cancel yields turn.failed cancelled', async () => {
    const fake: Fake = { calls: [] }
    const k = await boot([
      fakeModels(fake, async function* (req) {
        yield { type: 'text', delta: 'x' } as ModelEvent
        await new Promise<void>(r => req.signal.addEventListener('abort', () => r()))
        yield done('cancelled')
      }),
      loopDirect, loopEcho,
    ])
    const sid = await create(k, REF)
    await prompt(k, sid, 'hi')
    await waitFor(() => k.events.bySession(sid).some(e => e.type === 'message.assistant.delta'))
    await k.handle('session.cancel', { commandId: 'x', sessionId: sid })
    await waitFor(() => terminal(k, sid).length > 0)
    const t = terminal(k, sid)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ type: 'turn.failed', payload: { reason: 'cancelled' } })
  })

  it('a cwd session reaches loop-direct when loop-default is disabled in config', async () => {
    // 工作目录不能在数据目录里(凭据黑名单)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-loopdirect-cwd-')))
    const cwd = join(root, 'repo')
    mkdirSync(cwd)
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ plugins: { disabled: ['loop-default'] } }))
    const fake: Fake = { calls: [] }
    const k = await createKernel({ sandbox: NO_SANDBOX,
      dataDir: dir, home: join(root, 'home'), secrets: { osBackend: false },
      plugins: [fakeModels(fake, () => seq({ type: 'text', delta: 'direct' }, done())), toolsRegistry, createLoopDefault(), loopDirect, loopEcho],
    })
    kernels.push(k)
    expect(k.status().plugins.find(p => p.id === 'loop-default')?.state).toBe('disabled')
    const sid = ((await k.handle('session.create', { commandId: 'c-cwd', model: REF, cwd })) as { sessionId: string }).sessionId
    expect(k.events.bySession(sid)[0].payload).toMatchObject({ cwd })
    await prompt(k, sid, 'hi')
    await waitFor(() => terminal(k, sid).length > 0)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].req.tools).toBeUndefined()
    expect(k.events.bySession(sid).find(e => e.type === 'message.assistant')?.payload).toEqual({ turnId: expect.any(String), text: 'direct' }) // 没有 step / parts:是 loop-direct 写的
    expect(terminal(k, sid)[0].type).toBe('turn.ended')
  })
})

describe('loop-direct: a follow-up from a parked turn (spec §7.6)', () => {
  const ev = (seq: number, type: string, payload: object): KernelEvent => ({ seq, ts: seq, type, sessionId: 's', payload } as KernelEvent)

  it('buildHistory skips followUp messages: one question, one answer, no duplicate', () => {
    const out = buildHistory([
      ev(1, 'message.user', { turnId: 't1', text: 'first' }),
      ev(2, 'message.user', { turnId: 't1', text: 'second', followUp: true }),
      ev(3, 'message.assistant', { turnId: 't1', text: 'answer' }),
      ev(4, 'turn.ended', { turnId: 't1' }),
    ], 't2', 'now')
    expect(texts(out)).toEqual(['user:first', 'assistant:answer', 'user:now'])
  })

  it('a loop-direct turn never parks: session.prompt during it is ERR_BUSY', async () => {
    const fake: Fake = { calls: [] }
    const k = await boot([
      fakeModels(fake, async function* (req) {
        yield { type: 'text', delta: 'x' } as ModelEvent
        await new Promise<void>(r => req.signal.addEventListener('abort', () => r()))
        yield done('cancelled')
      }),
      loopDirect, loopEcho,
    ])
    const sid = await create(k, REF)
    await prompt(k, sid, 'hi')
    await waitFor(() => k.events.bySession(sid).some(e => e.type === 'message.assistant.delta'))
    await expect(prompt(k, sid, 'again')).rejects.toMatchObject({ code: ERR_BUSY })
    expect(k.events.bySession(sid).filter(e => e.type === 'message.user')).toHaveLength(1)
  })
})

describe('buildHistory: memory blocks (06 spec §7)', () => {
  let seq = 0
  const ev = (type: KernelEvent['type'], payload: object): KernelEvent => ({ seq: ++seq, ts: seq, type, sessionId: 's', payload })
  const injected = (turnId: string, kind: string, text: string) => ev('memory.injected', { turnId, kind, text, items: [] })
  const partsOf = (m: Message) => m.parts.map(p => (p as { text: string }).text)

  it('the session block is in the first message; each turn block in its own turn', () => {
    const out = buildHistory([
      ev('message.user', { turnId: 't1', text: 'q1' }),
      injected('t1', 'session', 'S'),
      injected('t1', 'turn', 'T1'),
      ev('message.assistant', { turnId: 't1', text: 'a1' }),
      ev('turn.ended', { turnId: 't1' }),
      ev('message.user', { turnId: 't2', text: 'q2' }),
      injected('t2', 'turn', 'T2'),
    ], 't2', 'q2')
    expect(out.map(partsOf)).toEqual([['S', 'T1', 'q1'], ['a1'], ['T2', 'q2']])
  })

  it('the first turn failed: the session block moves to the next message, the failed turn block is gone', () => {
    const out = buildHistory([
      ev('message.user', { turnId: 't1', text: 'q1' }),
      injected('t1', 'session', 'S'),
      injected('t1', 'turn', 'T1'),
      ev('turn.failed', { turnId: 't1' }),
      ev('message.user', { turnId: 't2', text: 'q2' }),
    ], 't2', 'q2')
    expect(out.map(partsOf)).toEqual([['S', 'q2']])
  })

  it('no block: one text part, as before', () => {
    expect(buildHistory([ev('message.user', { turnId: 't1', text: 'q1' })], 't1', 'q1')).toEqual([{ role: 'user', parts: [{ type: 'text', text: 'q1' }] }])
  })
})

describe('loop-direct with memory (06 spec §7)', () => {
  let r: MemoryRig | undefined
  afterEach(async () => {
    await r?.close()
    r = undefined
  })

  const boot = async (script: Parameters<typeof rigModels>[0] = {}, plugins: Plugin[] = [createMemoryDefault({ nightly: false }), loopDirect]) => {
    const models = rigModels(script)
    r = await memoryKernel({ models, plugins })
    const rig = r
    const pluginFiles = join(rig.dataDir, 'plugins', 'memory-default', 'files')
    const finished = (sid: string, n: number) => waitFor(() => terminal(rig.k, sid).length === n)
    return {
      models,
      rig,
      finished,
      write: (name: string, content: string) => writeFileSync(join(pluginFiles, name), content),
      create: async (params: object = {}) => ((await rig.k.handle('session.create', { commandId: `c${Math.random()}`, ...params })) as { sessionId: string }).sessionId,
    }
  }
  const messageTexts = (m: Message) => m.parts.map(p => (p as { text: string }).text)

  it('the request carries the session block and the update, and the prefix does not move', async () => {
    const h = await boot()
    h.write('USER.md', '- 用 pnpm\n')
    const sid = await h.create()
    await prompt(h.rig.k, sid, 'one')
    await h.finished(sid, 1)
    h.write('USER.md', '- 用 yarn\n')
    await prompt(h.rig.k, sid, 'two')
    await h.finished(sid, 2)
    await prompt(h.rig.k, sid, 'three')
    await h.finished(sid, 3)

    const [a, b, c] = h.models.foreground().map(x => x.req.messages)
    const first = messageTexts(a[0])
    expect(first).toHaveLength(2)
    expect(first[0]).toContain('<memory kind="core">')
    expect(first[0]).toContain('用 pnpm')
    expect(first[1]).toBe('one')
    expect(JSON.stringify(b.slice(0, a.length))).toBe(JSON.stringify(a))
    const update = messageTexts(b[b.length - 1])
    expect(update[0]).toContain('<memory-update>')
    expect(update[0]).toContain('用 yarn')
    expect(update[1]).toBe('two')
    expect(JSON.stringify(c.slice(0, b.length))).toBe(JSON.stringify(b))
    expect(messageTexts(c[c.length - 1])).toEqual(['three'])
    // 重启前后,buildHistory 还原出的就是发出去的字节
    await h.rig.restart()
    expect(JSON.stringify(buildHistory(h.rig.k.events.bySession(sid), 'later', 'x').slice(0, c.length))).toBe(JSON.stringify(c))
  })

  it('an update in a failed turn is sent again; the failed turn leaves the history', async () => {
    let fail = false
    const h = await boot({
      script: () => (fail ? seq({ type: 'done', reason: 'error', error: { kind: 'unavailable', message: 'no', retryable: false } }) : say('ok')),
    })
    h.write('USER.md', '- u1\n')
    const sid = await h.create()
    await prompt(h.rig.k, sid, 'one')
    await h.finished(sid, 1)
    h.write('USER.md', '- u2\n')
    fail = true
    await prompt(h.rig.k, sid, 'two')
    await h.finished(sid, 2)
    fail = false
    await prompt(h.rig.k, sid, 'three')
    await h.finished(sid, 3)
    const last = h.models.foreground()[2].req.messages
    expect(last).toHaveLength(3)
    const parts = messageTexts(last[2])
    expect(parts[0]).toContain('<memory-update>')
    expect(parts[0]).toContain('u2')
    expect(parts[1]).toBe('three')
  })

  it('a group session gets no core; no event is written for an empty core; one that yields to echo writes none', async () => {
    const h = await boot()
    h.write('USER.md', '- OWNER-MARKER\n')
    const group = await h.create({ origin: 'im' })
    await prompt(h.rig.k, group, 'hello there')
    await h.finished(group, 1)
    expect(JSON.stringify(h.models.foreground()[0].req.messages)).not.toContain('OWNER-MARKER')
    expect(h.rig.k.events.bySession(group).filter(e => e.type === 'memory.injected')).toEqual([])
  })

  it('without a model it yields before injecting, so echo leaves no block behind', async () => {
    const r0 = await memoryKernel({ plugins: [createMemoryDefault({ nightly: false }), loopDirect, loopEcho] })
    r = r0
    writeFileSync(join(r0.dataDir, 'plugins', 'memory-default', 'files', 'USER.md'), '- u1\n')
    const sid = ((await r0.k.handle('session.create', { commandId: 'c' })) as { sessionId: string }).sessionId
    await prompt(r0.k, sid, 'hi')
    await waitFor(() => terminal(r0.k, sid).length === 1)
    expect(r0.k.events.bySession(sid).filter(e => e.type === 'memory.injected')).toEqual([])
  })
})
