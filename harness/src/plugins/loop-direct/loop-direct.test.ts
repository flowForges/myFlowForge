import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { Plugin } from '../../kernel/pluginHost'
import type { Message, ModelEvent, ModelRequest, ModelsService } from '../../lib/models/types'
import type { ModelRef } from '../../protocol/models'
import loopDirect from './index'
import loopEcho from '../loop-echo'
import { createLoopDefault } from '../loop-default'
import toolsRegistry from '../tools-registry'

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
  const k = await createKernel({ dataDir: dir, plugins, secrets: { osBackend: false } })
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
    const k = await createKernel({
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
