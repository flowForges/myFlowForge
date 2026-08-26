import { describe, it, expect } from 'vitest'
import { describeHostState } from './hostStatusText'

describe('describeHostState', () => {
  it('★没连上的三种状态语气必须是 off/idle —— 拿缓存假装在线是本轮最贵的一类 bug', () => {
    expect(describeHostState(null).tone).toBe('idle')
    expect(describeHostState({ status: 'closed' }).tone).toBe('idle')
    expect(describeHostState({ status: 'failed', error: '令牌不对' }).tone).toBe('off')
    expect(describeHostState({ status: 'retrying', attempt: 2, error: '连不上', nextInMs: 3000 }).tone).toBe('off')
    // 只有 ready 才是 ok。connecting 是「还不知道」,不是「行了」。
    expect(describeHostState({ status: 'connecting', attempt: 1 }).tone).toBe('wait')
    expect(describeHostState({ status: 'ready', version: '1.2.0', methods: new Set() }).tone).toBe('ok')
  })

  it('★断线那句里必须带着原因 —— 那一行是断线时屏幕上唯一说明「为什么」的地方', () => {
    expect(describeHostState({ status: 'failed', error: '令牌不对' }).text).toContain('令牌不对')
    const r = describeHostState({ status: 'retrying', attempt: 2, error: '连不上', nextInMs: 3400 })
    expect(r.text).toContain('连不上')
    // 毫秒要四舍五入成秒:3400ms 是「3 秒后」,不是「3.4 秒后」也不是一串毫秒数。
    expect(r.text).toContain('3 秒后')
  })

  it('第一次连接不报次数,重试才报 —— 冷启动那一下报「第 1 次」像是已经失败过一回了', () => {
    expect(describeHostState({ status: 'connecting', attempt: 1 }).text).toBe('连接中…')
    expect(describeHostState({ status: 'connecting', attempt: 3 }).text).toContain('第 3 次')
  })

  it('连上了报对面的版本 —— 版本对不上是「功能突然置灰」最常见的原因', () => {
    expect(describeHostState({ status: 'ready', version: '1.2.0', methods: new Set() }).text).toContain('1.2.0')
  })
})
