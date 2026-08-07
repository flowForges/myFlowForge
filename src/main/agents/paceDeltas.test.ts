import { describe, it, expect, vi } from 'vitest'
import { paceAssistantDeltas, planSlices, sliceAt, PACE, type PaceTimers } from './paceDeltas'
import type { ChatCallbacks } from './types'

// 手动时钟:测试不该依赖真实时间,也不该 sleep。
function fakeTimers() {
  let seq = 0
  const pending = new Map<number, () => void>()
  const timers: PaceTimers = {
    setTimeout: (fn) => { const h = ++seq; pending.set(h, fn); return h },
    clearTimeout: (h) => { pending.delete(h as number) },
  }
  // 把当前排着的回调全跑一遍(跑的过程中新排的留到下一轮),返回是否还有活。
  const step = () => {
    const now = [...pending.entries()]
    pending.clear()
    for (const [, fn] of now) fn()
    return pending.size > 0
  }
  const runAll = () => { let n = 0; while (step() && n++ < 200) { /* drain */ } }
  return { timers, step, runAll, get size() { return pending.size } }
}

function spyCb(): ChatCallbacks & { deltas: string[]; done: number; errors: number; replaced: string[] } {
  const deltas: string[] = []
  const replaced: string[] = []
  const cb = {
    deltas, replaced, done: 0, errors: 0,
    onSession: () => {},
    onAssistantDelta: (t: string) => { deltas.push(t) },
    onAssistantReplace: (t: string) => { replaced.push(t) },
    onThinkDelta: () => {},
    onDone: () => { cb.done++ },
    onError: () => { cb.errors++ },
  }
  return cb as ChatCallbacks & { deltas: string[]; done: number; errors: number; replaced: string[] }
}

describe('sliceAt', () => {
  it('整段短于上限时一次给完', () => {
    expect(sliceAt('abc', 2, 10)).toBe(3)
  })
  it('优先切在换行处', () => {
    const t = 'aaaa\nbbbb cccc'
    expect(t.slice(0, sliceAt(t, 3, 10))).toBe('aaaa\n')
  })
  it('没有换行时切在句末标点后', () => {
    const t = '这是一句话。后面还有很多字'
    expect(t.slice(0, sliceAt(t, 4, 9))).toBe('这是一句话。')
  })
  it('都没有时切在空格处', () => {
    const t = 'aaaa bbbbbbbb'
    expect(t.slice(0, sliceAt(t, 2, 8))).toBe('aaaa ')
  })
  it('连空格都没有(长 CJK 串)时硬切,不会卡住', () => {
    const t = '一'.repeat(50)
    expect(sliceAt(t, 5, 10)).toBe(10)
  })
})

describe('planSlices', () => {
  it('切完之后拼回去与原文逐字相同(绝不能吞字或重复)', () => {
    const t = '第一句。第二句！第三句?\n第四段的内容 with some english words. 结尾'
    for (const n of [1, 2, 3, 7, 50]) {
      expect(planSlices(t, n).join('')).toBe(t)
    }
  })
  it('片数不超过给定帧数(总时长才封得住)', () => {
    const t = '字'.repeat(20_000)
    expect(planSlices(t, 5).length).toBeLessThanOrEqual(5)
    expect(planSlices(t, PACE.MAX_TICKS).length).toBeLessThanOrEqual(PACE.MAX_TICKS)
  })
  it('空串给空数组', () => {
    expect(planSlices('', 10)).toEqual([])
  })
  it('每片都非空(空片会白白浪费一帧)', () => {
    expect(planSlices('短', 10).every(s => s.length > 0)).toBe(true)
  })
})

describe('paceAssistantDeltas', () => {
  it('★小分片零延迟直放 —— 真流式的 provider 不该被拖慢', () => {
    const inner = spyCb()
    const { timers, size } = fakeTimers()
    const p = paceAssistantDeltas(inner, timers)
    p.onAssistantDelta('你好')
    p.onAssistantDelta('世界')
    expect(inner.deltas).toEqual(['你好', '世界'])   // 没排队,当场就到了
    expect(size).toBe(0)
  })

  it('★一整坨会被摊成多片,且拼回去与原文逐字相同', () => {
    const inner = spyCb()
    const { timers, runAll } = fakeTimers()
    const p = paceAssistantDeltas(inner, timers)
    const blob = '这是一大段回复。'.repeat(200)
    p.onAssistantDelta(blob)
    expect(inner.deltas).toEqual([])            // 立刻一片都不给
    runAll()
    expect(inner.deltas.length).toBeGreaterThan(1)
    expect(inner.deltas.join('')).toBe(blob)    // 不吞字、不重复
  })

  it('★片数封顶 —— 再大的回复也不会念上几分钟', () => {
    const inner = spyCb()
    const { timers, runAll } = fakeTimers()
    const p = paceAssistantDeltas(inner, timers)
    p.onAssistantDelta('字'.repeat(500_000))
    runAll()
    expect(inner.deltas.length).toBeLessThanOrEqual(PACE.MAX_TICKS)
  })

  it('★onDone 被扣到放完为止(否则「完成」会跑到正文前面)', () => {
    const inner = spyCb()
    const { timers, step, runAll } = fakeTimers()
    const p = paceAssistantDeltas(inner, timers)
    p.onAssistantDelta('长回复。'.repeat(200))
    p.onDone({ elapsed: 1 })
    step()
    expect(inner.done).toBe(0)                  // 还在放,先别宣布完成
    runAll()
    expect(inner.done).toBe(1)
    expect(inner.deltas.join('')).toBe('长回复。'.repeat(200))
  })

  it('没有积压时 onDone 立即转发,不平白等一帧', () => {
    const inner = spyCb()
    const { timers } = fakeTimers()
    const p = paceAssistantDeltas(inner, timers)
    p.onDone({ elapsed: 1 })
    expect(inner.done).toBe(1)
  })

  it('★中断/出错:剩下的立刻全放,不让用户等一个已经喊停的东西', () => {
    const inner = spyCb()
    const { timers, size } = fakeTimers()
    const p = paceAssistantDeltas(inner, timers)
    const blob = '内容。'.repeat(300)
    p.onAssistantDelta(blob)
    p.onError(new Error('用户中断'))
    expect(inner.deltas.join('')).toBe(blob)    // 一个字不少
    expect(inner.errors).toBe(1)
    expect(size).toBe(0)                        // 定时器也停了
  })

  it('中断之后不再把扣下的 onDone 放出来(一轮只能结算一次)', () => {
    const inner = spyCb()
    const { timers, runAll } = fakeTimers()
    const p = paceAssistantDeltas(inner, timers)
    p.onAssistantDelta('内容。'.repeat(300))
    p.onDone({ elapsed: 1 })
    p.onError(new Error('中断'))
    runAll()
    expect(inner.errors).toBe(1)
    expect(inner.done).toBe(0)
  })

  it('★flushPaced(按了「停止」):剩下的立刻倒完,并放行扣着的 onDone', () => {
    const inner = spyCb()
    const { timers, step, size } = fakeTimers()
    const p = paceAssistantDeltas(inner, timers)
    const blob = '正在放的内容。'.repeat(300)
    p.onAssistantDelta(blob)
    step()                                  // 放出第一片
    p.onDone({ elapsed: 1 })                // 上游已完成,但还在放 → 被扣下
    expect(inner.done).toBe(0)
    p.flushPaced()
    expect(inner.deltas.join('')).toBe(blob)  // 一个字不少
    expect(inner.done).toBe(1)                // 扣着的 onDone 放行了
    expect(size).toBe(0)                      // 定时器停了,不会再滴
  })

  it('flushPaced 在没有积压时是安全的空操作(不会凭空多结算一次)', () => {
    const inner = spyCb()
    const p = paceAssistantDeltas(inner, fakeTimers().timers)
    p.flushPaced()
    p.flushPaced()
    expect(inner.deltas).toEqual([])
    expect(inner.done).toBe(0)
  })

  it('★覆盖式重写是权威值:丢掉队列,不让排队的旧内容再追加上去', () => {
    const inner = spyCb()
    const { timers, runAll } = fakeTimers()
    const p = paceAssistantDeltas(inner, timers)
    p.onAssistantDelta('半截的旧内容。'.repeat(100))
    p.onAssistantReplace!('这才是完整的正文')
    runAll()
    expect(inner.replaced).toEqual(['这才是完整的正文'])
    expect(inner.deltas.join('')).toBe('')      // 队列里那半截没有漏出去
  })

  it('放的过程中又来了新内容,会并进同一条队列,顺序不乱', () => {
    const inner = spyCb()
    const { timers, step, runAll } = fakeTimers()
    const p = paceAssistantDeltas(inner, timers)
    p.onAssistantDelta('AAA。'.repeat(100))
    step()
    p.onAssistantDelta('BBB。'.repeat(100))
    runAll()
    expect(inner.deltas.join('')).toBe('AAA。'.repeat(100) + 'BBB。'.repeat(100))
  })

  it('其余回调原样透传(只动 assistant 这一路)', () => {
    const inner = spyCb()
    const think = vi.fn()
    const p = paceAssistantDeltas({ ...inner, onThinkDelta: think }, fakeTimers().timers)
    p.onThinkDelta('思考中'.repeat(100))
    expect(think).toHaveBeenCalledWith('思考中'.repeat(100))
  })

  it('空分片被忽略,不会白排一帧', () => {
    const inner = spyCb()
    const { timers, size } = fakeTimers()
    const p = paceAssistantDeltas(inner, timers)
    p.onAssistantDelta('')
    expect(inner.deltas).toEqual([])
    expect(size).toBe(0)
  })
})
