import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Sessions } from '../../kernel/sessions'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import type { KernelEvent } from '../../protocol/events'
import { fakeClock, memoryKernel, type FakeClock, type MemoryRig } from '../../../test/memoryRig'
import { Ingest, type IngestDeps } from './ingest'
import { openStore, type Store } from './store'

const log = { info() {}, warn() {}, error() {}, debug() {} }

interface Harness {
  rig: MemoryRig
  ctx(): PluginContext
  sessions(): Sessions
  store: Store
  file: string
  clock: FakeClock
  /** after 的包装:dead 之后什么都拉不到,等于进程没了 */
  kill(): void
  /** 第 n 次拉取时调 */
  onPull?: (n: number) => void
  ingest(over?: Partial<IngestDeps>): Ingest
  reopen(): Store
}

const open: { rig?: MemoryRig; stores: Store[]; ingests: Ingest[] } = { stores: [], ingests: [] }

afterEach(async () => {
  for (const i of open.ingests.splice(0)) i.stop()
  for (const s of open.stores.splice(0)) s.close()
  await open.rig?.close()
  open.rig = undefined
})

/** Task 5 的 scopeOf 的结构:owner 读 owner,群聊读自己,不认识的会话什么都没有 */
const scopeOf = (session: { sessionId: string; audience: string } | undefined) =>
  !session ? { read: [] } : session.audience === 'owner' ? { read: ['owner'] } : { read: [`session:${session.sessionId}`] }

async function harness(): Promise<Harness> {
  let ctx!: PluginContext
  const probe: Plugin = { manifest: { id: 'memory-probe', version: '0', kernel: '^0.1.0' }, activate: c => { ctx = c } }
  const rig = await memoryKernel({ plugins: () => [probe] })
  open.rig = rig
  const dir = join(rig.root, 'mem')
  mkdirSync(dir)
  const file = join(dir, 'memory.sqlite')
  const clock = fakeClock()
  let dead = false
  const openOne = () => {
    const s = openStore(file, { log })
    open.stores.push(s)
    return s
  }
  const h: Harness = {
    rig,
    ctx: () => ctx,
    sessions: () => ctx.services.get<Sessions>('sessions')!,
    store: openOne(),
    file,
    clock,
    kill: () => { dead = true },
    ingest(over = {}) {
      dead = false
      let pulls = 0
      const i = new Ingest({
        store: h.store,
        events: {
          after: (seq, limit) => {
            if (limit > 1) h.onPull?.(++pulls)
            return dead ? [] : ctx.events.after(seq, limit)
          },
          onAppend: cb => ctx.events.onAppend(cb),
        },
        sessions: h.sessions(),
        scopeOf,
        timers: clock.timers,
        log,
        ...over,
      })
      open.ingests.push(i)
      return i
    },
    reopen() {
      open.stores.splice(open.stores.indexOf(h.store), 1)
      h.store.close()
      h.store = openOne()
      return h.store
    },
  }
  return h
}

type EventInput = Omit<KernelEvent, 'seq' | 'ts'>
const session = (h: Harness, sessionId: string, payload: object = {}) => h.ctx().append({ type: 'session.created', sessionId, payload } as EventInput)
const say = (h: Harness, sessionId: string, turnId: string, text: string) => h.ctx().append({ type: 'message.user', sessionId, payload: { turnId, text } })
const rowCount = (s: Store) => (s.db.prepare('SELECT count(*) AS n FROM raw').get() as { n: number }).n
const allSeqs = (s: Store) => (s.db.prepare('SELECT seq FROM raw ORDER BY seq').all() as { seq: number }[]).map(r => r.seq)
const texts = (s: Store) => (s.db.prepare('SELECT text FROM raw ORDER BY seq').all() as { text: string }[]).map(r => r.text)
const tick = () => new Promise<void>(r => setImmediate(r))

describe('which events enter', () => {
  it('only the listed types; deltas, usage, approvals, reasoning do not', async () => {
    const h = await harness()
    session(h, 's')
    const a = h.ctx()
    a.append({ type: 'turn.started', sessionId: 's', payload: { turnId: 't' } })
    a.append({ type: 'message.user', sessionId: 's', payload: { turnId: 't', text: 'U' } })
    a.append({ type: 'message.reasoning.delta', sessionId: 's', payload: { turnId: 't', text: 'THINK' } })
    a.append({ type: 'message.assistant.delta', sessionId: 's', payload: { turnId: 't', text: 'DELTA' } })
    a.append({ type: 'message.assistant', sessionId: 's', payload: { turnId: 't', text: 'A', parts: [{ type: 'reasoning', text: 'PARTTHINK' }] } })
    a.append({ type: 'turn.usage', sessionId: 's', payload: { turnId: 't', input: 1, output: 1 } })
    a.append({ type: 'tool.started', sessionId: 's', payload: { turnId: 't', callId: 'c', name: 'read', argsPreview: 'ARGS' } })
    a.append({ type: 'approval.requested', sessionId: 's', payload: { turnId: 't', text: 'ASK' } })
    a.append({ type: 'tool.ended', sessionId: 's', payload: { turnId: 't', callId: 'c', name: 'read', ok: true, content: 'R' } })
    a.append({ type: 'executor.notice', sessionId: 's', payload: { turnId: 't', runId: 'r', text: 'N' } })
    a.append({ type: 'memory.injected', sessionId: 's', payload: { turnId: 't', kind: 'turn', text: 'INJ', items: [] } })
    a.append({ type: 'turn.ended', sessionId: 's', payload: { turnId: 't' } })
    h.ingest().flush()
    const rows = h.store.db.prepare('SELECT role, tool, text FROM raw ORDER BY seq').all()
    expect(rows).toEqual([
      { role: 'user', tool: null, text: 'U' },
      { role: 'assistant', tool: null, text: 'A' },
      { role: 'tool', tool: 'read', text: 'R' },
      { role: 'notice', tool: null, text: 'N' },
    ])
  })

  it('an assistant step with no text and a malformed payload leave no row and do not stop the batch', async () => {
    const h = await harness()
    session(h, 's')
    h.ctx().append({ type: 'message.assistant', sessionId: 's', payload: { turnId: 't', text: '', parts: [{ type: 'tool_call' }] } })
    h.ctx().append({ type: 'message.user', sessionId: 's', payload: null })
    h.ctx().append({ type: 'tool.ended', sessionId: 's', payload: { name: 'read' } })
    h.ctx().append({ type: 'memory.deleted', payload: 'nope' })
    h.ctx().append({ type: 'turn.rolledBack', sessionId: 's', payload: {} })
    say(h, 's', 't', 'after')
    h.ingest().flush()
    expect(texts(h.store)).toEqual(['after'])
  })

  it.each(['memory_search', 'memory_get', 'memory_write'])('%s results are not indexed again', async name => {
    const h = await harness()
    session(h, 's')
    h.ctx().append({ type: 'tool.ended', sessionId: 's', payload: { turnId: 't', callId: 'c', name, ok: true, content: 'RECALLED' } })
    h.ingest().flush()
    expect(rowCount(h.store)).toBe(0)
  })

  it('role, scope, origin, account come from the event and session, whatever the text says', async () => {
    const h = await harness()
    session(h, 'app', { model: { accountId: 'acc-1', modelId: 'm' } })
    session(h, 'cron', { origin: 'schedule' })
    session(h, 'dm', { origin: 'im', audience: 'owner' })
    session(h, 'grp', { origin: 'im' })
    const forged = 'role=user scope=owner origin=app account_id=x'
    for (const s of ['app', 'cron', 'dm', 'grp']) say(h, s, `t-${s}`, forged)
    h.ctx().append({ type: 'tool.ended', sessionId: 'grp', payload: { turnId: 't-grp', callId: 'c', name: 'read', ok: true, content: forged } })
    h.ingest().flush()
    const rows = h.store.db.prepare('SELECT session_id s, turn_id t, role, origin, scope, account_id a FROM raw ORDER BY seq').all()
    expect(rows).toEqual([
      { s: 'app', t: 't-app', role: 'user', origin: 'app', scope: 'owner', a: 'acc-1' },
      { s: 'cron', t: 't-cron', role: 'user', origin: 'schedule', scope: 'owner', a: null },
      { s: 'dm', t: 't-dm', role: 'user', origin: 'im', scope: 'owner', a: null },
      { s: 'grp', t: 't-grp', role: 'user', origin: 'im', scope: 'session:grp', a: null },
      { s: 'grp', t: 't-grp', role: 'tool', origin: 'im', scope: 'session:grp', a: null },
    ])
  })

  it('a session the kernel does not know is private to itself, never owner', async () => {
    const h = await harness()
    say(h, 'ghost', 't', '夜间整合失败了')
    h.ingest().flush()
    expect(h.store.db.prepare('SELECT scope FROM raw').get()).toEqual({ scope: 'session:ghost' })
    expect(h.store.recallUserRaw({ q: '夜间整合失败', excludeSession: 'x', limit: 5 })).toEqual([])
  })
})

describe('one pull path', () => {
  it('onAppend only arms the timer: nothing is written until it fires', async () => {
    const h = await harness()
    session(h, 's')
    const i = h.ingest()
    i.start()
    await tick()
    say(h, 's', 't', 'one')
    expect(rowCount(h.store)).toBe(0)
    h.clock.advance(249)
    expect(rowCount(h.store)).toBe(0)
    h.clock.advance(1)
    expect(texts(h.store)).toEqual(['one'])
  })

  it('never reads the log inside the append callback, and 200 appends wake it without the timer', async () => {
    const h = await harness()
    session(h, 's')
    let pulls = 0
    h.onPull = () => { pulls++ }
    const i = h.ingest()
    i.start()
    await tick()
    const before = pulls
    for (let n = 0; n < 199; n++) say(h, 's', 't', `m${n}`)
    expect(pulls).toBe(before)
    say(h, 's', 't', 'last')
    expect(pulls).toBe(before)
    await tick()
    expect(rowCount(h.store)).toBe(200)
  })

  it('flush catches up at once and stop pulls one last time', async () => {
    const h = await harness()
    session(h, 's')
    const i = h.ingest()
    i.start()
    await tick()
    say(h, 's', 't', 'a')
    i.flush()
    expect(texts(h.store)).toEqual(['a'])
    say(h, 's', 't', 'b')
    i.stop()
    expect(texts(h.store)).toEqual(['a', 'b'])
    say(h, 's', 't', 'c')
    h.clock.advance(1000)
    await tick()
    expect(texts(h.store)).toEqual(['a', 'b'])
  })

  it('row and cursor move together: a failure mid-batch leaves neither, and the next wake retries', async () => {
    const h = await harness()
    session(h, 's')
    say(h, 's', 't', 'a')
    say(h, 's', 't', 'b')
    let broken = true
    let calls = 0
    const errors: string[] = []
    const i = h.ingest({
      scopeOf: s => {
        // 第一行已经写进事务了。errcode 是 node:sqlite 的形状:13 = SQLITE_FULL
        if (broken && ++calls === 2) throw Object.assign(new Error('database or disk is full'), { errcode: 13 })
        return scopeOf(s)
      },
      log: { ...log, error: (m: string) => errors.push(m) },
    })
    i.flush()
    expect(rowCount(h.store)).toBe(0)
    expect(h.store.cursor()).toBe(0)
    expect(errors).toHaveLength(1)
    expect(h.store.problems).toEqual(['ingest_failing'])
    broken = false
    i.flush()
    expect(texts(h.store)).toEqual(['a', 'b'])
    expect(h.store.problems).toEqual([])
    expect(h.store.cursor()).toBe(h.ctx().events.after(0, 1000).at(-1)!.seq)
  })
})

describe('a bad event', () => {
  /** 这个会话的事件一处理就抛错;错误文本里带着内容,看它有没有进日志 */
  const BAD_SESSION = 'bad'
  const poisoned = (s: { sessionId: string; audience: string } | undefined) => {
    if (s?.sessionId === BAD_SESSION) throw new Error('boom 私密内容')
    return scopeOf(s)
  }
  const recorder = () => {
    const lines: { msg: string; data: unknown }[] = []
    return { lines, log: { ...log, error: (msg: string, data?: unknown) => lines.push({ msg, data }) } }
  }

  it('is skipped by seq, the rest of its batch goes in, and the cursor reaches the end', async () => {
    const h = await harness()
    session(h, 's')
    session(h, BAD_SESSION)
    say(h, 's', 't1', 'before')
    say(h, BAD_SESSION, 't2', '私密内容')
    say(h, 's', 't3', 'after')
    const all = h.ctx().events.after(0, 1000)
    const bad = all.find(e => e.type === 'message.user' && e.sessionId === BAD_SESSION)!
    const { lines, log: recording } = recorder()
    h.ingest({ scopeOf: poisoned, log: recording }).flush()
    expect(texts(h.store)).toEqual(['before', 'after'])
    expect(h.store.cursor()).toBe(all.at(-1)!.seq)
    expect(lines).toEqual([{ msg: expect.any(String), data: { seq: bad.seq, kind: 'message.user' } }])
    expect(h.store.problems).toEqual(['ingest_skipped_events'])
  })

  it('no content from the event or the error reaches the log', async () => {
    const h = await harness()
    session(h, BAD_SESSION)
    say(h, BAD_SESSION, 't', '私密内容')
    const { lines, log: recording } = recorder()
    h.ingest({ scopeOf: poisoned, log: recording }).flush()
    expect(lines).toHaveLength(1)
    expect(JSON.stringify(lines)).not.toContain('私密内容')
    expect(JSON.stringify(lines)).not.toContain('boom')
  })

  it('does not hold ingest back after a restart, and new events keep flowing', async () => {
    const h = await harness()
    session(h, 's')
    session(h, BAD_SESSION)
    say(h, BAD_SESSION, 't1', 'x')
    const first = recorder()
    h.ingest({ scopeOf: poisoned, log: first.log }).flush()
    expect(first.lines).toHaveLength(1)
    h.store = h.reopen()
    say(h, 's', 't2', 'later')
    const second = recorder()
    h.ingest({ scopeOf: poisoned, log: second.log }).flush()
    expect(texts(h.store)).toEqual(['later'])
    expect(second.lines).toEqual([]) // 跳过的不再试
    expect(h.store.cursor()).toBe(h.ctx().events.after(0, 1000).at(-1)!.seq)
  })

  it('a batch keeps nothing from the failed attempt: rows are not doubled and hooks may run twice', async () => {
    const h = await harness()
    session(h, 's')
    session(h, BAD_SESSION)
    say(h, 's', 'gone', 'x')
    h.ctx().append({ type: 'turn.rolledBack', sessionId: 's', payload: { turnId: 'gone' } })
    say(h, BAD_SESSION, 't', 'y')
    const hook: string[] = []
    h.ingest({ scopeOf: poisoned, onRolledBack: t => hook.push(t) }).flush()
    expect(rowCount(h.store)).toBe(1)
    expect(h.store.searchRaw({ q: 'x', scopes: ['owner'], limit: 5 })).toEqual([])
    expect(hook).toEqual(['gone', 'gone'])
  })

  it('every bad event of a large backlog is skipped across batches', async () => {
    const h = await harness()
    session(h, 's')
    session(h, BAD_SESSION)
    for (let n = 0; n < 600; n++) say(h, n % 100 === 0 ? BAD_SESSION : 's', 't', `m${n}`)
    const { lines, log: recording } = recorder()
    h.ingest({ scopeOf: poisoned, log: recording }).flush()
    expect(rowCount(h.store)).toBe(594)
    expect(lines).toHaveLength(6)
    expect(h.store.cursor()).toBe(h.ctx().events.after(0, 2000).at(-1)!.seq)
  })

  it('a database fault is never blamed on an event: it stops at that event, nothing is skipped', async () => {
    const h = await harness()
    session(h, 's')
    session(h, BAD_SESSION)
    say(h, 's', 't1', 'a')
    say(h, BAD_SESSION, 't2', 'bad')
    say(h, 's', 't3', 'b')
    let full = false
    const { lines, log: recording } = recorder()
    const i = h.ingest({
      scopeOf: s => {
        // 第一遍抛坏事件,逐条重试时磁盘满了
        if (s?.sessionId === BAD_SESSION) {
          if (full) throw Object.assign(new Error('database or disk is full'), { errcode: 13 })
          full = true
          throw new Error('bad event')
        }
        return scopeOf(s)
      },
      log: recording,
    })
    i.flush()
    expect(texts(h.store)).toEqual(['a'])
    expect(lines).toEqual([{ msg: 'memory ingest failed', data: { error: 'database or disk is full' } }])
    expect(h.store.problems).toEqual(['ingest_failing'])
    const cursor = h.store.cursor()
    expect(h.ctx().events.after(cursor, 1)[0].sessionId).toBe(BAD_SESSION) // 坏事件还没过
  })

  it('a constraint failure belongs to the event, an extended code still counts', async () => {
    const h = await harness()
    session(h, 's')
    session(h, BAD_SESSION)
    say(h, BAD_SESSION, 't1', 'bad')
    say(h, 's', 't2', 'good')
    const { lines, log: recording } = recorder()
    h.ingest({
      scopeOf: s => {
        // 2067 = SQLITE_CONSTRAINT_UNIQUE
        if (s?.sessionId === BAD_SESSION) throw Object.assign(new Error('UNIQUE constraint failed'), { errcode: 2067 })
        return scopeOf(s)
      },
      log: recording,
    }).flush()
    expect(texts(h.store)).toEqual(['good'])
    expect(lines).toHaveLength(1)
  })
})

describe('restart', () => {
  it('two kernels on one data dir, the first killed without a flush: no duplicates, no gaps', async () => {
    const h = await harness()
    session(h, 's')
    for (let n = 0; n < 700; n++) say(h, 's', 't', `m${n}`)
    const first = h.ingest()
    first.start()
    await tick()
    const mid = h.store.cursor()
    expect(mid).toBeGreaterThan(0)
    expect(rowCount(h.store)).toBeLessThan(700)
    h.kill()
    first.stop()
    await h.rig.restart()
    for (let n = 700; n < 710; n++) say(h, 's', 't', `m${n}`)
    h.reopen()
    expect(h.store.cursor()).toBe(mid)
    h.ingest().flush()
    expect(texts(h.store)).toEqual(Array.from({ length: 710 }, (_, n) => `m${n}`))
    expect(h.store.problems).toEqual([])
  })

  it('killed mid catch-up with new events arriving: every seq is present afterwards', async () => {
    const h = await harness()
    session(h, 's')
    for (let n = 0; n < 1600; n++) say(h, 's', 't', `old${n}`)
    h.onPull = pull => {
      // 追赶中途新事件到达,又碰上进程没了
      if (pull === 2) say(h, 's', 't', 'during')
    }
    const first = h.ingest()
    first.start()
    await tick()
    await tick()
    h.kill()
    h.onPull = undefined
    say(h, 's', 't', 'after-kill')
    first.stop()
    const cursorAtDeath = h.store.cursor()
    await h.rig.restart()
    h.reopen()
    expect(h.store.cursor()).toBe(cursorAtDeath)
    h.ingest().flush()
    const expected = h.ctx().events.after(0, 10_000).filter(e => e.type === 'message.user').map(e => e.seq)
    expect(allSeqs(h.store)).toEqual(expected)
    expect(expected).toHaveLength(1602)
  })

  it('catchUp stops at its budget, says it is behind, and leaves the rest to batches off the stack', async () => {
    const h = await harness()
    for (let n = 0; n < 200; n++) h.ctx().append({ type: 'message.user', sessionId: 's', payload: { turnId: 't', text: `m${n}` } })
    let t = 0
    const i = h.ingest({ clock: () => (t += 30) })
    expect(i.catchUp(100)).toBe(false)
    const first = rowCount(h.store)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(60)
    await vi.waitFor(() => expect(rowCount(h.store)).toBe(200), { timeout: 15_000, interval: 5 })
    expect(i.catchUp(100)).toBe(true)
    i.stop()
    expect(i.catchUp(100)).toBe(false)
  })

  it('catchUp on a small backlog finishes and says so', async () => {
    const h = await harness()
    for (let n = 0; n < 25; n++) h.ctx().append({ type: 'message.user', sessionId: 's', payload: { turnId: 't', text: `m${n}` } })
    const i = h.ingest()
    expect(i.catchUp()).toBe(true)
    expect(rowCount(h.store)).toBe(25)
    i.stop()
  })

  it('a catch-up of 5000 events yields to the event loop', async () => {
    const h = await harness()
    session(h, 's')
    const events = Array.from({ length: 5000 }, (_, n) => `m${n}`)
    for (const text of events) say(h, 's', 't', text)
    const i = h.ingest()
    i.start()
    expect(rowCount(h.store)).toBe(0) // start 不在调用方的栈上拉
    let ticks = 0
    let stop = false
    const spin = () => {
      ticks++
      if (!stop) setImmediate(spin)
    }
    setImmediate(spin)
    await vi.waitFor(() => expect(rowCount(h.store)).toBe(5000), { timeout: 15_000, interval: 5 })
    stop = true
    expect(ticks).toBeGreaterThanOrEqual(9)
  }, 30_000)
})

describe('rollback and delete', () => {
  it('a rolled-back turn is excluded by default and the hook runs once with its id', async () => {
    const h = await harness()
    session(h, 's')
    say(h, 's', 'keep', '夜间整合保留的轮')
    say(h, 's', 'gone', '夜间整合撤销的轮')
    h.ctx().append({ type: 'turn.rolledBack', sessionId: 's', payload: { turnId: 'gone', files: 0 } })
    const onRolledBack = vi.fn()
    h.ingest({ onRolledBack }).flush()
    expect(h.store.searchRaw({ q: '夜间整合', scopes: ['owner'], limit: 5 }).map(r => r.turnId)).toEqual(['keep'])
    expect(h.store.searchRaw({ q: '夜间整合', scopes: ['owner'], limit: 5, includeRolledBack: true })).toHaveLength(2)
    expect(onRolledBack.mock.calls).toEqual([['gone']])
  })

  it('a late event of a rolled-back turn stays rolled back', async () => {
    const h = await harness()
    session(h, 's')
    say(h, 's', 'gone', '夜间整合撤销的轮')
    h.ctx().append({ type: 'turn.rolledBack', sessionId: 's', payload: { turnId: 'gone', files: 0 } })
    h.ctx().append({ type: 'executor.notice', sessionId: 's', payload: { turnId: 'gone', runId: 'r', text: '夜间整合迟到的通知' } })
    h.ingest().flush()
    expect(h.store.searchRaw({ q: '夜间整合', scopes: ['owner'], limit: 5 })).toEqual([])
  })

  it('a throwing hook is logged and does not stop ingest', async () => {
    const h = await harness()
    session(h, 's')
    say(h, 's', 'gone', 'x')
    h.ctx().append({ type: 'turn.rolledBack', sessionId: 's', payload: { turnId: 'gone' } })
    say(h, 's', 'next', 'y')
    const errors: string[] = []
    h.ingest({ onRolledBack: () => { throw new Error('nope') }, log: { ...log, error: (m: string) => errors.push(m) } }).flush()
    expect(texts(h.store)).toEqual(['x', 'y'])
    expect(errors).toHaveLength(1)
  })

  it('memory.deleted deletes its rows; the triggers leave FTS clean', async () => {
    const h = await harness()
    session(h, 's')
    const a = say(h, 's', 't', '夜间整合要删掉的话')
    say(h, 's', 't', '夜间整合留下的话')
    h.ctx().append({ type: 'memory.deleted', payload: { id: 'n_1', rawSeqs: [a.seq] } })
    h.ingest().flush()
    expect(h.store.searchRaw({ q: '夜间整合', scopes: ['owner'], limit: 5 }).map(r => r.text)).toEqual(['夜间整合留下的话'])
    h.store.integrityCheck()
  })

  it('after purge() the raw file holds neither the text nor its trigrams', async () => {
    const h = await harness()
    session(h, 's')
    const TEXT = '绝密火星基地坐标在奥林匹斯山脚下'
    const a = say(h, 's', 't', TEXT)
    say(h, 's', 't', '另外留下的一句话')
    h.ctx().append({ type: 'memory.deleted', payload: { id: 'n_1', rawSeqs: [a.seq] } })
    h.ingest().flush()
    h.store.purge()
    const raw = readFileSync(h.file)
    const chars = [...TEXT]
    for (let i = 0; i + 3 <= chars.length; i++) expect(raw.includes(Buffer.from(chars.slice(i, i + 3).join('')))).toBe(false)
  })
})

describe('a new database', () => {
  it('first activation over an old log: raw backfilled from 0, consolidation starts at the end', async () => {
    const h = await harness()
    session(h, 's')
    say(h, 's', 't', 'old')
    const last = say(h, 's', 't', 'older').seq
    const i = h.ingest()
    i.start()
    expect(h.store.getMeta('consolidationCursor')).toBe(String(last))
    expect(h.store.cursor()).toBe(0)
    i.flush()
    expect(texts(h.store)).toEqual(['old', 'older'])
    expect(h.store.cursor()).toBe(h.ctx().events.after(last - 1, 100).at(-1)!.seq)
    expect(h.store.getMeta('consolidationCursor')).toBe(String(last))
  })

  it('an existing database keeps its consolidation cursor', async () => {
    const h = await harness()
    session(h, 's')
    h.store.setMeta('consolidationCursor', '1')
    say(h, 's', 't', 'x')
    h.ingest().start()
    expect(h.store.getMeta('consolidationCursor')).toBe('1')
  })

  it('finds the last seq with few reads, whatever the log length', async () => {
    const h = await harness()
    session(h, 's')
    for (let n = 0; n < 300; n++) say(h, 's', 't', `m${n}`)
    const last = say(h, 's', 't', 'x').seq
    const after = vi.fn((seq: number, limit: number) => h.ctx().events.after(seq, limit))
    h.ingest({ events: { after, onAppend: cb => h.ctx().events.onAppend(cb) } }).start()
    expect(h.store.getMeta('consolidationCursor')).toBe(String(last))
    expect(after.mock.calls.length).toBeLessThan(25)
    for (const [, limit] of after.mock.calls) expect(limit).toBe(1)
  })

  it('an empty log starts at 0', async () => {
    const h = await harness()
    const none = { after: () => [], onAppend: () => () => {} }
    h.ingest({ events: none }).start()
    expect(h.store.getMeta('consolidationCursor')).toBe('0')
  })

  it('garbage bytes: renamed, rebuilt from the log, reported, and memory.deleted keeps its rows out', async () => {
    const h = await harness()
    session(h, 's')
    const a = say(h, 's', 't', '夜间整合删掉的话')
    say(h, 's', 't', '夜间整合留下的话')
    h.ctx().append({ type: 'memory.deleted', payload: { id: 'n_1', rawSeqs: [a.seq] } })
    const first = h.ingest()
    first.flush()
    first.stop()
    const last = say(h, 's', 't', '夜间整合新的话').seq
    h.store.close()
    open.stores.splice(open.stores.indexOf(h.store), 1)
    writeFileSync(h.file, 'garbage bytes '.repeat(500))
    const recovered = openStore(h.file, { log })
    open.stores.push(recovered)
    h.store = recovered
    expect(recovered.problems).toHaveLength(1)
    const i = h.ingest()
    i.start()
    i.flush()
    expect(texts(recovered)).toEqual(['夜间整合留下的话', '夜间整合新的话'])
    expect(recovered.searchRaw({ q: '删掉', scopes: ['owner'], limit: 5 })).toEqual([])
    expect(recovered.getMeta('consolidationCursor')).toBe(String(last))
    recovered.integrityCheck()
  })
})

describe('secrets in raw rows (Review Focus 4)', () => {
  // 拼出来的:仓库自己的扫描不能在这里命中
  const x = (n: number) => 'x'.repeat(n)
  const NOISY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0fG3hJ6kL9'
  const PEM = ['-----BEGIN ' + 'PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7', '-----END ' + 'PRIVATE KEY-----'].join('\n')
  const JWT = `eyJ${x(12)}.eyJ${x(12)}.${x(20)}`

  const MASKED: [string, string, string][] = [
    ['PEM', `key:\n${PEM}\nend`, 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'],
    ['sk-', `sk-${x(24)}`, `sk-${x(24)}`],
    ['ghp_', `ghp_${x(36)}`, `ghp_${x(36)}`],
    ['github_pat_', `github_pat_${x(30)}`, `github_pat_${x(30)}`],
    ['xox', `xoxb-${x(20)}`, `xoxb-${x(20)}`],
    ['AKIA', `AKIA${'A'.repeat(16)}`, `AKIA${'A'.repeat(16)}`],
    ['glpat-', `glpat-${x(24)}`, `glpat-${x(24)}`],
    ['npm_', `npm_${x(36)}`, `npm_${x(36)}`],
    ['hf_', `hf_${x(34)}`, `hf_${x(34)}`],
    ['AIza', `AIza${x(36)}`, `AIza${x(36)}`],
    ['ya29.', `ya29.${x(30)}`, `ya29.${x(30)}`],
    ['ASIA', `ASIA${'B'.repeat(16)}`, `ASIA${'B'.repeat(16)}`],
    ['telegram', `123456789:${x(36)}`, `123456789:${x(36)}`],
    ['jwt', JWT, JWT],
    ['bearer', `Bearer ${x(4)}9${x(20)}`, `${x(4)}9${x(20)}`],
    ['authorization', 'Authorization: Basic dXNlcjpzM2NyZXQ=', 'dXNlcjpzM2NyZXQ='],
    ['url account', 'postgres://u:hunter2pw@10.0.0.5:5432/db', 'hunter2pw'],
    ['password=', 'password=opensesame1', 'opensesame1'],
    ['passwd:', 'passwd: opensesame2', 'opensesame2'],
    ['api_key=', 'api_key=opensesame3', 'opensesame3'],
    ['secret:', 'secret: opensesame4', 'opensesame4'],
    ['token=', 'token=opensesame5', 'opensesame5'],
    ['密码是', '密码是 opensesame6', 'opensesame6'],
    ['口令:', '口令:opensesame7', 'opensesame7'],
    ['密钥为', '密钥为opensesame8', 'opensesame8'],
    ['high entropy', `value ${NOISY} end`, NOISY],
  ]
  const KEPT: [string, string][] = [
    ['connection host', '10.0.0.5:5432'],
    ['git sha', 'a'.repeat(8) + '0123456789abcdef0123456789abcdef'],
    ['uuid', '123e4567-e89b-12d3-a456-426614174000'],
    ['identifier', 'getUserProfileByAccountIdentifierFromCache'],
    ['path', '/usr/local/lib/node_modules/some-package/dist/index.js'],
  ]

  const ingestAll = async (texts: string[]) => {
    const h = await harness()
    session(h, 's')
    for (const text of texts) say(h, 's', 't', text)
    h.ingest().flush()
    h.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { h, bytes: readFileSync(h.file) }
  }

  it.each(MASKED)('%s is masked in every column and in the file bytes', async (_name, text, secret) => {
    const { h, bytes } = await ingestAll([text])
    expect(rowCount(h.store)).toBe(1)
    expect(JSON.stringify(h.store.db.prepare('SELECT * FROM raw').all())).not.toContain(secret)
    expect(bytes.includes(Buffer.from(secret))).toBe(false)
  })

  it('a secret sent in user text, assistant text, a tool result and a notice is masked in each', async () => {
    const secret = `sk-${x(24)}`
    const h = await harness()
    session(h, 's')
    const a = h.ctx()
    a.append({ type: 'message.user', sessionId: 's', payload: { turnId: 't', text: secret } })
    a.append({ type: 'message.assistant', sessionId: 's', payload: { turnId: 't', text: secret } })
    a.append({ type: 'tool.ended', sessionId: 's', payload: { turnId: 't', callId: 'c', name: `sk-${x(24)}`, ok: true, content: secret } })
    a.append({ type: 'executor.notice', sessionId: 's', payload: { turnId: 't', runId: 'r', text: secret } })
    h.ingest().flush()
    h.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    expect(rowCount(h.store)).toBe(4)
    expect(readFileSync(h.file).includes(Buffer.from(secret))).toBe(false)
  })

  it.each(KEPT)('%s is left alone', async (_name, text) => {
    const { h } = await ingestAll([`看这个 ${text} 结束`])
    expect(texts(h.store)[0]).toContain(text)
  })

  it('a secret split by zero-width characters is masked too', async () => {
    const secret = `sk-${x(24)}`
    const { h, bytes } = await ingestAll([`sk-\u200b${x(24)}`])
    expect(texts(h.store)[0]).not.toContain(secret)
    expect(bytes.includes(Buffer.from(x(24)))).toBe(false)
  })

  describe('clip order: scrub runs first', () => {
    it('a secret straddling the 16 000 clip point leaves nothing behind', async () => {
      const secret = `sk-${x(40)}`
      // clip 留头留尾:让密钥正好跨过头部的切点
      const head = Math.ceil(16_000 / 3) - 20
      const { h } = await ingestAll(['甲'.repeat(head) + secret + '乙'.repeat(20_000)])
      const stored = texts(h.store)[0]
      expect([...stored].length).toBeLessThanOrEqual(16_000)
      expect(stored).not.toMatch(/sk-x|xxxx/)
    })

    it('a PEM spanning lines across the clip leaves no body line', async () => {
      const h = await harness()
      session(h, 's')
      const body = Array.from({ length: 200 }, (_, n) => `MIIE${String(n).padStart(4, '0')}${x(60)}`).join('\n')
      h.ctx().append({ type: 'tool.ended', sessionId: 's', payload: { turnId: 't', callId: 'c', name: 'read', ok: true, content: `-----BEGIN ${'PRIVATE KEY'}-----\n${body}\n-----END ${'PRIVATE KEY'}-----\n` + '尾'.repeat(5000) } })
      h.ingest().flush()
      const stored = texts(h.store)[0]
      expect(stored.length).toBeLessThanOrEqual(4000)
      expect(stored).not.toContain('MIIE')
    })

    it('tool output and notices clip at 4000, user and assistant at 16 000', async () => {
      const h = await harness()
      session(h, 's')
      const long = '长'.repeat(20_000)
      const a = h.ctx()
      a.append({ type: 'message.user', sessionId: 's', payload: { turnId: 't', text: long } })
      a.append({ type: 'message.assistant', sessionId: 's', payload: { turnId: 't', text: long } })
      a.append({ type: 'tool.ended', sessionId: 's', payload: { turnId: 't', callId: 'c', name: 'read', ok: true, content: long } })
      a.append({ type: 'executor.notice', sessionId: 's', payload: { turnId: 't', runId: 'r', text: long } })
      h.ingest().flush()
      expect(texts(h.store).map(t => t.length)).toEqual([16_000, 16_000, 4000, 4000])
    })
  })

  // spec §11 的账:这些确实进库了。改了规则要回去改 §11
  describe('known gaps', () => {
    it('known gap: an unlabelled low-entropy secret is stored', async () => {
      const { h } = await ingestAll(['那个东西是 hunter2'])
      expect(texts(h.store)[0]).toContain('hunter2')
    })

    it('known gap: an unlabelled 40-hex key is stored', async () => {
      const key = '0123456789abcdef'.repeat(2) + '01234567'
      const { h } = await ingestAll([`看这个 ${key}`])
      expect(texts(h.store)[0]).toContain(key)
    })

    it('known gap: a secret split across two messages is stored', async () => {
      const { h } = await ingestAll(['前半段是 hunter', '后半段是 2secret'])
      expect(texts(h.store)).toEqual(['前半段是 hunter', '后半段是 2secret'])
    })
  })
})
