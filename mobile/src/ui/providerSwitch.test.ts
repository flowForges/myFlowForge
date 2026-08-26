import { describe, it, expect } from 'vitest'
import { providerSwitches } from './providerSwitch'

const ai = (id: string, provider?: string) => ({ id, who: 'ai' as const, provider })
const user = (id: string) => ({ id, who: 'user' as const })

describe('providerSwitches', () => {
  it('前后两条 ai 消息的 provider 不同 → 在后一条前面来一条', () => {
    const m = providerSwitches([ai('a1', 'claude'), ai('a2', 'claude'), ai('b1', 'codex')])
    expect([...m.keys()]).toEqual(['b1'])
    expect(m.get('b1')).toEqual({ from: 'claude', to: 'codex' })
  })

  it('第一条 ai 消息永远不插(前面没有「上一个代理」)', () => {
    expect(providerSwitches([ai('a1', 'claude')]).size).toBe(0)
  })

  it('用户消息夹在中间不影响判定', () => {
    const m = providerSwitches([ai('a1', 'claude'), user('u1'), ai('b1', 'codex')])
    expect([...m.keys()]).toEqual(['b1'])
  })

  it('★没带 provider 的 ai 消息跳过但**不清空**上一个代理(粘滞)—— 否则切代理会丢提示', () => {
    // 这一条正是电脑端「切模型丢分割线」的根因。中间那条 sysnote 没有 provider。
    const m = providerSwitches([ai('c1', 'codex'), ai('sysnote'), ai('sum', 'claude')])
    expect([...m.keys()]).toEqual(['sum'])
    expect(m.get('sum')).toEqual({ from: 'codex', to: 'claude' })
  })

  it('一条 provider 都没有的老会话不会凭空补出提示', () => {
    expect(providerSwitches([ai('a'), ai('b'), ai('c')]).size).toBe(0)
  })

  it('来回切两次就有两条', () => {
    const m = providerSwitches([ai('a', 'claude'), ai('b', 'codex'), ai('c', 'claude')])
    expect([...m.keys()]).toEqual(['b', 'c'])
    expect(m.get('c')).toEqual({ from: 'codex', to: 'claude' })
  })
})
