// 08 §4.3 删会话(Review Focus 4)和 memory.deleteMany。前半是 06 的记忆夹具(假模型、非 git 目录),
// 后半是真 git + 假 CLI(executorRig):保留的 worktree、快照引用、启动时的清扫
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventLog, REDACTED } from '../../kernel/eventLog'
import type { Kernel } from '../../kernel/kernel'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import type { BackgroundRuns } from '../../lib/tools/types'
import type { KernelEvent } from '../../protocol/events'
import { ERR_BUSY } from '../../protocol/rpc'
import { calling, fakeModels, memoryKernel, say, type MemoryRig } from '../../../test/memoryRig'
import { FINISH, boot as execBoot, create as execCreate, cwd as execCwd, dataDir as execData, delegate, detected, fake, kernels as execKernels, ofType, pay, prompt as execPrompt, sh, terminal, useRig, waitFor } from '../../../test/executorRig'
import { createLoopDefault } from '../loop-default'
import toolsRegistry from '../tools-registry'
import { deleteInFlight, type PurgeStep } from './rpc'
import { createMemoryDefault, type MemoryDefaultOpts, type MemoryDefaultPlugin } from './index'

const ALL = 1_000_000
const LONG_USER = '这一句是要被删掉的会话里用户说的原话足够长'
const NOTE = '部署走那个老地方不要改'

let rig: MemoryRig | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await rig?.close()
  rig = undefined
})

interface H {
  r: MemoryRig
  ctx(): PluginContext
  memory(): MemoryDefaultPlugin
  session(params?: object): Promise<string>
  prompt(sessionId: string, text: string): Promise<string>
  events(): KernelEvent[]
  handle<T = Record<string, unknown>>(method: string, params?: object): Promise<T>
  files: string
  /** 下一次 restart:旧内核关掉之后、新内核打开之前跑 */
  beforeReopen(fn: () => void): void
}

async function memBoot(opts: MemoryDefaultOpts = {}, script: (n: number) => ReturnType<typeof say> = () => say('ok')): Promise<H> {
  let ctx!: PluginContext
  let memory!: MemoryDefaultPlugin
  let reopen: (() => void) | undefined
  const probe: Plugin = { manifest: { id: 'probe', version: '0', kernel: '^0.1.0' }, activate: c => { ctx = c } }
  const models = fakeModels({ script: n => script(n) })
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
  let n = 0
  const h: H = {
    r,
    ctx: () => ctx,
    memory: () => memory,
    files: join(r.dataDir, 'plugins', 'memory-default', 'files'),
    handle: (method, params = {}) => r.k.handle(method as never, params as never) as never,
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
    events: () => r.k.events.after(0, ALL),
    beforeReopen: fn => {
      reopen = fn
    },
  }
  return h
}

const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: number }) => e.code)
const del = (h: H, sessionId: string, commandId = `del-${sessionId}`, extra: object = {}) => h.handle<{ ok: boolean; redacted: number; notes: string[] }>('session.delete', { commandId, sessionId, ...extra })
const health = (h: H) => h.handle<{ problems: string[] }>('memory.health')
const settledHealth = async (h: H) => {
  for (let i = 0; i < 400; i++) {
    if ((await health(h)).problems.length === 0) return
    await new Promise(res => setTimeout(res, 10))
  }
  throw new Error(`the delete never finished: ${(await health(h)).problems.join(',')}`)
}
/** sqlite 先 checkpoint 再读;WAL 也算 */
function dbBytes(...files: string[]): string {
  for (const f of files) {
    if (!existsSync(f)) continue
    const db = new DatabaseSync(f)
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }
  }
  return files.flatMap(f => [f, `${f}-wal`]).filter(f => existsSync(f)).map(f => readFileSync(f).toString('utf8')).join('\n')
}
const eventsDb = (dataDir: string) => join(dataDir, 'db', 'events.sqlite')
const memoryDb = (dataDir: string) => join(dataDir, 'plugins', 'memory-default', 'memory.sqlite')

/**
 * 被删的会话 A:一轮,用户的长原话。核心笔记 n_cite 的证据在 A 里。
 * 会话 B 召回过 A 的那一行(memory.injected 按 id 点名),C 是无关的
 */
async function seedSession(h: H) {
  const a = await h.session({ title: '被删的会话' })
  await h.prompt(a, LONG_USER)
  const userSeq = h.events().find(e => e.sessionId === a && e.type === 'message.user')!.seq
  mkdirSync(h.files, { recursive: true })
  writeFileSync(join(h.files, 'MEMORY.md'), `- ${NOTE} <!-- mff id=n_cite src=confirmed ts=1793000000000 ev=r_${userSeq} -->\n`)
  const b = await h.session()
  const recalled = h.ctx().append({ type: 'memory.injected', sessionId: b, payload: { turnId: 'tb', kind: 'recall', text: `<memory kind="recall">\n- ${LONG_USER}\n</memory>`, items: [`r_${userSeq}`] } })
  const c = await h.session()
  const unrelated = h.ctx().append({ type: 'memory.injected', sessionId: c, payload: { turnId: 'tc', kind: 'recall', text: '<memory kind="recall">\n- 无关的一行记忆内容在这里\n</memory>', items: ['r_999999'] } })
  h.memory().flushNow()
  return { a, b, c, userSeq, recalled, unrelated }
}

describe('session.delete through the memory pipeline (Review Focus 4, memory rig)', () => {
  it('the text leaves events.sqlite and memory.sqlite; every event keeps seq/type with erased:true; one events.redacted names the session; notes lists n_cite', async () => {
    const h = await memBoot()
    const { a, recalled, unrelated } = await seedSession(h)
    expect(dbBytes(memoryDb(h.r.dataDir))).toContain(LONG_USER)
    const before = h.events().filter(e => e.sessionId === a)

    const result = await del(h, a)
    expect(result.ok).toBe(true)
    expect(result.notes).toEqual(['n_cite'])
    expect(result.redacted).toBeGreaterThanOrEqual(before.length)

    const hay = dbBytes(eventsDb(h.r.dataDir), memoryDb(h.r.dataDir))
    for (const marker of [LONG_USER, '被删的会话']) expect(hay.includes(marker), marker).toBe(false)
    const after = h.events().filter(e => e.sessionId === a)
    // 只多了墓碑
    expect(after.map(e => [e.seq, e.type])).toEqual([...before.map(e => [e.seq, e.type]), [after.at(-1)!.seq, 'session.deleted']])
    for (const e of after) expect((e.payload as { erased?: boolean }).erased, e.type).toBe(true)
    expect(ofTypeAll(h, 'events.redacted').filter(e => (e.payload as { session?: string }).session === a)).toHaveLength(1)
    // 别的会话里按 id 召回过它的块:整段换掉;无关的不动
    expect((h.events().find(e => e.seq === recalled.seq)!.payload as { text: string }).text).toBe(REDACTED)
    expect((h.events().find(e => e.seq === unrelated.seq)!.payload as { text: string }).text).toContain('无关的一行')
    // 核心笔记本身不删:列给用户
    expect(readFileSync(join(h.files, 'MEMORY.md'), 'utf8')).toContain('n_cite')
    expect((await health(h)).problems).toEqual([])
  })

  it('afterwards: memory.search finds nothing, session.list leaves it out, session.prompt is unknown session, <data>/sessions/<id> is gone', async () => {
    const h = await memBoot()
    const { a } = await seedSession(h)
    mkdirSync(join(h.r.dataDir, 'sessions', a, 'spill'), { recursive: true })
    writeFileSync(join(h.r.dataDir, 'sessions', a, 'spill', 'x.txt'), LONG_USER)
    await del(h, a)
    expect((await h.handle<{ items: unknown[] }>('memory.search', { query: '会话里用户说的原话' })).items).toEqual([])
    expect((await h.handle<{ items: unknown[] }>('memory.list', { layer: 'raw' })).items.some(i => (i as { sessionId?: string }).sessionId === a)).toBe(false)
    expect((await h.handle<{ sessions: { sessionId: string }[] }>('session.list')).sessions.map(s => s.sessionId)).not.toContain(a)
    await expect(h.handle('session.prompt', { commandId: 'after', sessionId: a, text: 'hi' })).rejects.toMatchObject({ code: -32602, message: 'unknown session' })
    expect(existsSync(join(h.r.dataDir, 'sessions', a))).toBe(false)
  })

  it('an open turn: -32003 and nothing changes, no pending record', async () => {
    let release!: () => void
    const gate = new Promise<void>(res => (release = res))
    async function* slow() {
      await gate
      yield* say('late')
    }
    const h = await memBoot({}, n => (n === 1 ? slow() : say('ok')))
    const a = await h.session()
    await h.handle('session.prompt', { commandId: 'open', sessionId: a, text: 'hi' })
    expect(await codeOf(del(h, a))).toBe(ERR_BUSY)
    // 轮自己还在写事件:看的是删除会写的那几种
    expect(h.events().filter(e => ['session.deleted', 'memory.deleted', 'events.redacted'].includes(e.type))).toEqual([])
    expect(h.memory().inspect().store.metaWithPrefix('purge:')).toEqual([])
    expect((await health(h)).problems).toEqual([])
    release()
  })

  it('unknown session → -32602 and nothing written; a second delete with a new commandId is a no-op', async () => {
    const h = await memBoot()
    const before = h.events().length
    expect(await codeOf(del(h, 'no-such-session'))).toBe(-32602)
    expect(h.events().length).toBe(before)
    const { a } = await seedSession(h)
    await del(h, a)
    const n = h.events().length
    expect(await del(h, a, 'again')).toEqual({ ok: true, redacted: 0, notes: [] })
    expect(h.events().length).toBe(n)
  })

  it('a replay with the same commandId answers from the receipt', async () => {
    const h = await memBoot()
    const { a } = await seedSession(h)
    const first = await del(h, a, 'same')
    const n = h.events().length
    expect(await del(h, a, 'same')).toEqual(first)
    expect(h.events().length).toBe(n)
  })

  it('while it runs deleteInFlight is true at every step, and lastDeleteSeq is past the tombstone: a checkpoint whose call was in flight is stale', async () => {
    const seen: [PurgeStep, boolean][] = []
    let h!: H
    h = await memBoot({ onPurgeStep: step => void seen.push([step, deleteInFlight(h.memory().inspect().store)]) })
    const { a } = await seedSession(h)
    const asOf = h.events().at(-1)!.seq
    await del(h, a)
    // 抹完之后日志是干净的,只差落盘:那时提取可以接着走(和 memory.delete 同一个规则)
    expect(seen).toEqual([['raw', true], ['tombstone', true], ['redact', true], ['erase', true], ['purge', false]])
    expect(deleteInFlight(h.memory().inspect().store)).toBe(false)
    const tombstone = h.events().find(e => e.type === 'session.deleted' && e.sessionId === a)!
    expect(Number(h.memory().inspect().store.getMeta('lastDeleteSeq'))).toBeGreaterThanOrEqual(tombstone.seq)
    expect(Number(h.memory().inspect().store.getMeta('lastDeleteSeq'))).toBeGreaterThan(asOf)
  })

  const STEPS: PurgeStep[] = ['raw', 'tombstone', 'redact', 'erase', 'purge']

  it.each(STEPS)('a crash at "%s", then a retry with the same commandId, finishes with the same result as a clean run', async failAt => {
    const clean = await memBoot()
    const seededClean = await seedSession(clean)
    const want = await del(clean, seededClean.a, 'cmd')
    await rig!.close()
    rig = undefined

    let armed = true
    const h = await memBoot({
      onPurgeStep: step => {
        if (armed && step === failAt) throw new Error('step failed')
      },
    })
    const { a } = await seedSession(h)
    expect(await codeOf(del(h, a, 'cmd'))).toBe(-32603)
    expect((await health(h)).problems).toEqual([`delete_pending:session:${a}`])
    // 已经立了墓碑:列表里没有,发不进去
    expect((await h.handle<{ sessions: { sessionId: string }[] }>('session.list')).sessions.map(s => s.sessionId)).not.toContain(a)
    armed = false
    expect(await del(h, a, 'cmd')).toEqual(want)
    expect((await health(h)).problems).toEqual([])
    expect(dbBytes(eventsDb(h.r.dataDir), memoryDb(h.r.dataDir)).includes(LONG_USER)).toBe(false)
  })

  it('killed after the tombstone, before the erase: on restart it is absent from session.list and resumeAll finishes the erase', async () => {
    let image: string | undefined
    let h!: H
    h = await memBoot({
      onPurgeStep: step => {
        if (step !== 'raw' || image) return
        // 这一刻的盘:墓碑和进度都在,别的什么都还没做
        image = join(h.r.root, 'image')
        cpSync(h.r.dataDir, image, { recursive: true })
        throw new Error('killed')
      },
    })
    const { a } = await seedSession(h)
    expect(await codeOf(del(h, a))).toBe(-32603)
    h.beforeReopen(() => {
      rmSync(h.r.dataDir, { recursive: true, force: true })
      cpSync(image!, h.r.dataDir, { recursive: true })
    })
    await h.r.restart()
    expect((await h.handle<{ sessions: { sessionId: string }[] }>('session.list')).sessions.map(s => s.sessionId)).not.toContain(a)
    await settledHealth(h)
    expect(dbBytes(eventsDb(h.r.dataDir), memoryDb(h.r.dataDir)).includes(LONG_USER)).toBe(false)
    for (const e of h.events().filter(x => x.sessionId === a)) expect((e.payload as { erased?: boolean }).erased).toBe(true)
  })
})

const ofTypeAll = (h: H, type: string) => h.events().filter(e => e.type === type)

describe('session.delete removes what memory_write wrote in it (review C1)', () => {
  const DRAFT = 'MKdraft9z 草稿区里记下的一条内容足够长'
  const DURABLE = 'MKdurable9z 要长期记住的一条内容足够长'
  const SHORT = 'MKshort9z'
  /** 第一轮:草稿、durable 的提议、一条短草稿;第二轮在另一个会话里写一条不相干的 */
  const writes = (n: number) =>
    n === 1 ? calling('w1', 'memory_write', { text: DRAFT })
      : n === 2 ? calling('w2', 'memory_write', { text: DURABLE, durable: true })
        : n === 3 ? calling('w3', 'memory_write', { text: SHORT })
          : n === 5 ? calling('w4', 'memory_write', { text: 'MKkeep9z 另一个会话里的草稿内容足够长' })
            : say('ok')

  it('the diary lines, the pending proposal and their change records are gone from the files, memory.sqlite and the proposals list; another session keeps its draft', async () => {
    const h = await memBoot({}, writes)
    const a = await h.session()
    await h.prompt(a, '记一下这些')
    const b = await h.session()
    await h.prompt(b, '也记一下')
    h.memory().flushNow()
    const pending = async () => (await h.handle<{ items: { text: string }[] }>('memory.proposals.list', { status: 'pending' })).items.map(i => i.text)
    expect(await pending()).toContain(DURABLE)
    const diary = () => {
      const dir = join(h.files, 'diary')
      return existsSync(dir) ? readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8')).join('\n') : ''
    }
    expect(diary()).toContain(DRAFT)

    await del(h, a)
    expect(await pending()).not.toContain(DURABLE)
    expect(diary()).not.toContain(DRAFT)
    expect(diary()).not.toContain(SHORT)
    expect(diary()).toContain('MKkeep9z')
    const hay = dbBytes(eventsDb(h.r.dataDir), memoryDb(h.r.dataDir))
    for (const m of ['MKdraft9z', 'MKdurable9z', 'MKshort9z']) expect(hay.includes(m), m).toBe(false)
    expect(hay.includes('MKkeep9z')).toBe(true)
    expect((await h.handle<{ items: unknown[] }>('memory.search', { query: 'MKdraft9z' })).items).toEqual([])
    expect((await health(h)).problems).toEqual([])
  })
})

describe('the raw step does not block the worker (review I3)', () => {
  it('rows go in slices with a turn of the event loop between them, inside a watchdog hold; rawOfSession uses an index', async () => {
    const holds: number[] = []
    let ctx!: PluginContext
    let memory!: MemoryDefaultPlugin
    const probe: Plugin = { manifest: { id: 'probe', version: '0', kernel: '^0.1.0' }, activate: c => { ctx = c } }
    rig = await memoryKernel({
      models: fakeModels(),
      kernel: { holdWatchdog: async ms => void holds.push(ms) },
      plugins: () => [toolsRegistry, (memory = createMemoryDefault({ nightly: false, rawDeleteSlice: 4 })), createLoopDefault(), probe],
    })
    const sid = ((await rig.k.handle('session.create', { commandId: 'c', cwd: rig.cwd })) as { sessionId: string }).sessionId
    for (let i = 0; i < 10; i++) ctx.append({ type: 'message.user', sessionId: sid, payload: { turnId: `t${i}`, text: `第 ${i} 条足够长的原始记录内容在这里` } })
    memory.flushNow()
    const store = memory.inspect().store
    const plan = store.db.prepare('EXPLAIN QUERY PLAN SELECT seq, text, scope FROM raw WHERE session_id = ? ORDER BY seq').all('x') as { detail: string }[]
    expect(plan.map(r => r.detail).join(' ')).toContain('raw_session')
    const slices: number[] = []
    const real = store.deleteRaw.bind(store)
    vi.spyOn(store, 'deleteRaw').mockImplementation(seqs => {
      slices.push(seqs.length)
      real(seqs)
    })
    holds.length = 0
    await rig.k.handle('session.delete', { commandId: 'd', sessionId: sid })
    expect(slices).toEqual([4, 4, 2])
    // 每段要来的时间,最后都还回去(0)
    expect(holds.length).toBeGreaterThanOrEqual(2)
    expect(holds[0]).toBeGreaterThan(0)
    expect(holds.at(-1)).toBe(0)
    expect(store.rawOfSession(sid)).toEqual([])
  })
})

describe('memory.deleteMany', () => {
  it('3 ids, one unknown: one VACUUM, gone holds the unknown id, the others are gone', async () => {
    const h = await memBoot()
    const a = await h.session()
    await h.prompt(a, '第一条要删掉的原始记录内容足够长了')
    await h.prompt(a, '第二条要删掉的原始记录内容足够长了')
    h.memory().flushNow()
    const seqs = h.events().filter(e => e.sessionId === a && e.type === 'message.user').map(e => e.seq)
    const purge = vi.spyOn(EventLog.prototype, 'purge')
    const result = await h.handle<{ ok: boolean; redacted: number; sources: string[]; gone: string[] }>('memory.deleteMany', { commandId: 'many', ids: [`r_${seqs[0]}`, 'n_nothere', `r_${seqs[1]}`] })
    expect(result).toMatchObject({ ok: true, gone: ['n_nothere'] })
    expect(result.redacted).toBeGreaterThan(0)
    expect(purge).toHaveBeenCalledTimes(1)
    expect(dbBytes(eventsDb(h.r.dataDir), memoryDb(h.r.dataDir)).includes('要删掉的原始记录')).toBe(false)
    expect((await health(h)).problems).toEqual([])
  })

  it('every id unknown: ok, all in gone, no VACUUM, nothing written', async () => {
    const h = await memBoot()
    const n = h.events().length
    const purge = vi.spyOn(EventLog.prototype, 'purge')
    expect(await h.handle('memory.deleteMany', { commandId: 'none', ids: ['n_a', 'n_b'] })).toEqual({ ok: true, redacted: 0, sources: [], gone: ['n_a', 'n_b'] })
    expect(purge).not.toHaveBeenCalled()
    expect(h.events().length).toBe(n)
  })

  it('a failed purge leaves no receipt; the same commandId finishes it', async () => {
    let fail = true
    const h = await memBoot({ onPurgeStep: step => { if (fail && step === 'purge') throw new Error('disk') } })
    const a = await h.session()
    await h.prompt(a, '第三条要删掉的原始记录内容足够长了')
    h.memory().flushNow()
    const seq = h.events().find(e => e.sessionId === a && e.type === 'message.user')!.seq
    expect(await codeOf(h.handle('memory.deleteMany', { commandId: 'retry', ids: [`r_${seq}`] }))).toBe(-32603)
    fail = false
    expect(await h.handle('memory.deleteMany', { commandId: 'retry', ids: [`r_${seq}`] })).toMatchObject({ ok: true, gone: [] })
    expect((await health(h)).problems).toEqual([])
  })
})

describe('session.delete with real git, a delegate run and a retained worktree (Review Focus 4)', { timeout: 90_000 }, () => {
  useRig()
  const M = { title: 'MKtitle7q', rename: 'MKrename7q', user: 'MKuser7q please read and delegate', tool: 'MKtool7q', shell: 'MKshell7q', run: 'MKrun7q', progress: 'MKprogress7q', reply: 'MKreply7q', fail: 'MKfail7q' }
  const MARKERS = Object.values(M).map(v => v.split(' ')[0])

  let memory!: MemoryDefaultPlugin
  const memPlugin = (opts: MemoryDefaultOpts = {}) => (memory = createMemoryDefault({ nightly: false, ...opts }))
  const runLines = [`{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"${M.progress}","status":"in_progress"}}`, FINISH]
  const script = (n: number) =>
    n === 1 ? calling('c-read', 'read', { path: 'notes.txt' })
      : n === 2 ? calling('c-shell', 'shell', { command: `echo ${M.shell}` })
        : n === 3 ? delegate({ prompt: `${M.run} do it` })
          : n === 4 ? say('started')
            : n === 5 ? say(`${M.reply} done`)
              : (async function* () { yield { type: 'done' as const, reason: 'error' as const, error: { kind: 'bad_request' as const, message: M.fail, retryable: false } } })()
  const ASK_ECHO = [{ effect: 'ask' as const, rule: 'shell(echo*)' }]

  let services: PluginContext['services'] | undefined
  const executorsOf = () => services!.get<BackgroundRuns>('executors')!
  const probe: Plugin = { manifest: { id: 'probe', version: '0', kernel: '^0.1.0' }, activate: ctx => { services = ctx.services } }
  async function full(o: { memory?: MemoryDefaultOpts; script?: typeof script; writes?: Record<string, string> } = {}) {
    writeFileSync(join(execCwd, 'notes.txt'), `${M.tool}\n`)
    const f = fake({ lines: runLines, writeFiles: o.writes ?? { 'a.txt': 'changed by the run\n' } })
    const { k } = await execBoot(f, { script: o.script ?? script, rules: ASK_ECHO, extra: [memPlugin(o.memory), probe] })
    await detected(k)
    return k
  }

  /** 一轮:读文件(工具结果)、echo(审批卡片,拒绝)、委派(保留的 worktree、进度)、回复;第二轮模型报错(turn.failed.message) */
  async function seed(k: Kernel) {
    const sid = ((await k.handle('session.create', { commandId: 'c-s', cwd: execCwd, model: { accountId: 'acc', modelId: 'gpt-5' }, approvalMode: 'auto', origin: 'schedule', title: M.title })) as { sessionId: string }).sessionId
    await k.handle('session.rename', { commandId: 'rn', sessionId: sid, title: M.rename })
    await execPrompt(k, sid, M.user)
    await waitFor(() => ofType(k, sid, 'approval.requested').length === 1)
    await k.handle('approval.respond', { approvalId: pay<{ approvalId: string }>(ofType(k, sid, 'approval.requested')[0]).approvalId, decision: 'deny' })
    // 委派的写运行也要批
    await waitFor(() => ofType(k, sid, 'approval.requested').length === 2)
    await k.handle('approval.respond', { approvalId: pay<{ approvalId: string }>(ofType(k, sid, 'approval.requested')[1]).approvalId, decision: 'allow' })
    await waitFor(() => terminal(k, sid).length === 1, 30_000)
    await execPrompt(k, sid, 'second')
    await waitFor(() => terminal(k, sid).length === 2, 30_000)
    expect(pay(terminal(k, sid)[1])).toMatchObject({ message: M.fail })
    expect(ofType(k, sid, 'executor.run.progress').some(e => JSON.stringify(e.payload).includes(M.progress))).toBe(true)
    expect(pay<{ summary: string }>(ofType(k, sid, 'approval.requested')[0]).summary).toContain(`echo ${M.shell}`)
    const ended = pay<{ runId: string; worktree: string; rawLog: string }>(ofType(k, sid, 'executor.run.ended')[0])
    memory.flushNow()
    return { sid, ...ended }
  }
  const refsOf = (sid: string) => sh('for-each-ref', '--format=%(refname)', 'refs/mffai/').split('\n').filter(r => r.includes(`/${sid}/`))

  it('without discardUnmerged: -32602 unmerged with the run, and nothing changes; with it everything of the session is gone', async () => {
    const k = await full()
    const { sid, runId, worktree, rawLog } = await seed(k)
    expect(existsSync(worktree)).toBe(true)
    expect(existsSync(rawLog)).toBe(true)
    expect(refsOf(sid).length).toBeGreaterThan(0)
    const hayBefore = dbBytes(eventsDb(execData), memoryDb(execData))
    for (const m of [M.title, M.user.split(' ')[0], M.tool, M.shell, M.progress, M.fail]) expect(hayBefore.includes(m), m).toBe(true)

    const before = k.events.after(0, ALL).length
    const refused = await k.handle('session.delete', { commandId: 'd1', sessionId: sid }).catch(e => e)
    expect(refused).toMatchObject({ code: -32602, message: 'unmerged', data: { reason: 'unmerged', runs: [{ runId, files: 1 }] } })
    expect(k.events.after(0, ALL).length).toBe(before)
    expect(existsSync(worktree)).toBe(true)
    expect(memory.inspect().store.metaWithPrefix('purge:')).toEqual([])
    expect(((await k.handle('session.list', {})) as { sessions: { id: string }[] }).sessions.map(s => s.id)).toContain(sid)

    // 评审 I2:只丢列出来的。空的、少一个的都不行
    for (const [i, discardUnmerged] of [[], ['run_other']].entries()) {
      const again = await k.handle('session.delete', { commandId: `d-list-${i}`, sessionId: sid, discardUnmerged }).catch(e => e)
      expect(again).toMatchObject({ code: -32602, data: { reason: 'unmerged', runs: [{ runId, files: 1 }] } })
    }
    expect(k.events.after(0, ALL).length).toBe(before)
    const result = (await k.handle('session.delete', { commandId: 'd2', sessionId: sid, discardUnmerged: [runId, 'run_extra'] })) as { ok: boolean; notes: string[] }
    expect(result.ok).toBe(true)
    const hay = dbBytes(eventsDb(execData), memoryDb(execData))
    for (const m of MARKERS) expect(hay.includes(m), m).toBe(false)
    const events = k.events.bySession(sid)
    for (const e of events) expect((e.payload as { erased?: boolean }).erased, e.type).toBe(true)
    expect(pay(events.find(e => e.type === 'session.created'))).toMatchObject({ repo: { kind: 'repo' }, erased: true })
    expect(pay(events.find(e => e.type === 'session.created'))).not.toHaveProperty('title')
    expect(k.events.after(0, ALL).filter(e => e.type === 'events.redacted' && pay<{ session?: string }>(e).session === sid)).toHaveLength(1)
    expect(existsSync(join(execData, 'sessions', sid))).toBe(false)
    expect(existsSync(rawLog)).toBe(false)
    await waitFor(() => !existsSync(worktree) && refsOf(sid).length === 0)
    expect(sh('worktree', 'list')).not.toContain(worktree)
    expect(((await k.handle('executor.runs', {})) as { runs: { sessionId: string }[] }).runs.filter(r => r.sessionId === sid)).toEqual([])
    expect(((await k.handle('memory.search', { query: 'MKuser7q' })) as { items: unknown[] }).items).toEqual([])
    expect(((await k.handle('session.list', {})) as { sessions: { id: string }[] }).sessions.map(s => s.id)).not.toContain(sid)
    await expect(k.handle('session.prompt', { commandId: 'p-after', sessionId: sid, text: 'hi' })).rejects.toMatchObject({ code: -32602 })
    // 评审 M2:墓碑之后合并也是 unknown session
    await expect(k.handle('executor.worktree.merge', { commandId: 'm-after', sessionId: sid, runId })).rejects.toMatchObject({ code: -32602, message: 'unknown session' })
  })

  it('review I1: a live run → -32003 before the unmerged check; a worktree that turns up during the check → -32003, nothing deleted', async () => {
    const k = await full()
    const { sid, runId, worktree } = await seed(k)
    const executors = executorsOf()
    // 有活着的运行:一上来就忙,不去查 worktree
    const live = vi.spyOn(executors, 'liveFor').mockReturnValue(1)
    const unmerged = vi.spyOn(executors, 'unmergedFor')
    await expect(k.handle('session.delete', { commandId: 'i1-a', sessionId: sid, discardUnmerged: [runId] })).rejects.toMatchObject({ code: ERR_BUSY })
    expect(unmerged).not.toHaveBeenCalled()
    live.mockRestore()
    // 查的时候又结束了一个运行:它的 worktree 不在查过的那批里
    const extra = join(`${execData}-worktrees`, sid, 'run_late')
    unmerged.mockImplementation(async () => {
      mkdirSync(extra, { recursive: true })
      return [{ runId, files: 1 }]
    })
    const before = k.events.after(0, ALL).length
    await expect(k.handle('session.delete', { commandId: 'i1-b', sessionId: sid, discardUnmerged: [runId] })).rejects.toMatchObject({ code: ERR_BUSY })
    expect(k.events.after(0, ALL).length).toBe(before)
    expect(memory.inspect().store.metaWithPrefix('purge:')).toEqual([])
    expect(existsSync(worktree)).toBe(true)
    rmSync(extra, { recursive: true, force: true })
    unmerged.mockRestore()
    expect(await k.handle('session.delete', { commandId: 'i1-c', sessionId: sid, discardUnmerged: [runId] })).toMatchObject({ ok: true })
  })

  it('review M1: a finished run with no changes whose worktree the user edited afterwards counts as unmerged', async () => {
    const k = await full({ writes: {}, script: n => (n === 1 ? delegate({ prompt: 'look' }) : say('done')) })
    const sid = await execCreate(k, { origin: 'schedule' })
    await execPrompt(k, sid, 'go')
    await waitFor(() => ofType(k, sid, 'approval.requested').length === 1)
    await k.handle('approval.respond', { approvalId: pay<{ approvalId: string }>(ofType(k, sid, 'approval.requested')[0]).approvalId, decision: 'allow' })
    await waitFor(() => terminal(k, sid).length === 1, 30_000)
    const { runId, worktree } = pay<{ runId: string; worktree: string }>(ofType(k, sid, 'executor.run.ended')[0])
    const executors = executorsOf()
    expect(existsSync(worktree)).toBe(true)
    writeFileSync(join(worktree, 'a.txt'), 'edited by the user afterwards\n')
    expect(await executors.unmergedFor!(sid)).toEqual([{ runId, files: 1 }])
  })

  it('a session.prompt racing the delete: never both succeed', async () => {
    const k = await full({ script: () => say('ok') })
    for (let i = 0; i < 4; i++) {
      const sid = await execCreate(k)
      const deleting = k.handle('session.delete', { commandId: `race-${i}`, sessionId: sid }).then(() => 'ok', (e: { code?: number }) => e.code)
      if (i % 2 === 1) await new Promise(res => setImmediate(res))
      const prompting = k.handle('session.prompt', { commandId: `race-p-${i}`, sessionId: sid, text: 'hi' }).then(() => 'ok', (e: { code?: number; message?: string }) => e.code)
      const [d, p] = await Promise.all([deleting, prompting])
      expect([d, p], `round ${i}`).not.toEqual(['ok', 'ok'])
      if (d !== 'ok') expect(d).toBe(ERR_BUSY)
      if (p !== 'ok') expect(p).toBe(-32602)
      await waitFor(() => terminal(k, sid).length >= (p === 'ok' ? 1 : 0), 30_000)
    }
  })

  it('killed after the tombstone: the start sweeps remove the spill dir, the worktree and every ref, and resumeAll erases the session', async () => {
    const k = await full()
    const { sid, worktree, runId } = await seed(k)
    // 崩在墓碑之后:这一刻的数据目录、worktree 根、git 的 worktree 登记和我们的引用存下来,关内核之后放回去。
    // .git 本身不换:换了 inode,钉住的仓库就不认了
    const image = join(execData, '..', 'image')
    const wtRoot = `${execData}-worktrees`
    const dirs: [string, string][] = [[execData, 'data'], [wtRoot, 'wt'], [join(execCwd, '.git', 'worktrees'), 'gitwt']]
    let taken = false
    let savedRefs: string[] = []
    const take = () => {
      if (taken) return
      taken = true
      for (const [from, to] of dirs) cpSync(from, join(image, to), { recursive: true })
      savedRefs = sh('for-each-ref', '--format=%(refname) %(objectname)', 'refs/mffai/').split('\n').filter(Boolean)
      throw new Error('killed')
    }
    const hooked = memory
    vi.spyOn(hooked.inspect().store, 'rawOfSession').mockImplementation(() => take() as never)
    expect(await k.handle('session.delete', { commandId: 'kill', sessionId: sid, discardUnmerged: [runId] }).catch((e: { code?: number }) => e.code)).toBe(-32603)
    await k.close()
    execKernels.length = 0
    for (const [to, from] of dirs) {
      rmSync(to, { recursive: true, force: true })
      cpSync(join(image, from), to, { recursive: true })
    }
    for (const line of savedRefs) {
      const [ref, sha] = line.split(' ')
      sh('update-ref', ref, sha)
    }
    rmSync(image, { recursive: true, force: true })
    // 内核在写墓碑的同一步删落盘目录:崩在那之间就还在
    mkdirSync(join(execData, 'sessions', sid, 'spill'), { recursive: true })
    expect(existsSync(worktree)).toBe(true)
    expect(refsOf(sid).length).toBeGreaterThan(0)

    const { k: k2 } = await execBoot(fake({ lines: runLines }), { script, rules: ASK_ECHO, extra: [memPlugin()] })
    expect(((await k2.handle('session.list', {})) as { sessions: { id: string }[] }).sessions.map(s => s.id)).not.toContain(sid)
    expect(existsSync(join(execData, 'sessions', sid))).toBe(false)
    await waitFor(() => !existsSync(worktree) && refsOf(sid).length === 0, 20_000)
    expect(sh('worktree', 'list')).not.toContain(worktree)
    await waitFor(() => k2.events.bySession(sid).every(e => (e.payload as { erased?: boolean }).erased === true), 20_000)
    for (let i = 0; i < 400 && memory.inspect().store.metaWithPrefix('purge:').length > 0; i++) await new Promise(res => setTimeout(res, 10))
    expect(memory.inspect().store.metaWithPrefix('purge:')).toEqual([])
    const hay = dbBytes(eventsDb(execData), memoryDb(execData))
    for (const m of MARKERS) expect(hay.includes(m), m).toBe(false)
  })
})
