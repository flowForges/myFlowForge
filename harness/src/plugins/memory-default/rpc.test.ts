// memory.* RPC(06 spec §16),全部经 kernel.handle;Review Focus 7。真 loop-default、假模型。
// 字节比较的用例里没有密钥,也不触发 LoopGuard 提醒:那两样不在"逐字节一致"的范围内(04 spec)
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REDACTED } from '../../kernel/eventLog'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import type { Message, ModelEvent } from '../../lib/models/types'
import type { ToolResult, ToolsService } from '../../lib/tools/types'
import type { KernelEvent } from '../../protocol/events'
import { ERR_BUSY, ERR_DRAINING, MemoryHealthSchema } from '../../protocol/rpc'
import { calling, done, fakeModels, memoryKernel, say, type FakeModels, type MemoryRig } from '../../../test/memoryRig'
import { buildMessages } from '../loop-default/history'
import { createLoopDefault } from '../loop-default'
import toolsRegistry from '../tools-registry'
import { CONSOLIDATION_CURSOR } from './store'
import { createMemoryDefault, type MemoryDefaultOpts, type MemoryDefaultPlugin } from './index'

type Stream = () => AsyncIterable<ModelEvent>

const NOTE = '部署端口固定用 5173 不要改动它'
const CHUNKS = ['部署端口固定', '用 5173 不要改动它']
const EVIDENCE = '记一下以后发布都走那个老地方'
const ALL = 1_000_000

let rig: MemoryRig | undefined
afterEach(async () => {
  await rig?.close()
  rig = undefined
})

interface H {
  r: MemoryRig
  models: FakeModels
  queue: Stream[]
  ctx(): PluginContext
  memory(): MemoryDefaultPlugin
  dir: string
  files: string
  write(name: string, content: string): void
  read(name: string): string
  session(params?: object): Promise<string>
  prompt(sessionId: string, text: string): Promise<string>
  call(name: string, args: unknown, sessionId: string, turnId?: string): Promise<ToolResult>
  events(): KernelEvent[]
  /** 数据目录里所有持久化的字节,WAL、Markdown、落盘文件都算 */
  bytes(): string
  /** 下一次 restart 时,旧内核关掉之后、新内核打开之前跑 */
  beforeReopen(fn: () => void): void
  /** 一条带证据的主人笔记 */
  seedNote(text?: string, id?: string): Promise<{ evidenceSeq: number; witness: string }>
}

async function boot(opts: MemoryDefaultOpts = {}): Promise<H> {
  const queue: Stream[] = []
  const models = fakeModels({ script: () => (queue.shift() ?? (() => say('ok')))() })
  let ctx!: PluginContext
  let memory!: MemoryDefaultPlugin
  let reopen: (() => void) | undefined
  const probe: Plugin = { manifest: { id: 'probe', version: '0', kernel: '^0.1.0' }, activate: c => { ctx = c } }
  rig = await memoryKernel({
    models,
    plugins: () => {
      reopen?.()
      reopen = undefined
      memory = createMemoryDefault({ nightly: false, ...opts })
      return [toolsRegistry, memory, createLoopDefault(), probe]
    },
  })
  const r = rig
  const dir = join(r.dataDir, 'plugins', 'memory-default')
  const files = join(dir, 'files')
  let n = 0
  const walk = (d: string): string[] =>
    existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []
  const h: H = {
    r,
    models,
    queue,
    ctx: () => ctx,
    memory: () => memory,
    dir,
    files,
    write: (name, content) => writeFileSync(join(files, name), content),
    read: name => readFileSync(join(files, name), 'utf8'),
    async session(params = {}) {
      return ((await r.k.handle('session.create', { commandId: `c${++n}`, cwd: r.cwd, ...params })) as { sessionId: string }).sessionId
    },
    async prompt(sessionId, text) {
      const { turnId } = (await r.k.handle('session.prompt', { commandId: `p${++n}`, sessionId, text })) as { turnId: string }
      for (let i = 0; i < 2000; i++) {
        if (r.k.events.bySession(sessionId).some(e => (e.type === 'turn.ended' || e.type === 'turn.failed') && (e.payload as { turnId: string }).turnId === turnId)) return turnId
        await new Promise(res => setTimeout(res, 5))
      }
      throw new Error('turn did not finish')
    },
    call(name, args, sessionId, turnId = 't-tool') {
      return ctx.services.get<ToolsService>('tools')!.call(name, JSON.stringify(args), { sessionId, turnId, callId: `tc${++n}`, cwd: r.cwd, spillDir: join(r.dataDir, 'sessions', sessionId, 'spill'), signal: new AbortController().signal })
    },
    events: () => r.k.events.after(0, ALL),
    bytes: () => walk(r.dataDir).filter(f => !f.endsWith('-shm')).map(f => `${f}\n${readFileSync(f).toString('utf8')}`).join('\n'),
    beforeReopen: fn => {
      reopen = fn
    },
    async seedNote(text = NOTE, id = 'n_seed') {
      const witness = await h.session()
      const evidence = ctx.append({ type: 'message.user', sessionId: witness, payload: { turnId: `w-${id}`, text: EVIDENCE } })
      ctx.append({ type: 'turn.ended', sessionId: witness, payload: { turnId: `w-${id}` } })
      const prior = existsSync(join(files, 'MEMORY.md')) ? h.read('MEMORY.md') : ''
      h.write('MEMORY.md', `${prior}- ${text} <!-- mff id=${id} src=confirmed ts=1793000000000 ev=r_${evidence.seq} -->\n`)
      return { evidenceSeq: evidence.seq, witness }
    },
  }
  return h
}

const handle = <T = Record<string, unknown>>(h: H, method: string, params: object = {}) => h.r.k.handle(method as never, params as never) as Promise<T>
const del = (h: H, id: string, commandId = `del-${id}`) => handle<{ ok: boolean; redacted: number; sources: string[] }>(h, 'memory.delete', { commandId, id })
const health = (h: H) => handle<{ problems: string[]; rawRows: number; noteRows: number; cursorLag: number; pendingProposals: number; dbBytes: number }>(h, 'memory.health')
const search = (h: H, query: string, extra: object = {}) => handle<{ items: { id: string; scope?: string; layer: string; text: string }[] }>(h, 'memory.search', { query, ...extra })
const list = (h: H, params: object = {}) => handle<{ items: { id: string; ts: number; layer: string; text: string; scope?: string }[] }>(h, 'memory.list', params)
const hashOf = async (h: H, file: string) => (await handle<{ hash: string }>(h, 'memory.file.get', { file })).hash
const setFile = async (h: H, file: string, content: string, commandId?: string) =>
  handle<{ ok: boolean; hash: string; masked: number }>(h, 'memory.file.set', { commandId: commandId ?? `set-${Math.random()}`, file, content, expectedHash: await hashOf(h, file) })
const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: number }) => e.code)
const ofType = (h: H, type: string) => h.events().filter(e => e.type === type)
const textOf = (e: KernelEvent) => (e.payload as { text?: string }).text
const count = (h: H, sql: string) => (h.memory().inspect().store.db.prepare(sql).get() as { n: number }).n

/** 请求里每个 tool_call 都有 tool_result,没有孤立的 */
function expectPaired(messages: Message[]) {
  const calls = messages.flatMap(m => m.parts.flatMap(p => (p.type === 'tool_call' ? [p.id] : [])))
  const results = messages.flatMap(m => m.parts.flatMap(p => (p.type === 'tool_result' ? [p.callId] : [])))
  expect(results.sort()).toEqual(calls.sort())
}

const json = (v: unknown) => JSON.stringify(v)
const assistant = (text: string): Message => ({ role: 'assistant', parts: [{ type: 'text', text }] })

/** 这一步思考和正文都引用了笔记,分块到达,再 memory_write 它 */
async function* quotingStep(callId: string, text = NOTE): AsyncIterable<ModelEvent> {
  yield { type: 'reasoning', delta: CHUNKS[0] }
  yield { type: 'reasoning', delta: CHUNKS[1], replay: { thinking: text, signature: 'sig' } }
  yield { type: 'text', delta: CHUNKS[0] }
  yield { type: 'text', delta: CHUNKS[1] }
  yield { type: 'tool_call', id: callId, name: 'memory_write', argsDelta: JSON.stringify({ text }) }
  yield done('tool_calls')
}

/** 短笔记:思考和正文也引用了它 */
async function* quotingStepShort(callId: string, text: string): AsyncIterable<ModelEvent> {
  yield { type: 'reasoning', delta: text, replay: { thinking: text, signature: 'sig' } }
  yield { type: 'text', delta: `好的 ${text}` }
  yield { type: 'tool_call', id: callId, name: 'memory_write', argsDelta: JSON.stringify({ text }) }
  yield done('tool_calls')
}

/** Review Focus 7 的种子:注入过、搜到过、memory_write 写过,A 里有一份检查点 */
async function seedFull(h: H) {
  const seeded = await h.seedNote()
  const a = await h.session()
  h.queue.push(() => calling('c-search', 'memory_search', { query: '5173' }), () => quotingStep('c-write'), () => say('记住了'))
  const firstTurn = await h.prompt(a, '端口的事情你怎么看')
  h.ctx().append({ type: 'memory.checkpoint', sessionId: a, payload: { throughSeq: 1, asOfSeq: 1, text: '目标是发布,摘要里没有那句原话', model: 'm', tokens: 1, covers: 1 } })
  return { ...seeded, a, firstTurn }
}

describe('reads', () => {
  it('memory.list: newest first, paged by before, and no row is lost at a tie', async () => {
    const h = await boot({ now: () => 1000 })
    h.write('USER.md', '- a line\n- b line\n- c line\n- d line\n')
    const first = await list(h, { layer: 'user', limit: 2 })
    expect(first.items.length).toBeGreaterThanOrEqual(2)
    const seen = new Set(first.items.map(i => i.id))
    const rest = await list(h, { layer: 'user', limit: 2, before: first.items.at(-1)!.ts })
    for (const i of rest.items) seen.add(i.id)
    expect(seen.size).toBe(4)
  })

  it('memory.list: ordered across layers by time, raw rows are r_<seq>, and rolled back rows are not listed', async () => {
    let t = 1000
    const h = await boot({ now: () => (t += 1) })
    const sid = await h.session()
    h.write('USER.md', `- 手写的一行 <!-- mff id=n_old src=user ts=5 -->\n`)
    const keep = h.ctx().append({ type: 'message.user', sessionId: sid, payload: { turnId: 'keep', text: '留下的这句话' } })
    h.ctx().append({ type: 'message.user', sessionId: sid, payload: { turnId: 'undo', text: '撤销的这句话' } })
    h.ctx().append({ type: 'turn.rolledBack', sessionId: sid, payload: { turnId: 'undo', files: 0 } })
    const { items } = await list(h)
    expect(items.map(i => i.id)).toEqual([`r_${keep.seq}`, 'n_old'])
    expect(items[0]).toMatchObject({ layer: 'raw', scope: 'owner', text: '留下的这句话' })
    const older = await list(h, { before: keep.ts })
    expect(older.items.map(i => i.id)).toEqual(['n_old'])
  })

  it('memory.get: n_, h_ and r_ ids with source and evidence; a bad id is -32602', async () => {
    const h = await boot()
    const { evidenceSeq } = await h.seedNote()
    h.write('USER.md', '- 手写的这一行\n')
    const note = await handle(h, 'memory.get', { id: 'n_seed' })
    expect(note).toMatchObject({ id: 'n_seed', layer: 'memory', text: NOTE, source: 'confirmed', evidence: [`r_${evidenceSeq}`], scope: 'owner', file: 'MEMORY.md' })
    const hand = (await list(h, { layer: 'user' })).items[0]
    expect(hand.id).toMatch(/^h_/)
    expect(await handle(h, 'memory.get', { id: hand.id })).toMatchObject({ source: 'user', text: '手写的这一行', evidence: [] })
    expect(await handle(h, 'memory.get', { id: `r_${evidenceSeq}` })).toMatchObject({ id: `r_${evidenceSeq}`, layer: 'raw', text: EVIDENCE, source: 'user' })
    for (const id of ['n_missing', 'r_999999', 'r_12x']) expect(await codeOf(handle(h, 'memory.get', { id })), id).toBe(-32602)
  })

  it('memory.search sees group notes with their scope, and the tool in an owner session does not', async () => {
    const h = await boot()
    const group = await h.session({ origin: 'im', cwd: undefined })
    const owner = await h.session()
    const written = await h.call('memory_write', { text: 'GROUP-NOTE-MARKER 群里的一条笔记' }, group)
    await h.seedNote('OWNER-NOTE-MARKER 主人的一条笔记')
    h.ctx().append({ type: 'message.user', sessionId: group, payload: { turnId: 'g', text: 'GROUP-NOTE-MARKER 群里的原话' } })
    const { items } = await search(h, 'GROUP-NOTE-MARKER')
    expect(items.find(i => i.id === written.meta!.id)).toMatchObject({ layer: 'session', scope: `session:${group}` })
    expect(items.find(i => i.layer === 'raw')).toMatchObject({ scope: `session:${group}` })
    expect((await h.call('memory_search', { query: 'GROUP-NOTE-MARKER' }, owner)).content).not.toContain('GROUP-NOTE-MARKER 群')
    expect((await search(h, 'OWNER-NOTE-MARKER')).items[0]).toMatchObject({ scope: 'owner' })
    expect((await search(h, 'MARKER', { layer: 'raw' })).items.every(i => i.layer === 'raw')).toBe(true)
    expect((await search(h, 'MARKER', { layer: 'notes' })).items.every(i => i.layer !== 'raw')).toBe(true)
  })

  it('limits on search, list and changes are capped in the plugin; a giant query is refused', async () => {
    const h = await boot()
    h.write('MEMORY.md', Array.from({ length: 150 }, (_, i) => `- 同一个词 capword 第 ${i} 行 <!-- mff id=n_${i} src=user ts=${1000 + i} -->`).join('\n'))
    const huge = { limit: 1_000_000_000 }
    expect((await search(h, 'capword', huge)).items.length).toBe(100)
    expect((await list(h, huge)).items.length).toBe(100)
    for (let i = 0; i < 120; i++) await handle(h, 'memory.update', { commandId: `u${i}`, id: 'n_1', text: `改写 ${i}` })
    expect((await handle<{ items: unknown[] }>(h, 'memory.changes', huge)).items.length).toBe(100)
    expect(await codeOf(search(h, 'x'.repeat(201)))).toBe(-32602)
  })

  it('memory.changes: newest first, with the before and after text', async () => {
    const h = await boot()
    await h.seedNote()
    await handle(h, 'memory.update', { commandId: 'u1', id: 'n_seed', text: '第一次改' })
    await handle(h, 'memory.update', { commandId: 'u2', id: 'n_seed', text: '第二次改' })
    const { items } = await handle<{ items: { id: string; op: string; before: string; after: string; file: string; source: string; ts: number }[] }>(h, 'memory.changes', { limit: 2 })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ id: 'n_seed', op: 'update', before: '第一次改', after: '第二次改', file: 'MEMORY.md', source: 'user' })
  })

  it('a long raw row is clipped in list and whole in get', async () => {
    const h = await boot()
    const sid = await h.session()
    const long = '长'.repeat(3000)
    const e = h.ctx().append({ type: 'message.user', sessionId: sid, payload: { turnId: 't', text: long } })
    const row = (await list(h, { layer: 'raw' })).items.find(i => i.id === `r_${e.seq}`)!
    expect(row.text.length).toBeLessThan(1000)
    expect(await handle(h, 'memory.get', { id: `r_${e.seq}` })).toMatchObject({ text: long })
  })
})

describe('writes', () => {
  it('memory.update rewrites the Markdown line, scrubbed, and replaying the commandId writes nothing', async () => {
    const h = await boot()
    await h.seedNote()
    const secret = 'sk-' + 'x'.repeat(24)
    const params = { commandId: 'u1', id: 'n_seed', text: `新的说法 ${secret}` }
    expect(await handle(h, 'memory.update', params)).toEqual({ ok: true, masked: 1 })
    expect(h.read('MEMORY.md')).toContain('新的说法')
    expect(h.read('MEMORY.md')).toContain('id=n_seed')
    expect(h.read('MEMORY.md')).not.toContain(secret)
    expect(h.read('MEMORY.md')).not.toContain(NOTE)
    const updates = ofType(h, 'memory.updated').length
    expect(await handle(h, 'memory.update', params)).toEqual({ ok: true, masked: 1 })
    expect(ofType(h, 'memory.updated')).toHaveLength(updates)
  })

  it('memory.update of a session-layer note stays in SQLite; of a raw row or unknown id it is -32602', async () => {
    const h = await boot()
    const group = await h.session({ origin: 'im' })
    const { meta } = await h.call('memory_write', { text: '群笔记原文' }, group)
    expect(await handle(h, 'memory.update', { commandId: 'u1', id: meta!.id, text: '群笔记改过' })).toEqual({ ok: true, masked: 0 })
    expect(await handle(h, 'memory.get', { id: meta!.id })).toMatchObject({ text: '群笔记改过', layer: 'session' })
    expect(readdirSync(join(h.files, 'diary'))).toEqual([])
    const e = h.ctx().append({ type: 'message.user', sessionId: group, payload: { turnId: 't', text: '一句话' } })
    expect(await codeOf(handle(h, 'memory.update', { commandId: 'u2', id: `r_${e.seq}`, text: 'x' }))).toBe(-32602)
    expect(await codeOf(handle(h, 'memory.update', { commandId: 'u3', id: 'n_missing', text: 'x' }))).toBe(-32602)
  })

  it('memory.file.set: writes, gives the hash, replays by commandId; the receipt holds no text', async () => {
    const h = await boot()
    const expectedHash = await hashOf(h, 'USER.md')
    const params = { commandId: 'set-1', file: 'USER.md', content: '- 用 pnpm\n', expectedHash }
    const first = await handle<{ ok: boolean; hash: string; masked: number }>(h, 'memory.file.set', params)
    expect(first).toMatchObject({ ok: true, masked: 0 })
    expect(h.read('USER.md')).toBe('- 用 pnpm\n')
    const got = await handle<{ content: string; hash: string; cap: number }>(h, 'memory.file.get', { file: 'USER.md' })
    expect(got).toMatchObject({ content: '- 用 pnpm\n', hash: first.hash, cap: 2000 })
    const updates = ofType(h, 'memory.updated').length
    h.write('USER.md', '- 编辑器里改了\n')
    expect(await handle(h, 'memory.file.set', params)).toEqual(first) // 回执,不再写
    expect(h.read('USER.md')).toBe('- 编辑器里改了\n')
    expect(ofType(h, 'memory.updated')).toHaveLength(updates)
  })

  it('memory.file.set conflict → ERR_BUSY and no receipt: the same commandId can retry', async () => {
    const h = await boot()
    const params = { commandId: 'set-1', file: 'USER.md', content: '- 我的\n', expectedHash: 'stale' }
    expect(await codeOf(handle(h, 'memory.file.set', params))).toBe(ERR_BUSY)
    expect(existsSync(join(h.files, 'USER.md'))).toBe(false)
    expect(await handle(h, 'memory.file.set', { ...params, expectedHash: await hashOf(h, 'USER.md') })).toMatchObject({ ok: true })
  })

  it('memory.file.set over the cap → -32602 and nothing written; bad paths are refused by the schema', async () => {
    const h = await boot()
    expect(await codeOf(setFile(h, 'USER.md', 'x'.repeat(2001)))).toBe(-32602)
    expect(existsSync(join(h.files, 'USER.md'))).toBe(false)
    for (const file of ['../USER.md', 'diary/2026-01-01.md', 'topics/A.md', '/etc/passwd']) {
      expect(await codeOf(handle(h, 'memory.file.set', { commandId: `x${file}`, file, content: 'x', expectedHash: 'h' })), file).toBe(-32602)
      expect(await codeOf(handle(h, 'memory.file.get', { file })), file).toBe(-32602)
    }
  })

  it('a secret is masked and counted: memory.file.set, and no trace anywhere', async () => {
    const h = await boot()
    const secret = 'sk-' + 'x'.repeat(24)
    const set = await setFile(h, 'topics/deploy.md', `- 令牌是 ${secret}\n`)
    expect(set).toMatchObject({ ok: true, masked: 1 })
    expect(h.bytes()).not.toContain(secret)
  })

  it('draining → ERR_DRAINING for every write method, reads still answer', async () => {
    const h = await boot()
    await h.seedNote()
    await h.r.k.drain(10)
    const hash = await hashOf(h, 'USER.md')
    expect(await codeOf(handle(h, 'memory.update', { commandId: 'd1', id: 'n_seed', text: 'x' }))).toBe(ERR_DRAINING)
    expect(await codeOf(handle(h, 'memory.delete', { commandId: 'd2', id: 'n_seed' }))).toBe(ERR_DRAINING)
    expect(await codeOf(handle(h, 'memory.file.set', { commandId: 'd3', file: 'USER.md', content: 'x', expectedHash: hash }))).toBe(ERR_DRAINING)
    expect((await list(h)).items.length).toBeGreaterThan(0)
    expect((await health(h)).problems).toEqual([])
  })

  it('no memory.updated carries text, whichever write made it', async () => {
    const h = await boot()
    const { evidenceSeq } = await h.seedNote()
    await handle(h, 'memory.update', { commandId: 'u1', id: 'n_seed', text: 'UPDATED-TEXT-MARKER 新的说法' })
    await setFile(h, 'USER.md', '- FILE-TEXT-MARKER 用 pnpm\n')
    await setFile(h, 'USER.md', '- FILE-TEXT-MARKER 用 yarn\n')
    await del(h, 'n_seed')
    await del(h, `r_${evidenceSeq}`)
    const updates = ofType(h, 'memory.updated')
    expect(updates.length).toBeGreaterThanOrEqual(5)
    for (const e of updates) {
      expect(Object.keys(e.payload as object).every(k => ['id', 'file', 'op', 'source'].includes(k)), json(e.payload)).toBe(true)
      expect(json(e.payload)).not.toContain('MARKER')
    }
    for (const type of ['memory.deleted', 'events.redacted']) expect(json(ofType(h, type).map(e => e.payload))).not.toContain('MARKER')
  })
})

describe('memory.health', () => {
  it('matches the schema, counts rows, and the optional background fields are absent', async () => {
    const h = await boot()
    await h.seedNote()
    h.memory().flushNow()
    const result = await health(h)
    expect(MemoryHealthSchema.safeParse(result).success).toBe(true)
    expect(result).toMatchObject({ noteRows: 1, cursorLag: 0, pendingProposals: 0, problems: [] })
    expect(result.rawRows).toBe(1)
    expect(result.dbBytes).toBeGreaterThan(0)
    expect(result).not.toHaveProperty('budget')
    expect(result).not.toHaveProperty('backgroundModel')
  })

  it('cursorLag counts the real gap past one page of events, then closes', async () => {
    const h = await boot({ catchUpMs: 0, flushMs: 60_000 })
    const sid = await h.session()
    h.memory().flushNow()
    for (let i = 0; i < 700; i++) h.ctx().append({ type: 'turn.usage', sessionId: sid, payload: { turnId: 't', step: 1, input: 1, output: 1 } })
    expect((await health(h)).cursorLag).toBe(700)
    h.memory().flushNow()
    expect((await health(h)).cursorLag).toBe(0)
  })

  it('a recovered database is the stable code db_recovered', async () => {
    const h = await boot()
    h.beforeReopen(() => writeFileSync(join(h.dir, 'memory.sqlite'), 'garbage bytes '.repeat(500)))
    await h.r.restart()
    expect((await health(h)).problems).toEqual(['db_recovered'])
  })

  it('file_over_cap:<file> carries detail, so callers match it by prefix', async () => {
    const h = await boot()
    h.write('USER.md', `${Array.from({ length: 100 }, (_, i) => `- 第 ${i} 行,写得足够长才能超过上限,这一行还要再长一点才行`).join('\n')}\n`)
    const { problems } = await health(h)
    expect(problems).toHaveLength(1)
    expect(problems[0].startsWith('file_over_cap:USER.md')).toBe(true)
    expect(problems[0]).not.toBe('file_over_cap:USER.md')
  })

  it('a database fault after activation is reported in health instead of failing the call', async () => {
    const h = await boot()
    h.memory().inspect().store.db.close()
    const result = await health(h)
    expect(MemoryHealthSchema.safeParse(result).success).toBe(true)
    expect(result.problems.some(p => p.startsWith('db_fault:'))).toBe(true)
    expect(json(result.problems)).not.toContain(h.r.root)
  })

  it('an unfinished delete shows as delete_pending:<id> until a retry finishes it', async () => {
    let fail = true
    const h = await boot({
      onPurgeStep: step => {
        if (step === 'redact' && fail) throw new Error('boom')
      },
    })
    await h.seedNote()
    expect(await codeOf(del(h, 'n_seed'))).toBe(-32603)
    expect((await health(h)).problems).toEqual(['delete_pending:n_seed'])
    fail = false
    await del(h, 'n_seed')
    expect((await health(h)).problems).toEqual([])
  })

  it('after plugin.failed memory.health is absent: -32601, the kernel still answers, status names the failure', async () => {
    const h = await boot()
    h.beforeReopen(() => {
      rmSync(h.dir, { recursive: true, force: true })
      writeFileSync(h.dir, 'in the way')
    })
    await h.r.restart()
    expect(h.r.k.status().plugins.find(p => p.id === 'memory-default')?.state).toBe('failed')
    expect(await codeOf(health(h))).toBe(-32601)
    expect(ofType(h, 'plugin.failed').length).toBeGreaterThan(0)
    expect((await handle<{ sessionId: string }>(h, 'session.create', { commandId: 'after' })).sessionId).toBeTruthy()
  })

  it('the store cannot open: health answers with the code, the other methods are a clean error', async () => {
    const h = await boot()
    h.beforeReopen(() => {
      rmSync(join(h.dir, 'memory.sqlite'), { force: true })
      mkdirSync(join(h.dir, 'memory.sqlite'))
    })
    await h.r.restart()
    expect((await health(h)).problems).toEqual(['store_unavailable:EISDIR'])
    expect(await codeOf(list(h))).toBe(-32603)
    expect(await codeOf(del(h, 'n_x'))).toBe(-32603)
  })
})

describe('memory.delete: Review Focus 7', () => {
  it('the text leaves both databases, their WALs and every file; only the evidence message stays, and sources names it', async () => {
    const h = await boot()
    const { evidenceSeq, a } = await seedFull(h)
    const group = await h.session({ origin: 'im' })
    h.ctx().append({ type: 'memory.checkpoint', sessionId: group, payload: { throughSeq: 1, asOfSeq: 1, text: `别的会话的摘要逐字有 ${NOTE}`, model: 'm', tokens: 1, covers: 1 } })
    const other = await h.session()
    const untouched = h.ctx().append({ type: 'memory.checkpoint', sessionId: other, payload: { throughSeq: 1, asOfSeq: 1, text: '无关的摘要', model: 'm', tokens: 1, covers: 1 } })
    h.memory().flushNow()
    expect(h.bytes()).toContain(NOTE)
    const before = h.events()

    const result = await del(h, 'n_seed')
    expect(result.ok).toBe(true)
    expect(result.redacted).toBeGreaterThan(0)
    expect(result.sources).toEqual([`r_${evidenceSeq}`])

    h.memory().flushNow()
    const hay = h.bytes()
    for (const text of [NOTE, ...CHUNKS, '端口固定']) {
      const at = hay.indexOf(text)
      expect(at < 0 ? '' : hay.slice(hay.lastIndexOf('/data/', at), at + 40).slice(0, 300), text).toBe('')
    }
    expect(hay).toContain(EVIDENCE)

    // 同样的 seq、ts、type、结构;只多了不带文本的审计事件
    const after = h.events()
    expect(after.slice(0, before.length).map(e => [e.seq, e.ts, e.type, e.sessionId])).toEqual(before.map(e => [e.seq, e.ts, e.type, e.sessionId]))
    for (let i = 0; i < before.length; i++) {
      const keys = (v: unknown) => Object.keys(v as object).filter(k => k !== 'redacted').sort()
      expect(keys(after[i].payload), before[i].type).toEqual(keys(before[i].payload))
    }
    expect([...new Set(after.slice(before.length).map(e => e.type))].sort()).toEqual(['events.redacted', 'memory.deleted', 'memory.updated'])
    expect(ofType(h, 'memory.deleted').map(e => e.payload)).toEqual([{ id: 'n_seed', rawSeqs: expect.arrayContaining([evidenceSeq]) }])
    expect(json(ofType(h, 'memory.deleted'))).not.toContain(NOTE)
    expect(json(ofType(h, 'events.redacted'))).not.toContain(NOTE)
    expect(h.memory().inspect().store.getMeta('lastDeleteSeq')).toBe(String(ofType(h, 'memory.deleted')[0].seq))

    // 检查点:看过的会话和逐字含它的作废;无关的不动
    const checkpoints = new Map(ofType(h, 'memory.checkpoint').map(e => [e.sessionId, e]))
    expect(checkpoints.get(a)!.payload).toMatchObject({ text: REDACTED, redacted: true })
    expect(checkpoints.get(group)!.payload).toMatchObject({ text: REDACTED, redacted: true })
    expect(h.events().find(e => e.seq === untouched.seq)!.payload).not.toHaveProperty('redacted')

    // tool.started、那个 tool_call 的 args、思考的回放、这一步的 delta 都没了
    const started = h.events().find(e => e.type === 'tool.started' && (e.payload as { callId: string }).callId === 'c-write')!
    expect(started.payload).toMatchObject({ argsPreview: REDACTED })
    const assistantEvent = h.events().find(e => e.type === 'message.assistant' && json(e.payload).includes('c-write'))!
    const parts = (assistantEvent.payload as { parts: { type: string; id?: string; args?: string; replay?: unknown }[] }).parts
    expect(parts.find(p => p.id === 'c-write')!.args).toBe('{"redacted":true}')
    expect(parts.some(p => p.replay !== undefined)).toBe(false)
    const deltas = h.events().filter(e => (e.type === 'message.assistant.delta' || e.type === 'message.reasoning.delta') && (e.payload as { step: number }).step === 2)
    expect(deltas).toHaveLength(4)
    for (const d of deltas) expect(textOf(d)).toBe(REDACTED)
  })

  it("search, recall and a new session don't have it; A's next request doesn't, stays paired, and the one after continues byte for byte", async () => {
    const h = await boot()
    const { a } = await seedFull(h)
    await del(h, 'n_seed')

    expect((await search(h, '5173')).items).toEqual([])
    expect((await search(h, NOTE)).items).toEqual([])
    expect((await h.call('memory_search', { query: '5173' }, a)).content).not.toContain('5173 ')
    expect((await h.call('memory_get', { id: 'n_seed' }, a)).content).toBe('未找到')
    expect(await codeOf(handle(h, 'memory.get', { id: 'n_seed' }))).toBe(-32602)

    const fresh = await h.session()
    await h.prompt(fresh, '部署端口固定用哪个不要改动')
    expect(json(h.models.foreground().at(-1)!.req.messages)).not.toContain(NOTE)

    await h.prompt(a, '继续说别的事情吧')
    const next = h.models.foreground().at(-1)!.req.messages
    expect(json(next)).not.toContain(NOTE)
    for (const chunk of CHUNKS) expect(json(next)).not.toContain(chunk)
    expectPaired(next)
    await h.prompt(a, '再往下说')
    const after = h.models.foreground().at(-1)!.req.messages
    expect(json(after.slice(0, next.length + 1))).toBe(json([...next, assistant('ok')]))
    expectPaired(after)
    expect(h.r.k.events.bySession(a).filter(e => e.type === 'turn.failed')).toEqual([])
  })

  it('garbage over memory.sqlite, restart: no deleted raw row, the cursor starts at the end, no old .bad-* remains', async () => {
    const h = await boot()
    const { evidenceSeq } = await seedFull(h)
    const old = join(h.dir, 'memory.sqlite.bad-1')
    writeFileSync(old, NOTE)
    await del(h, 'n_seed')
    expect(existsSync(old)).toBe(false)

    h.beforeReopen(() => writeFileSync(join(h.dir, 'memory.sqlite'), 'garbage bytes '.repeat(500)))
    await h.r.restart()
    h.memory().flushNow()
    const { store } = h.memory().inspect()
    expect(store.getRaw(evidenceSeq)).toBeUndefined()
    expect((await search(h, EVIDENCE)).items).toEqual([])
    expect(Number(store.getMeta(CONSOLIDATION_CURSOR))).toBeGreaterThanOrEqual(ofType(h, 'memory.deleted')[0].seq)
    const bad = readdirSync(h.dir).filter(f => f.startsWith('memory.sqlite.bad-'))
    expect(bad).toHaveLength(1)
    expect(readFileSync(join(h.dir, bad[0]), 'utf8')).toContain('garbage bytes')
  })

  it('a note under 12 code points removes only its evidence rows, not every row containing it', async () => {
    const h = await boot()
    const sid = await h.session()
    const short = 'pnpm'
    const { evidenceSeq } = await h.seedNote(short, 'n_short')
    const bystander = h.ctx().append({ type: 'message.user', sessionId: sid, payload: { turnId: 't', text: '我们项目用 pnpm 跑测试' } })
    h.memory().flushNow()
    await del(h, 'n_short')
    h.memory().flushNow()
    const { store } = h.memory().inspect()
    expect(store.getRaw(evidenceSeq)).toBeUndefined()
    expect(store.getRaw(bystander.seq)).toBeDefined()
    expect(textOf(h.events().find(e => e.seq === bystander.seq)!)).toContain('pnpm')
  })

  it('12 code points or more removes every same-scope row holding the literal text, and only in that scope', async () => {
    const h = await boot()
    const owner = await h.session()
    const group = await h.session({ origin: 'im' })
    await h.seedNote()
    const same = h.ctx().append({ type: 'message.user', sessionId: owner, payload: { turnId: 't', text: `我说过 ${NOTE} 这句话` } })
    const inGroup = h.ctx().append({ type: 'message.user', sessionId: group, payload: { turnId: 'g', text: `群里也有人说 ${NOTE}` } })
    h.memory().flushNow()
    const { sources } = await del(h, 'n_seed')
    h.memory().flushNow()
    const { store } = h.memory().inspect()
    expect(store.getRaw(same.seq)).toBeUndefined()
    expect(store.getRaw(inGroup.seq)).toBeDefined()
    expect(sources).toContain(`r_${same.seq}`)
    expect(sources).not.toContain(`r_${inGroup.seq}`)
  })

  it('a group note: deleted from SQLite, its memory_write blanked, an owner session untouched', async () => {
    const h = await boot()
    const group = await h.session({ origin: 'im' })
    const text = '这是群里说好的安排请大家都记住'
    h.queue.push(() => calling('g-write', 'memory_write', { text }), () => say('好'))
    await h.prompt(group, '记一下')
    const id = (await search(h, text)).items[0].id
    h.memory().flushNow()
    expect(await del(h, id)).toMatchObject({ ok: true, sources: [] })
    expect(h.bytes()).not.toContain(text)
    expect((await search(h, text)).items).toEqual([])
    expect(await codeOf(handle(h, 'memory.get', { id }))).toBe(-32602)
  })

  it('r_<seq> of a user message: blanked in the transcript, a rebuild stays valid, and it is gone from raw', async () => {
    const h = await boot()
    const sid = await h.session()
    await h.prompt(sid, 'BLANK-THIS 第一句话要被删掉')
    h.memory().flushNow()
    const user = h.r.k.events.bySession(sid).find(e => e.type === 'message.user')!
    const result = await del(h, `r_${user.seq}`)
    expect(result).toMatchObject({ ok: true, sources: [] })
    expect(result.redacted).toBeGreaterThan(0)
    expect(textOf(h.events().find(e => e.seq === user.seq)!)).toBe(REDACTED)
    h.memory().flushNow()
    expect(h.bytes()).not.toContain('BLANK-THIS')
    expect(await codeOf(handle(h, 'memory.get', { id: `r_${user.seq}` }))).toBe(-32602)
    await h.prompt(sid, '继续')
    const sent = h.models.foreground().at(-1)!.req.messages
    expect(json(sent)).not.toContain('BLANK-THIS')
    expect(json(sent)).toContain(REDACTED)
  })

  it('r_<seq> named in sources still blanks the message, though its raw row left with the note', async () => {
    const h = await boot()
    const { evidenceSeq } = await h.seedNote()
    h.memory().flushNow()
    const { sources } = await del(h, 'n_seed')
    expect(sources).toEqual([`r_${evidenceSeq}`])
    expect(h.bytes()).toContain(EVIDENCE)
    await del(h, sources[0])
    expect(textOf(h.events().find(e => e.seq === evidenceSeq)!)).toBe(REDACTED)
    expect(h.bytes()).not.toContain(EVIDENCE)
  })

  it('r_<seq> of an assistant step: text, deltas, reasoning and args go; the pair stays and a rebuild is valid', async () => {
    const h = await boot()
    const sid = await h.session()
    h.queue.push(
      async function* () {
        yield { type: 'reasoning', delta: 'THINK-A' }
        yield { type: 'reasoning', delta: 'THINK-B', replay: { thinking: 'THINK-A THINK-B', signature: 's' } }
        yield { type: 'text', delta: 'SAID-A ' }
        yield { type: 'text', delta: 'SAID-B' }
        yield { type: 'tool_call', id: 'c1', name: 'memory_search', argsDelta: JSON.stringify({ query: 'QUERY-ARG' }) }
        yield done('tool_calls')
      },
      () => say('最后的回答'),
    )
    const turn = await h.prompt(sid, '问一下')
    h.memory().flushNow()
    const step = h.r.k.events.bySession(sid).find(e => e.type === 'message.assistant' && (e.payload as { step: number }).step === 1)!
    await del(h, `r_${step.seq}`)
    const events = h.r.k.events.bySession(sid)
    const stepped = events.filter(e => (e.type === 'message.assistant.delta' || e.type === 'message.reasoning.delta') && (e.payload as { step: number }).step === 1)
    expect(stepped).toHaveLength(4)
    for (const d of stepped) expect(textOf(d)).toBe(REDACTED)
    h.memory().flushNow()
    for (const text of ['SAID-A', 'SAID-B', 'THINK-A', 'THINK-B']) expect(h.bytes().includes(text), text).toBe(false)
    // 模型的最后一句不是这一步的,还在
    expect(json(events)).toContain('最后的回答')
    const rebuilt = buildMessages(events, 'not-a-turn', 'next', { environment: 'env', reminder: () => 'r' } as never)
    expectPaired(rebuilt)
    expect(rebuilt.find(m => m.parts.some(p => p.type === 'tool_call'))!.parts.find(p => p.type === 'tool_call')).toMatchObject({ args: '{"redacted":true}' })
    await h.prompt(sid, '继续')
    expectPaired(h.models.foreground().at(-1)!.req.messages)
    expect(turn).toBeTruthy()
  })

  it('r_<seq> of an executor notice and of a tool row blank that one event; a seq that is no message is -32602 free and does nothing', async () => {
    const h = await boot()
    const sid = await h.session()
    const notice = h.ctx().append({ type: 'executor.notice', sessionId: sid, payload: { turnId: 't', step: 1, runId: 'run-1', text: 'NOTICE-TEXT 跑完了' } })
    const tool = h.ctx().append({ type: 'tool.ended', sessionId: sid, payload: { turnId: 't', callId: 'x', name: 'shell', ok: true, ms: 1, content: 'SHELL-OUTPUT 的内容' } })
    const created = h.events().find(e => e.type === 'session.created')!
    h.memory().flushNow()
    await del(h, `r_${notice.seq}`)
    await del(h, `r_${tool.seq}`)
    expect(textOf(h.events().find(e => e.seq === notice.seq)!)).toBe(REDACTED)
    expect((h.events().find(e => e.seq === tool.seq)!.payload as { content: string }).content).toBe(REDACTED)
    h.memory().flushNow()
    expect(h.bytes()).not.toContain('NOTICE-TEXT')
    expect(h.bytes()).not.toContain('SHELL-OUTPUT')
    const quiet = h.events().length
    expect(await del(h, `r_${created.seq}`)).toEqual({ ok: true, redacted: 0, sources: [] })
    expect(await del(h, 'r_99999999')).toEqual({ ok: true, redacted: 0, sources: [] })
    expect(await del(h, 'n_never_existed')).toEqual({ ok: true, redacted: 0, sources: [] })
    expect(h.events()).toHaveLength(quiet)
  })

  it('r_ ids match whole: deleting r_1 does not hit a result that names r_12', async () => {
    const h = await boot()
    const sid = await h.session()
    const first = h.ctx().append({ type: 'message.user', sessionId: sid, payload: { turnId: 't', text: 'first message words' } })
    const longer = `r_${first.seq}0`
    const result = h.ctx().append({ type: 'tool.ended', sessionId: sid, payload: { turnId: 't2', callId: 'c', name: 'memory_get', ok: true, ms: 1, content: `<item id="${longer}">别的内容</item>` } })
    h.memory().flushNow()
    await del(h, `r_${first.seq}`)
    expect((h.events().find(e => e.seq === result.seq)!.payload as { content: string }).content).toContain('别的内容')
  })

  it('a replay with the same commandId does nothing new; a new commandId on the same id only repeats the answer', async () => {
    const h = await boot()
    await seedFull(h)
    const first = await del(h, 'n_seed', 'one')
    const after = h.events().length
    expect(await del(h, 'n_seed', 'one')).toEqual(first)
    expect(h.events()).toHaveLength(after)
    expect(await del(h, 'n_seed', 'two')).toEqual({ ok: true, redacted: 0, sources: [] })
    expect(h.events()).toHaveLength(after)
  })

  it('an edit by needle stays one edit: a second delete of the same id does not blank the block', async () => {
    const h = await boot()
    await h.seedNote()
    h.write('USER.md', '- 用户档案里的另一条,不能被连累\n')
    const a = await h.session()
    await h.prompt(a, '随便说一句话')
    await del(h, 'n_seed', 'one')
    const block = () => textOf(h.r.k.events.bySession(a).find(e => e.type === 'memory.injected')!)
    expect(block()).toContain('用户档案里的另一条')
    expect(block()).toContain(REDACTED)
    await del(h, 'n_seed', 'two')
    expect(block()).toContain('用户档案里的另一条')
  })

  it('a re-added hand-written line can be deleted again', async () => {
    const h = await boot()
    const text = '手写的一行足够长可以逐字匹配'
    h.write('USER.md', `- ${text}\n`)
    const id = (await list(h, { layer: 'user' })).items[0].id
    await del(h, id, 'one')
    h.write('USER.md', `- ${text}\n`)
    expect((await list(h, { layer: 'user' })).items[0].id).toBe(id)
    await del(h, id, 'two')
    expect(h.read('USER.md')).not.toContain(text)
    expect((await list(h, { layer: 'user' })).items).toEqual([])
  })

  it('a block keeps its frame: a note that reads like the preface or a tag replaces the whole block', async () => {
    const h = await boot()
    await h.seedNote('notes', 'n_tag')
    const a = await h.session()
    await h.prompt(a, '随便说一句话')
    await del(h, 'n_tag')
    expect(textOf(h.r.k.events.bySession(a).find(e => e.type === 'memory.injected')!)).toBe(REDACTED)
  })

  it('a long recalled row appears only as an excerpt: the whole block goes, the core comes back once, the prefix holds after', async () => {
    const h = await boot()
    h.write('USER.md', '- 用户档案里留下的一条\n')
    const donor = await h.session()
    const row = `${'无关的长文字'.repeat(120)}发布流程要先跑冒烟测试${'无关的长文字'.repeat(120)}`
    const e = h.ctx().append({ type: 'message.user', sessionId: donor, payload: { turnId: 'donor', text: row } })
    h.ctx().append({ type: 'turn.ended', sessionId: donor, payload: { turnId: 'donor' } })
    const a = await h.session()
    await h.prompt(a, '第一句开场白')
    await setFile(h, 'USER.md', '- 用户档案里留下的一条\n- 新加的这条\n')
    await h.prompt(a, '发布流程要先跑冒烟测试吗')
    const injected = () => h.r.k.events.bySession(a).filter(x => x.type === 'memory.injected' && (x.payload as { kind: string }).kind === 'turn')
    const block = injected()[0]
    expect((block.payload as { items: string[] }).items).toContain(`r_${e.seq}`)
    expect(textOf(block)).toContain('<memory-update>')
    expect(textOf(block)).toContain('冒烟测试')

    await del(h, `r_${e.seq}`)
    expect(textOf(h.events().find(x => x.seq === block.seq)!)).toBe(REDACTED)

    await h.prompt(a, '下一句和那个无关')
    const third = h.models.foreground().at(-1)!.req.messages
    expect(json(third)).not.toContain('无关的长文字')
    expect(json(third.at(-1))).toContain('新加的这条') // 那一块带着的更新没了,再发一次
    await h.prompt(a, '再下一句')
    const fourth = h.models.foreground().at(-1)!.req.messages
    expect(json(fourth.slice(0, third.length + 1))).toBe(json([...third, assistant('ok')]))
    expect(json(fourth.at(-1))).not.toContain('新加的这条')
  })

  it('memory_get output spilled to disk is cleared with the note, and a spill the note is not in stays', async () => {
    const h = await boot()
    const hostile = '<a'.repeat(1900)
    h.write('MEMORY.md', `- ${hostile} <!-- mff id=n_big src=confirmed ts=1793000000000 -->\n`)
    h.write('USER.md', `- ${'<b'.repeat(950)} <!-- mff id=n_other src=confirmed ts=1793000000000 -->\n`)
    h.write('topics/big.md', `- SPILL-MARKER ${'<c'.repeat(3900)} <!-- mff id=n_topic src=confirmed ts=1793000000000 -->\n`)
    const a = await h.session()
    const spill = join(h.r.dataDir, 'sessions', a, 'spill')
    const big = `${'<d'.repeat(6000)} SPILL-MARKER`
    const row = h.ctx().append({ type: 'message.user', sessionId: a, payload: { turnId: 'u', text: big } })
    const other = h.ctx().append({ type: 'message.user', sessionId: a, payload: { turnId: 'u2', text: `${'<e'.repeat(6000)} KEEP-MARKER` } })
    h.memory().flushNow()
    h.queue.push(() => calling('c-get', 'memory_get', { id: `r_${row.seq}` }), () => calling('c-keep', 'memory_get', { id: `r_${other.seq}` }), () => say('ok'))
    await h.prompt(a, '读一下')
    const spilled = readdirSync(spill)
    expect(spilled.filter(f => f.startsWith('c-get-memory_get'))).toHaveLength(1)
    expect(spilled.filter(f => f.startsWith('c-keep-memory_get'))).toHaveLength(1)

    await del(h, `r_${row.seq}`)
    const left = readdirSync(spill)
    expect(left.filter(f => f.startsWith('c-get-memory_get'))).toEqual([])
    expect(left.filter(f => f.startsWith('c-keep-memory_get'))).toHaveLength(1)
    const ended = h.r.k.events.bySession(a).find(e => e.type === 'tool.ended' && (e.payload as { callId: string }).callId === 'c-get')!
    expect((ended.payload as { content: string }).content).toBe(REDACTED)
    const kept = h.r.k.events.bySession(a).find(e => e.type === 'tool.ended' && (e.payload as { callId: string }).callId === 'c-keep')!
    expect((kept.payload as { content: string }).content).toContain('完整输出')
  })

  it('a spill the event no longer names by id is still found by its callId and contents', async () => {
    const h = await boot()
    const a = await h.session()
    const spill = join(h.r.dataDir, 'sessions', a, 'spill')
    mkdirSync(spill, { recursive: true })
    const file = join(spill, 'c-s-memory_search.txt')
    writeFileSync(file, '<memory-results> <item id="n_mid">中段</item> </memory-results>')
    // 头尾都没有这个 id,只有落盘文件里才有
    h.ctx().append({ type: 'tool.started', sessionId: a, payload: { turnId: 't', callId: 'c-s', name: 'memory_search', argsPreview: '{}' } })
    const ended = h.ctx().append({ type: 'tool.ended', sessionId: a, payload: { turnId: 't', callId: 'c-s', name: 'memory_search', ok: true, ms: 1, content: `头\n…[已截断,完整输出:${file}]…\n尾` } })
    h.write('MEMORY.md', '- 中段的文字足够长可以被找到 <!-- mff id=n_mid src=confirmed ts=1793000000000 -->\n')
    await del(h, 'n_mid')
    expect(existsSync(file)).toBe(false)
    expect((h.events().find(e => e.seq === ended.seq)!.payload as { content: string }).content).toBe(REDACTED)
  })

  it('a forged spill marker cannot make it delete a file outside the spill directory', async () => {
    const h = await boot()
    const a = await h.session()
    const outside = join(h.r.root, 'precious.txt')
    writeFileSync(outside, 'n_forged')
    h.ctx().append({ type: 'tool.ended', sessionId: a, payload: { turnId: 't', callId: '../../../precious', name: 'memory_get', ok: true, ms: 1, content: `id n_forged\n…[已截断,完整输出:${outside}]…\n` } })
    h.write('MEMORY.md', '- 这条会被删掉的笔记 <!-- mff id=n_forged src=confirmed ts=1793000000000 -->\n')
    await del(h, 'n_forged')
    expect(statSync(outside).isFile()).toBe(true)
  })

  it.each(['deleted', 'raw', 'tombstone', 'redact', 'purge'] as const)('a failure at step "%s" leaves no receipt, and retrying the same commandId finishes it, with the search text kept', async failAt => {
    let armed = true
    const h = await boot({
      onPurgeStep: step => {
        if (armed && step === failAt) {
          armed = false
          throw new Error('step failed')
        }
      },
    })
    const { evidenceSeq, a } = await seedFull(h)
    h.memory().flushNow()
    const before = h.events().length
    expect(await codeOf(del(h, 'n_seed', 'retry-me'))).toBe(-32603)
    const result = await del(h, 'n_seed', 'retry-me')
    expect(result).toMatchObject({ ok: true, sources: [`r_${evidenceSeq}`] })
    expect(result.redacted).toBeGreaterThan(0)
    h.memory().flushNow()
    const hay = h.bytes()
    for (const text of [NOTE, ...CHUNKS]) expect(hay.includes(text), text).toBe(false)
    expect(textOf(ofType(h, 'memory.checkpoint').find(e => e.sessionId === a)!)).toBe(REDACTED)
    expect(h.memory().inspect().store.getMeta('purge:n_seed')).toBeUndefined()
    expect(ofType(h, 'memory.deleted').length).toBeGreaterThanOrEqual(1)
    expect(h.events().length).toBeGreaterThan(before)
    expect((await health(h)).problems).toEqual([])
  })

  it('closing the kernel while a delete sweeps: it stops, leaves no receipt, and a restart can finish it', async () => {
    const h = await boot()
    const { witness } = await seedFull(h)
    for (let i = 0; i < 1500; i++) h.ctx().append({ type: 'turn.usage', sessionId: witness, payload: { turnId: 'filler', step: 1, input: 1, output: 1 } })
    h.memory().flushNow()
    const pending = del(h, 'n_seed', 'closing').catch((e: { code?: number }) => e.code ?? 'threw')
    await h.r.restart()
    await pending
    const result = await del(h, 'n_seed', 'closing')
    expect(result.ok).toBe(true)
    h.memory().flushNow()
    expect(h.bytes()).not.toContain(NOTE)
  })

  it('it refuses to finish while ingest cannot catch up: rows past the cursor would come back', async () => {
    const h = await boot()
    await h.seedNote()
    h.memory().flushNow()
    const { store } = h.memory().inspect()
    h.ctx().append({ type: 'message.user', sessionId: 'no-such-session', payload: { turnId: 't', text: 'later' } })
    store.db.exec('DROP TABLE meta')
    expect(await codeOf(del(h, 'n_seed'))).toBe(-32603)
  })

  it('a short note written by memory_write: the step that wrote it loses it too, thinking included; other steps keep the word', async () => {
    const h = await boot()
    const a = await h.session()
    const short = 'SHORTNOTE'
    h.queue.push(() => quotingStepShort('c-short', short), () => say('记住了'))
    await h.prompt(a, '记一下')
    const elsewhere = h.ctx().append({ type: 'message.user', sessionId: a, payload: { turnId: 'later', text: `后来又提到 ${short} 这个词` } })
    const id = (await search(h, short, { layer: 'notes' })).items[0].id
    h.memory().flushNow()
    await del(h, id)
    const step = h.r.k.events.bySession(a).filter(e => e.seq < elsewhere.seq && e.type !== 'message.user')
    expect(json(step.map(e => e.payload))).not.toContain(short)
    expect(textOf(h.events().find(e => e.seq === elsewhere.seq)!)).toContain(short)
  })

  it('a failed redact does not lose a spill: the retry blanks the event and the file is gone', async () => {
    let armed = true
    const h = await boot({
      onPurgeStep: step => {
        if (armed && step === 'redact') {
          armed = false
          throw new Error('step failed')
        }
      },
    })
    const a = await h.session()
    const spill = join(h.r.dataDir, 'sessions', a, 'spill')
    mkdirSync(spill, { recursive: true })
    const file = join(spill, 'c-r-memory_search.txt')
    writeFileSync(file, '<memory-results> <item id="n_mid">中段</item> </memory-results>')
    const ended = h.ctx().append({ type: 'tool.ended', sessionId: a, payload: { turnId: 't', callId: 'c-r', name: 'memory_search', ok: true, ms: 1, content: `头\n…[已截断,完整输出:${file}]…\n尾` } })
    h.write('MEMORY.md', '- 中段的文字足够长可以被找到 <!-- mff id=n_mid src=confirmed ts=1793000000000 -->\n')
    expect(await codeOf(del(h, 'n_mid', 'spill-retry'))).toBe(-32603)
    await del(h, 'n_mid', 'spill-retry')
    expect((h.events().find(e => e.seq === ended.seq)!.payload as { content: string }).content).toBe(REDACTED)
    expect(existsSync(file)).toBe(false)
  })

  it('known gap: an assistant paraphrase stays in message.assistant', async () => {
    const h = await boot()
    await h.seedNote()
    const a = await h.session()
    h.queue.push(() => say('您的部署用那个五千多的端口,别动它'))
    await h.prompt(a, '说说部署')
    await del(h, 'n_seed')
    expect(json(h.r.k.events.bySession(a).filter(e => e.type === 'message.assistant'))).toContain('五千多的端口')
  })

  it('known gap: executor.run.progress keeps the words of a blanked executor notice, it is not on the redact allowlist', async () => {
    const h = await boot()
    const sid = await h.session()
    h.ctx().append({ type: 'executor.run.progress', sessionId: sid, payload: { turnId: 't', runId: 'run-1', kind: 'text', text: 'FINAL-WORDS 结果在这里' } })
    const notice = h.ctx().append({ type: 'executor.notice', sessionId: sid, payload: { turnId: 't', step: 1, runId: 'run-1', text: 'FINAL-WORDS 结果在这里' } })
    h.memory().flushNow()
    await del(h, `r_${notice.seq}`)
    expect(textOf(h.events().find(e => e.seq === notice.seq)!)).toBe(REDACTED)
    h.memory().flushNow()
    expect(h.bytes()).toContain('FINAL-WORDS')
    const sent = buildMessages(h.r.k.events.bySession(sid), 'not-a-turn', 'next', { environment: 'env', reminder: () => 'r' } as never)
    expect(json(sent)).not.toContain('FINAL-WORDS')
  })
})

describe('memory.file.set dropping a line behaves like memory.delete for that line', () => {
  it('the line, its evidence row, its recalled payloads and memory_write go', async () => {
    const h = await boot()
    const { evidenceSeq, a } = await seedFull(h)
    h.memory().flushNow()
    const raw = h.read('MEMORY.md')
    expect(raw).toContain(NOTE)
    await setFile(h, 'MEMORY.md', '- 留下的另一条\n')
    h.memory().flushNow()
    expect(h.bytes()).not.toContain(NOTE)
    expect(h.memory().inspect().store.getRaw(evidenceSeq)).toBeUndefined()
    expect(ofType(h, 'memory.deleted').map(e => (e.payload as { id: string }).id)).toContain('n_seed')
    expect(textOf(ofType(h, 'memory.checkpoint').find(e => e.sessionId === a)!)).toBe(REDACTED)
    expect(h.read('MEMORY.md')).toBe('- 留下的另一条\n')
  })

  it('dropping a line moves the prefix of a session that saw it once, and only once; several dropped lines clean the log in one go', async () => {
    const h = await boot()
    h.write('MEMORY.md', `- ${NOTE}\n- 第二条会被一起去掉的足够长的笔记\n- 留下的这一条足够长不会被动到\n`)
    const a = await h.session()
    await h.prompt(a, '第一句开场白')
    const before = json(h.models.foreground().at(-1)!.req.messages)
    expect(before).toContain(NOTE)
    await setFile(h, 'MEMORY.md', '- 留下的这一条足够长不会被动到\n')
    expect(ofType(h, 'memory.deleted')).toHaveLength(2)
    h.memory().flushNow()
    expect(h.bytes()).not.toContain(NOTE)
    await h.prompt(a, '第二句')
    const second = h.models.foreground().at(-1)!.req.messages
    expect(json(second)).not.toContain(NOTE)
    expect(json(second[0])).toContain('留下的这一条')
    await h.prompt(a, '第三句')
    const third = h.models.foreground().at(-1)!.req.messages
    expect(json(third.slice(0, second.length + 1))).toBe(json([...second, assistant('ok')]))
  })

  it('a kept line whose comment was edited away is not a deletion: the text stays', async () => {
    const h = await boot()
    await h.seedNote()
    await setFile(h, 'MEMORY.md', `- ${NOTE}\n`)
    expect(h.read('MEMORY.md')).toContain(NOTE)
    expect(ofType(h, 'memory.deleted')).toEqual([])
    expect((await search(h, NOTE)).items.map(i => i.text).join()).toContain(NOTE)
  })

  it('a failed purge leaves no receipt; the same commandId retries past the hash check and finishes', async () => {
    let armed = true
    const h = await boot({
      onPurgeStep: step => {
        if (armed && step === 'redact') {
          armed = false
          throw new Error('step failed')
        }
      },
    })
    await seedFull(h)
    const params = { commandId: 'set-retry', file: 'MEMORY.md', content: '- 留下的另一条\n', expectedHash: await hashOf(h, 'MEMORY.md') }
    expect(await codeOf(handle(h, 'memory.file.set', params))).toBe(-32603)
    const done2 = await handle<{ ok: boolean; hash: string }>(h, 'memory.file.set', params)
    expect(done2).toMatchObject({ ok: true, hash: await hashOf(h, 'MEMORY.md') })
    h.memory().flushNow()
    expect(h.bytes()).not.toContain(NOTE)
  })

  it('a refused write leaves nothing pending and deletes nothing', async () => {
    const h = await boot()
    await h.seedNote()
    expect(await codeOf(handle(h, 'memory.file.set', { commandId: 's1', file: 'MEMORY.md', content: 'x'.repeat(7000), expectedHash: await hashOf(h, 'MEMORY.md') }))).toBe(-32602)
    expect(await codeOf(handle(h, 'memory.file.set', { commandId: 's2', file: 'MEMORY.md', content: '', expectedHash: 'stale' }))).toBe(ERR_BUSY)
    expect(h.read('MEMORY.md')).toContain(NOTE)
    expect((await health(h)).problems).toEqual([])
    expect(count(h, "SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'purge:%'")).toBe(0)
  })
})
