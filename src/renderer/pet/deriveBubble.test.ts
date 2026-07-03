import { describe, it, expect } from 'vitest'
import { deriveBubble } from './deriveBubble'

const a = (stage: string, name: string) => ({ name, role: '', stage })

describe('deriveBubble', () => {
  it('无执行代理返回 null', () => {
    expect(deriveBubble([], 'r1')).toBeNull()
  })
  it('单代理:显示阶段 · 代理名', () => {
    const b = deriveBubble([a('技术方案设计', 'Codex')], 'r1')!
    expect(b.stage).toBe('正在执行:技术方案设计 · Codex')
    expect(b.greet.length).toBeGreaterThan(0)
  })
  it('多代理:聚合个数', () => {
    const b = deriveBubble([a('实现', 'A'), a('实现', 'B')], 'r1')!
    expect(b.stage).toBe('实现 · 2 个代理')
  })
  it('选句对同一 seed 稳定', () => {
    expect(deriveBubble([a('s', 'n')], 'seedX')!.greet).toBe(deriveBubble([a('s', 'n')], 'seedX')!.greet)
  })
})
