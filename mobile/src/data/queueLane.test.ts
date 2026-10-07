import { describe, it, expect } from 'vitest'
import { queuedFor, queuedSourceLabel } from './queueLane'

const evt = {
  workspacePath: '/ws',
  queue: [
    { id: 'q-1', text: '先跑测试', source: '手机', sessionId: 'A' },
    { id: 'q-2', text: 'B 的话', source: '你', sessionId: 'B' },
    { id: 'q-3', text: '再提交', source: '你', sessionId: 'A' },
  ],
}

describe('queuedFor —— 这个会话排着的', () => {
  it('★只要本会话的,顺序不变', () => {
    expect(queuedFor(evt, 'A')).toEqual([
      { id: 'q-1', text: '先跑测试', source: '手机' },
      { id: 'q-3', text: '再提交', source: '你' },
    ])
  })
  it('★别的会话排的不混进来', () => {
    expect(queuedFor(evt, 'B').map((q) => q.id)).toEqual(['q-2'])
  })
  it('没选会话 / 老主机没有 queue / 演示连接:空', () => {
    expect(queuedFor(evt, null)).toEqual([])
    expect(queuedFor({ runningSessionIds: [] }, 'A')).toEqual([])
    expect(queuedFor({ queued: 0 }, 'A')).toEqual([])
    expect(queuedFor(null, 'A')).toEqual([])
  })
})

describe('queuedSourceLabel', () => {
  it('手机自己发的不标;电脑上敲的标「来自电脑」;机器人照名字标', () => {
    expect(queuedSourceLabel('手机')).toBeNull()
    expect(queuedSourceLabel('你')).toBe('来自电脑')
    expect(queuedSourceLabel('飞书')).toBe('来自飞书')
    expect(queuedSourceLabel('')).toBeNull()
  })
})
