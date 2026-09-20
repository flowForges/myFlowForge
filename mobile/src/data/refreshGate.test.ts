import { describe, it, expect, vi } from 'vitest'
import { createRefreshGate } from './refreshGate'

/**
 * 一个 promise 现在到底 resolve 了没有 —— 直接 await 会把没兑现的那条挂死,测不出「还没兑现」。
 *
 * ★对照的那一边必须是 **macrotask**(`setTimeout`),不能是 `Promise.resolve()`:
 *  微任务队列里 `Promise.resolve()` 会排在 `p.then()` 前面,于是**已经兑现**的 p 也会被判成
 *  「还没兑现」—— 三条用例一起绿不了,而错的是这个助手,不是被测的东西。
 */
const settled = async (p: Promise<void>): Promise<boolean> => {
  const NOPE = Symbol('nope')
  const later = new Promise<typeof NOPE>((res) => { setTimeout(() => res(NOPE), 0) })
  return (await Promise.race([p.then(() => true as const), later])) !== NOPE
}

describe('刷新闸', () => {
  it('settle 之前不兑现 —— 不然转圈会闪一下就没了,而数据一个字节都没动', async () => {
    const g = createRefreshGate()
    const p = g.wait()
    expect(await settled(p)).toBe(false)
    g.settle()
    expect(await settled(p)).toBe(true)
  })

  it('一趟里排了几个人就一起兑现 —— 连点几下下拉不该留下一颗永远转着的圈', async () => {
    const g = createRefreshGate()
    const ps = [g.wait(), g.wait(), g.wait()]
    expect(g.pending()).toBe(3)
    g.settle()
    expect(g.pending()).toBe(0)
    for (const p of ps) expect(await settled(p)).toBe(true)
  })

  it('没人等着时 settle 什么也不做 —— 后台自己触发的刷新比下拉多得多', () => {
    const g = createRefreshGate()
    expect(() => g.settle()).not.toThrow()
    expect(g.pending()).toBe(0)
  })

  // ★这条钉的是「从一次兑现的回调里再拉一次」这个真会发生的用法(下拉刚回弹,人又拉了一次):
  //  新排的那个必须等**下一趟**,不能被刚才那一趟顺手兑掉。
  //  ★它**分不出** settle 里「先清空再调」和「边遍历边清」两种写法(promise 回调是微任务,
  //   跑在同步循环之后)—— 变异测试确认过。名字因此不承诺那件事。
  it('从兑现回调里再拉一次,排的是下一趟', async () => {
    const g = createRefreshGate()
    let next: Promise<void> | null = null
    void g.wait().then(() => { next = g.wait() })
    g.settle()
    // 让上面那个 .then 跑完
    await Promise.resolve()
    expect(g.pending()).toBe(1)
    expect(await settled(next!)).toBe(false)
    g.settle()
    expect(await settled(next!)).toBe(true)
  })

  it('★settle 两次不会把同一个人兑现两次(promise 本身幂等,但队列必须真的清掉)', () => {
    const g = createRefreshGate()
    const done = vi.fn()
    void g.wait().then(done)
    g.settle()
    g.settle()
    expect(g.pending()).toBe(0)
  })
})
