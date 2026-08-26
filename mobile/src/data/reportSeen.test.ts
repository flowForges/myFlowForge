import { describe, it, expect } from 'vitest'
import { shouldReportSeen } from './reportSeen'

const CH_MARK_SEEN = 'chat:mark-seen'
const NEW_HOST = new Set([CH_MARK_SEEN, 'chat:send'])
const OLD_HOST = new Set(['chat:send'])

describe('shouldReportSeen —— 跨设备未读的上报闸门', () => {
  it('★都齐了就上报(新主机 + 真在看一条会话)', () => {
    expect(shouldReportSeen({ wsPath: '/ws', sessionId: 's1' }, NEW_HOST, CH_MARK_SEEN)).toBe(true)
  })

  it('没在看任何会话(viewing 为 null)→ 不上报', () => {
    expect(shouldReportSeen(null, NEW_HOST, CH_MARK_SEEN)).toBe(false)
  })

  it('★工作区是空串 → 不上报(切主机那一瞬 viewing 就是两个空串)', () => {
    expect(shouldReportSeen({ wsPath: '', sessionId: 's1' }, NEW_HOST, CH_MARK_SEEN)).toBe(false)
  })

  it('★会话是空串 → 不上报(同上,一条空的「已读」发给所有人是纯噪音)', () => {
    expect(shouldReportSeen({ wsPath: '/ws', sessionId: '' }, NEW_HOST, CH_MARK_SEEN)).toBe(false)
  })

  it('★★主机没广告这条 channel(老 daemon)→ 不上报(决策 B-2:对不上的能力跳过)', () => {
    // 不查方法表的话,每打开一条会话就多一个被拒的 promise —— 一条会一直刷屏的假错误。
    expect(shouldReportSeen({ wsPath: '/ws', sessionId: 's1' }, OLD_HOST, CH_MARK_SEEN)).toBe(false)
  })

  it('还没连上(methods 是空集,useConn 只在 ready 时才给方法表)→ 不上报', () => {
    expect(shouldReportSeen({ wsPath: '/ws', sessionId: 's1' }, new Set<string>(), CH_MARK_SEEN)).toBe(false)
  })
})
