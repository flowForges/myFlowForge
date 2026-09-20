import { describe, it, expect } from 'vitest'
import { hostRowNote, hostRowTitle, type HostConnState } from './hostView'

const retrying = (over: Partial<Extract<HostConnState, { status: 'retrying' }>> = {}): HostConnState =>
  ({ status: 'retrying', attempt: 3, error: '对面掉线了', nextInMs: 8000, ...over })

describe('hostRowNote:弹层里那行的小标签', () => {
  it('★★重连中要跳秒 —— 静态一句「8 秒后重连」回答不了「有没有在重连」', () => {
    expect(hostRowNote(retrying(), 6000)).toBe('重连中 · 6s')
    expect(hostRowNote(retrying(), 5000)).toBe('重连中 · 5s')
  })

  it('★向上取整:剩 1ms 也显示 1s,不显示 0s(那看着像卡住了)', () => {
    expect(hostRowNote(retrying(), 1)).toBe('重连中 · 1s')
    expect(hostRowNote(retrying(), 0)).toBe('重连中 · 0s')
    expect(hostRowNote(retrying(), -500)).toBe('重连中 · 0s')
  })

  it('拿不到剩余时间时至少说「重连中」,不退回「已断开」', () => {
    expect(hostRowNote(retrying())).toBe('重连中')
  })

  it('非 retrying 沿用原来的简写,行为不变', () => {
    expect(hostRowNote({ status: 'ready', version: 'v1', methods: [] }, 3000)).toBe('')
    expect(hostRowNote({ status: 'connecting', attempt: 1 })).toBe('连接中')
    expect(hostRowNote({ status: 'failed', error: 'x' })).toBe('连接失败')
    expect(hostRowNote({ status: 'closed' })).toBe('未连接')
  })
})

describe('hostRowTitle:悬停看完整', () => {
  it('★★必须带断开原因 —— 那是「为啥断了」唯一的答案', () => {
    expect(hostRowTitle(retrying())).toBe('已断开,第 3 次重连 — 对面掉线了')
  })
  it('第几次也要带上(看得出试了很久)', () => {
    expect(hostRowTitle(retrying({ attempt: 12, error: 'token 不对,被对方拒绝' })))
      .toBe('已断开,第 12 次重连 — token 不对,被对方拒绝')
  })
  it('其余状态沿用完整描述', () => {
    expect(hostRowTitle({ status: 'ready', version: 'v1.2.0', methods: [] })).toBe('已连接 · v1.2.0')
  })
})
