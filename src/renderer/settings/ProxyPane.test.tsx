import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProxyPane } from './ProxyPane'

/**
 * 用户 2026-09-11 原话:「app 里的 设置的 终端代理 里 有两套一模一样的 设置代理和检查出口,很让人懵逼啊」。
 *
 * 根因不是「做了两套」—— 拆成 agent 出口 / app 自身两条是对的(Q4)。根因是复用 TermProxyPane 时
 * 它**自带一个写死的 `<h4>终端代理</h4>` + 同一句说明**,于是两段在屏幕上长得完全一样,
 * 只有上方那行小标题不同,看起来就像重复摆了两套。
 */
describe('ProxyPane', () => {
  beforeEach(() => {
    ;(window as any).forge = { checkExitIp: vi.fn(async () => ({ ip: '1.2.3.4', region: '', via: 'direct' as const })) }
  })

  it('★两段各有自己的标题 —— 屏幕上不再出现任何一块叫「终端代理」的重复面板', () => {
    render(<ProxyPane agentProxy="" appProxy="" onChange={vi.fn()} />)
    // 写死的那个标题必须没了(左侧导航那一项还叫终端代理,但那不在本组件里)。
    expect(screen.queryAllByText('终端代理')).toHaveLength(0)
    expect(screen.getByText('编码代理的出口 · 跟机器走')).toBeInTheDocument()
    expect(screen.getByText('应用自身的网络 · 跟这台设备走')).toBeInTheDocument()
    // 两段各一个标题,不多不少 —— 原先是 2 个小标题 + 2 个「终端代理」共 4 个。
    expect(document.querySelectorAll('.set-group h4')).toHaveLength(2)
  })

  it('★★两个「检测出口 IP」各测各的代理 —— 原先两个都在测 agentProxy(第二个在说谎)', () => {
    render(<ProxyPane agentProxy="http://127.0.0.1:7897" appProxy="" onChange={vi.fn()} />)
    const btns = screen.getAllByText('检测出口 IP')
    expect(btns).toHaveLength(2)
    fireEvent.click(btns[0])
    expect((window as any).forge.checkExitIp).toHaveBeenLastCalledWith('agent')
    fireEvent.click(btns[1])
    expect((window as any).forge.checkExitIp).toHaveBeenLastCalledWith('app')
  })

  it('两段的输入框不能共用同一个 DOM id —— 否则点第二段的 label 会聚焦到第一段的框', () => {
    render(<ProxyPane agentProxy="" appProxy="" onChange={vi.fn()} />)
    const ids = [...document.querySelectorAll('input[type="text"]')].map(el => el.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('改哪一段就只回报哪一段', () => {
    const onChange = vi.fn()
    render(<ProxyPane agentProxy="" appProxy="" onChange={onChange} />)
    const inputs = document.querySelectorAll('input[type="text"]')
    fireEvent.change(inputs[1], { target: { value: 'http://127.0.0.1:1080' } })
    fireEvent.blur(inputs[1])
    expect(onChange).toHaveBeenCalledWith({ appProxy: 'http://127.0.0.1:1080' })
  })
})
