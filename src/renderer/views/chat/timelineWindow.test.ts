import { describe, it, expect } from 'vitest'
import { windowTimeline, LIVE_WINDOW, LIVE_WINDOW_STEP } from './timelineWindow'
import type { TimelineEntry } from './timeline'

const msg = (i: number): TimelineEntry => ({ kind: 'message', ts: i, index: i, msg: { id: `m${i}`, who: 'user', text: 't', ts: '' } as never })
const confirm = (ts: number): TimelineEntry => ({ kind: 'confirm', ts, confirm: { id: `c${ts}` } as never })
const plan = (ts: number): TimelineEntry => ({ kind: 'plan', ts, plan: { id: `p${ts}` } as never })
const gate = (ts: number): TimelineEntry => ({ kind: 'launch-gate', id: `g${ts}`, ts })
const pending = (ts: number): TimelineEntry => ({ kind: 'pending', ts, action: { id: `a${ts}` } as never })
const switchDivider = (ts: number): TimelineEntry => ({ kind: 'provider-switch', ts, from: 'claude', to: 'codex' })
const runCard = (ts: number, live: boolean): TimelineEntry => ({ kind: 'run-card', id: `r${ts}`, ts, ...(live ? { event: {} as never } : { frozen: {} as never }) })

describe('windowTimeline — 只渲染最近 N 条,更早的收起来', () => {
  it('没超过上限:原样全给,没有「加载更早」', () => {
    const e = [msg(0), msg(1), msg(2)]
    const w = windowTimeline(e, 10)
    expect(w.visible).toEqual(e)
    expect(w.hiddenCount).toBe(0)
    expect(w.fromIndex).toBe(0)
  })

  it('超过上限:只留最后 N 条消息,并报出藏了几条', () => {
    const e = Array.from({ length: 50 }, (_, i) => msg(i))
    const w = windowTimeline(e, 20)
    expect(w.visible).toHaveLength(20)
    expect((w.visible[0] as { msg: { id: string } }).msg.id).toBe('m30')
    expect(w.hiddenCount).toBe(30)
    expect(w.fromIndex).toBe(30)   // ChatJumpRail 据此只画渲染出来的那些锚点
  })

  it('★没渲染出来的消息不许留下能点的锚点:fromIndex 用的是消息自己的 index,不是数组下标', () => {
    // 时间线里夹着分割线/卡片时,数组下标和消息 index 会错开 —— 必须取消息自己的 index
    const e = [msg(0), switchDivider(1), msg(1), msg(2), msg(3)]
    const w = windowTimeline(e, 2)
    expect(w.fromIndex).toBe(2)
    expect(w.visible.every(x => x.kind === 'message')).toBe(true)
  })

  it('★★还没答的门/方案/启动闸**永远不许藏** —— 藏了就再也点不到,那一轮会一直挂着', () => {
    const e = [confirm(0), plan(1), gate(2), pending(3), ...Array.from({ length: 30 }, (_, i) => msg(i))]
    const w = windowTimeline(e, 5)
    expect(w.visible.filter(x => x.kind === 'confirm')).toHaveLength(1)
    expect(w.visible.filter(x => x.kind === 'plan')).toHaveLength(1)
    expect(w.visible.filter(x => x.kind === 'launch-gate')).toHaveLength(1)
    expect(w.visible.filter(x => x.kind === 'pending')).toHaveLength(1)
    // 保活的卡片排在最前面,顺序不乱
    expect(w.visible.slice(0, 4).map(x => x.kind)).toEqual(['confirm', 'plan', 'launch-gate', 'pending'])
    expect(w.hiddenCount).toBe(25)   // 只数藏起来的消息,不数被保活的卡片
  })

  it('活跃的 run-card(还在等人处理)保活;已冻结的那种可以收起来', () => {
    const e = [runCard(0, true), runCard(1, false), ...Array.from({ length: 10 }, (_, i) => msg(i))]
    const w = windowTimeline(e, 3)
    const cards = w.visible.filter(x => x.kind === 'run-card') as { event?: unknown }[]
    expect(cards).toHaveLength(1)
    expect(cards[0].event).toBeDefined()
  })

  it('紧挨着首条可见消息的 provider 分割线会跟着一起藏(不会孤零零挂在顶上)', () => {
    const e = [msg(0), msg(1), switchDivider(2), msg(2), msg(3)]
    const w = windowTimeline(e, 2)
    expect(w.visible.some(x => x.kind === 'provider-switch')).toBe(false)
    expect(w.visible).toHaveLength(2)
  })

  it('★进行中的共商区块永远不藏(暂停/结束按钮在里面);已结束的照常收起', () => {
    const council = (id: string, ts: number): TimelineEntry => ({ kind: 'council', id, ts, messages: [] })
    const e = [council('live', 0), council('old', 1), ...Array.from({ length: 30 }, (_, i) => msg(i + 2))]
    const w = windowTimeline(e, 5, new Set(['live']))
    const ids = w.visible.filter(x => x.kind === 'council').map(x => (x as { id: string }).id)
    expect(ids).toEqual(['live'])
    expect(w.visible[0]).toBe(e[0])
    expect(w.hiddenCount).toBe(25)
    // 不传活跃集合 = 老行为
    expect(windowTimeline(e, 5).visible.some(x => x.kind === 'council')).toBe(false)
  })

  it('一条消息都没有时不炸', () => {
    expect(windowTimeline([], 20)).toEqual({ visible: [], hiddenCount: 0, fromIndex: 0 })
    const only = [confirm(0)]
    expect(windowTimeline(only, 20).visible).toEqual(only)
  })

  it('上限 <= 0 或非法时当作不限制(宁可慢,也不能少显示)', () => {
    const e = Array.from({ length: 5 }, (_, i) => msg(i))
    expect(windowTimeline(e, 0).visible).toEqual(e)
    expect(windowTimeline(e, -3).visible).toEqual(e)
    expect(windowTimeline(e, Number.NaN).visible).toEqual(e)
  })

  it('默认窗口与步长是正数', () => {
    expect(LIVE_WINDOW).toBeGreaterThan(0)
    expect(LIVE_WINDOW_STEP).toBeGreaterThan(0)
  })
})
