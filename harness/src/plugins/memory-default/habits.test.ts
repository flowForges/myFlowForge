// 习惯与推荐(06 spec §15,Review Focus 3 的习惯部分)。统计不用模型,推荐只发一个事件。
// 事件时间不能注入,所以时段用 countHabit 直接喂;接入那一段用事件自己的 ts 反推
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import type { SessionInfo } from '../../kernel/sessions'
import type { MemoryConfig } from '../../lib/memory/types'
import { MemoryConfigSchema } from '../../lib/memory/types'
import type { KernelEvent } from '../../protocol/events'
import { MemoryRecommendationPayloadSchema } from '../../protocol/events'
import { MemoryHabitSchema } from '../../protocol/rpc'
import { fakeClock, fakeModels, memoryKernel, type MemoryRig } from '../../../test/memoryRig'
import { createLoopDefault } from '../loop-default'
import toolsRegistry from '../tools-registry'
import { computeHabits, countHabit, decideHabit, listHabits, maybeRecommend, noteTurn, type RecommendDeps } from './habits'
import { createMemoryDefault, type MemoryDefaultPlugin } from './index'
import type { Store } from './store'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** 从 8:30 起:定时 60 秒后第一次,之后每小时,这样才走过 9:31 */
const TO_SLOT = HOUR + 2 * 60_000
const CWD = '/work/habit-repo'
const OTHER = '/work/other-repo'
/** 2026-11-02 是周一。week 是相对这一周的周数 */
const monday = (week: number, hour = 9, minute = 30) => new Date(2026, 10, 2 + 7 * week, hour, minute).getTime()
const friday = (week: number, hour = 9, minute = 30) => new Date(2026, 10, 6 + 7 * week, hour, minute).getTime()
const OWNER: SessionInfo = { sessionId: 's', cwd: CWD, approvalMode: 'auto', origin: 'app', audience: 'owner' }
const userEvent = (payload: object = {}): KernelEvent => ({ seq: 1, ts: 0, type: 'message.user', sessionId: 's', payload: { turnId: 't', text: 'HABIT-TEXT-MARKER', ...payload } })

let rig: MemoryRig | undefined
afterEach(async () => {
  await rig?.close()
  rig = undefined
})

interface BootOpts {
  config?: Record<string, unknown>
  loop?: boolean
  start?: number
}

async function boot(o: BootOpts = {}) {
  const clock = fakeClock(o.start ?? monday(3))
  const models = fakeModels()
  let ctx!: PluginContext
  let memory!: MemoryDefaultPlugin
  const probe: Plugin = { manifest: { id: 'probe', version: '0', kernel: '^0.1.0' }, activate: c => { ctx = c } }
  rig = await memoryKernel({
    models,
    // 夜间整合关掉:这里的定时只看推荐
    config: o.config ?? { memory: { nightly: { enabled: false } } },
    plugins: () => {
      memory = createMemoryDefault({ now: clock.now, timers: clock.timers })
      return [toolsRegistry, memory, ...(o.loop ? [createLoopDefault()] : []), probe]
    },
  })
  const r = rig
  let n = 0
  const h = {
    r,
    clock,
    models,
    ctx: () => ctx,
    memory: () => memory,
    store: (): Store => memory.inspect().store,
    session: async (params: object = {}) => ((await r.k.handle('session.create', { commandId: `c${++n}`, cwd: r.cwd, ...params })) as { sessionId: string }).sessionId,
    /** 这个 cwd 在这些时刻开过轮 */
    seed: (ts: number[], cwd = CWD) => {
      for (const at of ts) countHabit(memory.inspect().store, userEvent(), { ...OWNER, cwd }, at)
    },
    compute: (now: number) => computeHabits(memory.inspect().store, now),
    habits: () => listHabits(memory.inspect().store),
    /** 周一 9 点的习惯,已确认 */
    confirmed: (cwd = CWD) => {
      h.seed([monday(0), monday(1), monday(2)], cwd)
      h.compute(monday(3, 8))
      const habit = h.habits().find(x => x.cwd === cwd)
      if (!habit) throw new Error('no habit')
      decideHabit(memory.inspect().store, habit.id, 'confirmed', monday(3, 8))
      return habit
    },
    recommendations: () => r.k.events.after(0, 1_000_000).filter(e => e.type === 'memory.recommendation'),
    call: (method: string, params: object) => r.k.handle(method as never, params as never) as Promise<unknown>,
    configFile: () => JSON.parse(readFileSync(join(r.dataDir, 'config.json'), 'utf8')) as Record<string, unknown>,
  }
  return h
}

type H = Awaited<ReturnType<typeof boot>>

/** 直接调推荐,条件由用例定;定时那条路单独有用例 */
function recommender(h: H, o: { routine?: boolean; open?: boolean; caughtUp?: boolean } = {}): (now: number) => void {
  const config: MemoryConfig = MemoryConfigSchema.parse({ recommendations: { routine: o.routine ?? true } })
  const deps: RecommendDeps = {
    store: h.store(),
    config: () => config,
    hasOpenTurn: () => o.open ?? false,
    catchUp: () => o.caughtUp ?? true,
    append: e => h.ctx().append(e),
  }
  return now => maybeRecommend(deps, now)
}

describe('countHabit', () => {
  const counts = (h: H) => h.store().db.prepare('SELECT kind, key, week, n FROM habit_counts').all() as { kind: string; key: string; week: string; n: number }[]

  it('a new turn from the owner counts under weekday, hour and cwd, and no text is stored', async () => {
    const h = await boot()
    countHabit(h.store(), userEvent(), OWNER, monday(0))
    countHabit(h.store(), userEvent(), OWNER, monday(0, 9, 45))
    expect(counts(h)).toEqual([{ kind: 'routine', key: `1|9|${CWD}`, week: '2026-11-02', n: 2 }])
    expect(JSON.stringify(counts(h))).not.toContain('HABIT-TEXT-MARKER')
  })

  it('the week starts on Monday: a Sunday belongs to the week before', async () => {
    const h = await boot()
    countHabit(h.store(), userEvent(), OWNER, new Date(2026, 10, 8, 9).getTime())
    expect(counts(h)).toEqual([{ kind: 'routine', key: `0|9|${CWD}`, week: '2026-11-02', n: 1 }])
  })

  it.each([
    ['a follow-up', userEvent({ followUp: true }), OWNER],
    ['a group', userEvent(), { ...OWNER, origin: 'im', audience: 'group' }],
    ['a schedule', userEvent(), { ...OWNER, origin: 'schedule' }],
    ['an ACP client', userEvent(), { ...OWNER, origin: 'acp' }],
    ['a session with no cwd', userEvent(), { sessionId: 's', approvalMode: 'auto', origin: 'app', audience: 'owner' }],
    ['another event type', { ...userEvent(), type: 'message.assistant' }, OWNER],
  ] as [string, KernelEvent, SessionInfo][])('%s is not counted', async (_name, event, session) => {
    const h = await boot()
    countHabit(h.store(), event, session, monday(0))
    expect(counts(h)).toEqual([])
  })

  it('a paired IM chat counts', async () => {
    const h = await boot()
    countHabit(h.store(), userEvent(), { ...OWNER, origin: 'im', audience: 'owner' }, monday(0))
    expect(counts(h)).toHaveLength(1)
  })

  it('ingest counts from the log with the event time, once per event, and skips groups and follow-ups', async () => {
    const h = await boot()
    const owner = await h.session()
    const group = await h.session({ origin: 'im' })
    const schedule = await h.session({ origin: 'schedule' })
    const e = h.ctx().append({ type: 'message.user', sessionId: owner, payload: { turnId: 't1', text: 'HABIT-TEXT-MARKER' } })
    h.ctx().append({ type: 'message.user', sessionId: owner, payload: { turnId: 't1', text: 'more', followUp: true } })
    h.ctx().append({ type: 'message.user', sessionId: group, payload: { turnId: 't2', text: 'in the group' } })
    h.ctx().append({ type: 'message.user', sessionId: schedule, payload: { turnId: 't3', text: 'scheduled' } })
    h.memory().flushNow()
    h.memory().flushNow()
    const at = new Date(e.ts)
    expect(counts(h)).toEqual([expect.objectContaining({ key: `${at.getDay()}|${at.getHours()}|${h.r.cwd}`, n: 1 })])
  })
})

describe('computeHabits', () => {
  it('three of the last four occurrences is a habit, two is not', async () => {
    const h = await boot()
    h.seed([monday(0), monday(2)])
    h.compute(monday(3, 8))
    expect(h.habits()).toEqual([])
    h.seed([monday(1)])
    h.compute(monday(3, 8))
    expect(h.habits()).toEqual([expect.objectContaining({ kind: 'routine', weekday: 1, hour: 9, cwd: CWD, status: 'detected' })])
    expect(MemoryHabitSchema.safeParse(h.habits()[0]).success).toBe(true)
  })

  it('an occurrence five weeks back is out of the window', async () => {
    const h = await boot()
    h.seed([monday(0), monday(1), monday(2)])
    // 周一 9 点半:这周这个时段已经到了,窗口是第 4、3、2、1 周,只剩两周
    h.compute(monday(4))
    expect(h.habits()).toEqual([])
  })

  it('this week counts once its slot has started', async () => {
    const h = await boot()
    h.seed([monday(1), monday(2), monday(4)])
    h.compute(monday(4))
    expect(h.habits()).toHaveLength(1)
  })

  it('a slot later this week does not shrink the window', async () => {
    const h = await boot()
    h.seed([friday(0), friday(1), friday(3)])
    // 周一算周五的时段:这周的周五还没到,窗口还是过去四个周五
    h.compute(monday(4, 3))
    expect(h.habits()).toEqual([expect.objectContaining({ weekday: 5, hour: 9 })])
  })

  it('many turns in one week are one week; other hours and other cwds do not add up', async () => {
    const h = await boot()
    h.seed([monday(0), monday(0, 9, 40), monday(0, 9, 50), monday(0, 10), monday(1, 10)])
    h.seed([monday(2)], OTHER)
    h.compute(monday(3, 8))
    expect(h.habits()).toEqual([])
  })

  it('a dismissed habit stays dismissed and a confirmed one stays confirmed, however often it is recomputed', async () => {
    const h = await boot()
    h.seed([monday(0), monday(1), monday(2)])
    h.seed([monday(0), monday(1), monday(2)], OTHER)
    h.compute(monday(3, 8))
    const [a, b] = h.habits()
    decideHabit(h.store(), a.id, 'dismissed', monday(3, 8))
    decideHabit(h.store(), b.id, 'confirmed', monday(3, 8))
    h.compute(monday(3, 8))
    h.compute(monday(20))
    expect(h.habits().map(x => [x.id, x.status])).toEqual([[a.id, 'dismissed'], [b.id, 'confirmed']])
  })

  it('a detected habit that stopped happening goes away, and can come back', async () => {
    const h = await boot()
    h.seed([monday(0), monday(1), monday(2)])
    h.compute(monday(3, 8))
    const { id } = h.habits()[0]
    h.compute(monday(20))
    expect(h.habits()).toEqual([])
    h.seed([monday(20), monday(21), monday(22)])
    h.compute(monday(23, 8))
    expect(h.habits().map(x => x.id)).toEqual([id])
  })
})

describe('memory.habits.*', () => {
  it('list and decide work over RPC; an unknown id is not found', async () => {
    const h = await boot()
    h.seed([monday(0), monday(1), monday(2)])
    h.compute(monday(3, 8))
    const { items } = (await h.call('memory.habits.list', {})) as { items: { id: string; status: string }[] }
    expect(items).toEqual([expect.objectContaining({ status: 'detected', cwd: CWD })])
    await expect(h.call('memory.habits.decide', { commandId: 'd1', id: items[0].id, decision: 'confirmed' })).resolves.toEqual({ ok: true })
    expect(h.habits()[0].status).toBe('confirmed')
    await expect(h.call('memory.habits.decide', { commandId: 'd2', id: items[0].id, decision: 'dismissed' })).resolves.toEqual({ ok: true })
    expect(h.habits()[0].status).toBe('dismissed')
    await expect(h.call('memory.habits.decide', { commandId: 'd3', id: 'nope', decision: 'confirmed' })).rejects.toMatchObject({ code: -32602 })
  })

  it('a consolidation computes habits, with no model call', async () => {
    const h = await boot()
    h.seed([monday(0), monday(1), monday(2)])
    await h.call('memory.consolidate', { commandId: 'run' })
    expect(h.habits()).toHaveLength(1)
    expect(h.models.calls).toEqual([])
  })
})

describe('maybeRecommend', () => {
  it('off by default: nothing, even on a confirmed habit in its slot', async () => {
    const h = await boot()
    h.confirmed()
    recommender(h, { routine: false })(monday(3))
    expect(h.recommendations()).toEqual([])
  })

  it('on but not confirmed: nothing, for detected and for dismissed', async () => {
    const h = await boot()
    h.seed([monday(0), monday(1), monday(2)])
    h.compute(monday(3, 8))
    recommender(h)(monday(3))
    decideHabit(h.store(), h.habits()[0].id, 'dismissed', monday(3))
    recommender(h)(monday(3))
    expect(h.recommendations()).toEqual([])
  })

  it('on, confirmed, in the slot and quiet: exactly one event, with the template text, and nothing else happens', async () => {
    const h = await boot()
    const habit = h.confirmed()
    const before = h.r.k.events.after(0, 1_000_000).length
    recommender(h)(monday(3))
    const events = h.r.k.events.after(0, 1_000_000).slice(before)
    expect(events.map(e => e.type)).toEqual(['memory.recommendation'])
    expect(events[0].sessionId).toBeUndefined()
    expect(events[0].payload).toEqual({ id: expect.any(String), category: 'routine', habitId: habit.id, text: '每周一 9 点你常在 habit-repo 工作', cwd: CWD })
    expect(MemoryRecommendationPayloadSchema.safeParse(events[0].payload).success).toBe(true)
  })

  it('the template names Sunday and only the last path segment', async () => {
    const h = await boot()
    const sunday = (week: number) => new Date(2026, 10, 8 + 7 * week, 21, 5).getTime()
    h.seed([sunday(0), sunday(1), sunday(2)], '/a/b/deep-repo/')
    h.compute(sunday(2) + HOUR)
    decideHabit(h.store(), h.habits()[0].id, 'confirmed', sunday(2))
    recommender(h)(sunday(3))
    expect(h.recommendations().map(e => (e.payload as { text: string }).text)).toEqual(['每周日 21 点你常在 deep-repo 工作'])
  })

  it('outside the slot: nothing', async () => {
    const h = await boot()
    h.confirmed()
    const rec = recommender(h)
    rec(monday(3, 8, 59))
    rec(monday(3, 10))
    rec(friday(3))
    expect(h.recommendations()).toEqual([])
  })

  it('the same hour again: nothing', async () => {
    const h = await boot()
    h.confirmed()
    const rec = recommender(h)
    rec(monday(3, 9, 5))
    rec(monday(3, 9, 50))
    expect(h.recommendations()).toHaveLength(1)
  })

  it('a seven-day cooldown, by date: not within it, and the same slot next week fires even at an earlier minute', async () => {
    const h = await boot()
    const habit = h.confirmed()
    const rec = recommender(h)
    rec(monday(3, 9, 50))
    expect(h.recommendations()).toHaveLength(1)
    // 同一个时段,六天前发过(直接改账):不发
    h.store().db.prepare('UPDATE habits SET last_recommended_at = ? WHERE id = ?').run(monday(4) - 6 * DAY, habit.id)
    rec(monday(4))
    expect(h.recommendations()).toHaveLength(1)
    h.store().db.prepare('UPDATE habits SET last_recommended_at = ? WHERE id = ?').run(monday(3, 9, 50), habit.id)
    // 上周 9:50 发的,这周定时落在 9:05:不足 168 小时,但已经隔了七个日子
    rec(monday(4, 9, 5))
    expect(h.recommendations()).toHaveLength(2)
    expect(h.recommendations()[0].payload).not.toEqual(h.recommendations()[1].payload)
  })

  it('at most one of this category a day, across cwds and hours', async () => {
    const h = await boot()
    h.confirmed()
    h.confirmed(OTHER)
    h.seed([monday(0, 11), monday(1, 11), monday(2, 11)], OTHER)
    h.compute(monday(3, 8))
    for (const x of h.habits()) decideHabit(h.store(), x.id, 'confirmed', monday(3, 8))
    const rec = recommender(h)
    rec(monday(3))
    rec(monday(3, 11))
    expect(h.recommendations()).toHaveLength(1)
  })

  it('an open turn: nothing, then quiet again: fires', async () => {
    const h = await boot()
    h.confirmed()
    recommender(h, { open: true })(monday(3))
    expect(h.recommendations()).toEqual([])
    recommender(h, { open: false })(monday(3))
    expect(h.recommendations()).toHaveLength(1)
  })

  it('a parked turn is still open; an ended or failed one is not', () => {
    const open = new Set<string>()
    const note = (type: KernelEvent['type'], payload: object) => noteTurn(open, { type, payload })
    note('message.user', { turnId: 'a' })
    note('turn.parked', { turnId: 'a' })
    expect(open.size).toBe(1)
    note('turn.resumed', { turnId: 'a' })
    note('message.user', { turnId: 'b' })
    note('turn.ended', { turnId: 'a' })
    expect([...open]).toEqual(['b'])
    note('turn.failed', { turnId: 'b' })
    expect(open.size).toBe(0)
    note('session.created', {})
    expect(open.size).toBe(0)
  })

  it('activity in that cwd today: nothing, even in an earlier hour', async () => {
    const h = await boot()
    h.confirmed()
    h.seed([monday(3, 7)])
    recommender(h)(monday(3))
    expect(h.recommendations()).toEqual([])
  })

  it('activity elsewhere today, or in that cwd on another day this week, does not stop it', async () => {
    const h = await boot()
    h.confirmed()
    h.seed([monday(3, 7)], OTHER)
    // 上周同一天的活动不算今天
    h.seed([monday(2, 7), new Date(2026, 10, 19, 9).getTime()])
    recommender(h)(monday(3))
    expect(h.recommendations()).toHaveLength(1)
  })

  it('ingest behind: nothing, today may have activity that has not been counted', async () => {
    const h = await boot()
    h.confirmed()
    recommender(h, { caughtUp: false })(monday(3))
    expect(h.recommendations()).toEqual([])
  })
})

describe('the whole flow', () => {
  it('source has no way to a model: habits.ts names no models, stream or contextFor', () => {
    const source = readFileSync(join(import.meta.dirname, 'habits.ts'), 'utf8')
    for (const word of ['models', 'stream', 'contextFor']) expect(source).not.toContain(word)
  })

  const ROUTINE_ON = { memory: { nightly: { enabled: false }, recommendations: { routine: true } } }

  it('the hourly tick fires it from config, no model is called, no session opens', async () => {
    const h = await boot({ config: ROUTINE_ON, start: monday(3, 8, 30) })
    h.confirmed()
    h.clock.advance(TO_SLOT)
    expect(h.recommendations()).toHaveLength(1)
    h.clock.advance(HOUR)
    expect(h.recommendations()).toHaveLength(1)
    expect(h.models.calls).toEqual([])
    expect(h.r.k.events.after(0, 1_000_000).filter(e => e.type === 'session.created' || e.type === 'turn.started')).toEqual([])
  })

  it('a live open turn stops the tick, its end lets the next slot through', async () => {
    const h = await boot({ config: ROUTINE_ON, start: monday(3, 8, 30) })
    h.confirmed()
    const s = await h.session()
    h.ctx().append({ type: 'message.user', sessionId: s, payload: { turnId: 'live', text: 'x' } })
    h.clock.advance(TO_SLOT)
    expect(h.recommendations()).toEqual([])
    h.ctx().append({ type: 'turn.ended', sessionId: s, payload: { turnId: 'live' } })
    h.clock.advance(7 * DAY)
    expect(h.recommendations()).toHaveLength(1)
  })

  it('a session never sees a habit: request bodies and memory.injected carry none of it, and no background call happens', async () => {
    const h = await boot({ config: ROUTINE_ON, start: monday(3, 8, 30), loop: true })
    h.confirmed()
    h.clock.advance(TO_SLOT)
    const [event] = h.recommendations()
    const { text } = event.payload as { text: string }
    const s = await h.session()
    await h.r.k.handle('session.prompt', { commandId: 'p', sessionId: s, text: '今天做什么' })
    for (let i = 0; i < 400 && !h.r.k.events.bySession(s).some(e => e.type === 'turn.ended' || e.type === 'turn.failed'); i++) await new Promise(res => setTimeout(res, 5))
    expect(h.r.k.events.bySession(s).some(e => e.type === 'turn.ended')).toBe(true)
    expect(h.models.foreground().length).toBeGreaterThan(0)
    expect(h.models.background()).toEqual([])
    const bodies = JSON.stringify(h.models.calls.map(c => c.req))
    for (const needle of [text, 'habit-repo', '常在', event.payload && (event.payload as { habitId: string }).habitId]) expect(bodies).not.toContain(needle)
    const injected = JSON.stringify(h.r.k.events.after(0, 1_000_000).filter(e => e.type === 'memory.injected'))
    for (const needle of [text, 'habit-repo', '常在']) expect(injected).not.toContain(needle)
    expect(h.r.k.events.bySession(s).some(e => e.type === 'memory.recommendation')).toBe(false)
  })

  it('memory.recommendations.set round-trips through config.json, keeps the rest of the section and leaves permissions alone', async () => {
    const permissions = { allowUnsandboxedAuto: false, rules: ['deny shell(rm *)'] }
    const h = await boot({ config: { permissions, memory: { tokensPerDay: 5, nightly: { enabled: false } } }, start: monday(3, 8, 30) })
    h.confirmed()
    const before = JSON.stringify(h.configFile().permissions)
    // 默认关
    h.clock.advance(TO_SLOT)
    expect(h.recommendations()).toEqual([])
    await expect(h.call('memory.recommendations.set', { commandId: 'on', routine: true })).resolves.toEqual({ ok: true })
    expect(h.configFile().memory).toEqual({ tokensPerDay: 5, nightly: { enabled: false }, recommendations: { routine: true } })
    expect(JSON.stringify(h.configFile().permissions)).toBe(before)
    // 立刻生效,不用重启;下周同一个时段
    h.clock.advance(7 * DAY)
    expect(h.recommendations()).toHaveLength(1)
    // 重启之后还是开着。重启要走一遍:新定时在首次检查后每小时一次
    await h.r.restart()
    expect(h.configFile().memory).toMatchObject({ recommendations: { routine: true } })
    await expect(h.call('memory.recommendations.set', { commandId: 'off', routine: false })).resolves.toEqual({ ok: true })
    expect(h.configFile().memory).toEqual({ tokensPerDay: 5, nightly: { enabled: false }, recommendations: { routine: false } })
    expect(JSON.stringify(h.configFile().permissions)).toBe(before)
    h.clock.advance(7 * DAY)
    expect(h.recommendations()).toHaveLength(1)
  })

  it('after a restart the setting still applies', async () => {
    const h = await boot({ config: { memory: { nightly: { enabled: false } } }, start: monday(3, 8, 30) })
    h.confirmed()
    await h.call('memory.recommendations.set', { commandId: 'on', routine: true })
    await h.r.restart()
    h.clock.advance(TO_SLOT)
    expect(h.recommendations()).toHaveLength(1)
  })

  it('a broken memory section is replaced by a valid one, so the setting survives', async () => {
    const h = await boot({ config: { memory: { tokensPerDay: 'lots' } } })
    await h.call('memory.recommendations.set', { commandId: 'on', routine: true })
    expect(h.configFile().memory).toEqual({ recommendations: { routine: true } })
  })
})
