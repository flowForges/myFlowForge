import { describe, it, expect } from 'vitest'
import { makeTapGate } from './tapOnce'

// 2026-10-06 用户在 iOS 上撞到:点一条「执行完成」的通知进来,界面开始反复跳转十几次,
// 「正在读这个会话」永远读不完。成因是两个缺陷咬成一个闭环:
//   ① PushProvider 那个 effect 依赖整个 store,而它的回调又去改 store(select)→ 重新订阅;
//   ② 每次订阅都会 getLastNotificationResponseAsync() 把**同一条**通知再播一遍 —— 没有去重。
// 这个文件钉住的是 ②:同一条通知,无论被重播多少次,只许处理一次。
describe('makeTapGate —— 同一条通知只处理一次', () => {
  it('第一次见到的通知:放行', () => {
    const gate = makeTapGate()
    expect(gate('n1')).toBe(true)
  })

  it('★同一个 id 再来:挡住 —— 这正是无限跳转的那一环', () => {
    const gate = makeTapGate()
    expect(gate('n1')).toBe(true)
    expect(gate('n1')).toBe(false)
    expect(gate('n1')).toBe(false)
  })

  it('换一条新通知:放行,并且旧的那条仍然挡着', () => {
    const gate = makeTapGate()
    gate('n1')
    expect(gate('n2')).toBe(true)
    expect(gate('n1')).toBe(false)
    expect(gate('n2')).toBe(false)
  })

  it('★同一条通知被用户先后点两次(真的点了两次)也只算一次 —— 宁可少跳一次,也不要跳十几次', () => {
    const gate = makeTapGate()
    expect(gate('n1')).toBe(true)
    expect(gate('n1')).toBe(false)
  })

  it('拿不到 id 时放行,但不记账 —— 认不出就别挡,「点了没反应」比多跳一次糟得多', () => {
    const gate = makeTapGate()
    expect(gate(undefined)).toBe(true)
    expect(gate(undefined)).toBe(true)
    expect(gate('')).toBe(true)
  })

  it('两个独立的 gate 互不干扰(每次建一个新的就该是干净的)', () => {
    const a = makeTapGate()
    const b = makeTapGate()
    a('n1')
    expect(b('n1')).toBe(true)
  })

  it('记住的 id 数量有上限,不会随通知越积越多', () => {
    const gate = makeTapGate(3)
    for (const id of ['n1', 'n2', 'n3', 'n4']) gate(id)
    // n1 已经被挤出去了 —— 代价是一条很久以前的通知可能被重放一次,
    // 换来的是这张表不会无限长。而循环靠的是**紧接着**的重播,这个窗口足够。
    expect(gate('n1')).toBe(true)
    expect(gate('n4')).toBe(false)
  })
})
