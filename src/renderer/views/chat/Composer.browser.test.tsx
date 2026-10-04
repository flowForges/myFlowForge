import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import type { ProviderInfo } from '@shared/types'

// ★controller ruling(纠正 brief):ProviderInfo(@shared/types.ts)没有 capabilities 字段 ——
// 渲染端永远看不到主进程那份 capabilities。这里的 provider 对象就是普通 ProviderInfo,不带
// capabilities,门槛是 providerSupportsBrowserUse(agentId)(@shared/browserUse.ts),跟权限
// chip 用 providerSupportsPermissions 的方式完全一致。
const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'gpt-6', label: 'gpt-6' }] },
]

beforeEach(() => { (window as any).forge = { openFiles: vi.fn(async () => []), savePaste: vi.fn() } })

describe('浏览器开关的入口', () => {
  it('claude 会话上能看到浏览器开关', () => {
    render(
      <Composer
        providers={providers} disabled={false} onSend={vi.fn()}
        selection={{ agentId: 'claude', modelId: 'opus-4.8', permissionMode: 'auto', browserUse: 'off' }}
        onSelectionChange={() => {}}
      />,
    )
    expect(screen.getByTitle(/浏览器操作/)).toBeTruthy()
  })

  it('不支持的 provider(codex)上不显示 —— 显示一个点了没用的开关比没有更糟', () => {
    render(
      <Composer
        providers={providers} disabled={false} onSend={vi.fn()}
        selection={{ agentId: 'codex', modelId: 'gpt-6', permissionMode: 'auto', browserUse: 'off' }}
        onSelectionChange={() => {}}
      />,
    )
    expect(screen.queryByTitle(/浏览器操作/)).toBeNull()
  })

  it('「完全访问」+「每次询问」要当场给出冲突提示,说清后果和怎么办', () => {
    render(
      <Composer
        providers={providers} disabled={false} onSend={vi.fn()}
        selection={{ agentId: 'claude', modelId: 'opus-4.8', permissionMode: 'full', browserUse: 'ask' }}
        onSelectionChange={() => {}}
      />,
    )
    expect(screen.getByText(/形同虚设/)).toBeTruthy()
  })

  // ★★设计 §4.3 的原话是「Forge **拒绝**这个组合」。只给提示不拦住的话,chip 上还写着「每次询问」、
  //  回车照样发,而这一轮是 bypassPermissions + --chrome:agent 在用户已登录的浏览器里点任何东西
  //  都不会有一道门。所以这里钉的是**发不出去**,不只是有横幅。
  describe('★冲突组合下发送被拒绝(不只是提示)', () => {
    const conflicting = { agentId: 'claude', modelId: 'opus-4.8', permissionMode: 'full' as const, browserUse: 'ask' as const }

    it('回车发不出去,发送按钮也是禁用的 —— 但横幅还在,解释为什么', () => {
      const onSend = vi.fn()
      const { container } = render(
        <Composer providers={providers} disabled={false} onSend={onSend} selection={conflicting} onSelectionChange={() => {}} />,
      )
      const ta = screen.getByPlaceholderText(/给主代理下达任务/)
      fireEvent.change(ta, { target: { value: '去打开后台改个配置' } })
      fireEvent.keyDown(ta, { key: 'Enter' })
      expect(onSend).not.toHaveBeenCalled()
      const btn = container.querySelector('#sendBtn') as HTMLButtonElement
      expect(btn.disabled).toBe(true)
      fireEvent.click(btn)
      expect(onSend).not.toHaveBeenCalled()
      expect(screen.getByText(/形同虚设/)).toBeTruthy()
      // 输入框**不**禁用:挡的是发送,草稿不该因为改了个开关就打不了字。
      expect((ta as HTMLTextAreaElement).disabled).toBe(false)
    })

    it('权限档降到「自动」就立刻解锁(用户自己改,Forge 不替他改)', () => {
      const onSend = vi.fn()
      const { container, rerender } = render(
        <Composer providers={providers} disabled={false} onSend={onSend} selection={conflicting} onSelectionChange={() => {}} />,
      )
      const ta = screen.getByPlaceholderText(/给主代理下达任务/)
      fireEvent.change(ta, { target: { value: '去打开后台改个配置' } })
      rerender(
        <Composer providers={providers} disabled={false} onSend={onSend}
          selection={{ ...conflicting, permissionMode: 'auto' }} onSelectionChange={() => {}} />,
      )
      expect((container.querySelector('#sendBtn') as HTMLButtonElement).disabled).toBe(false)
      expect(screen.queryByText(/形同虚设/)).toBeNull()
      fireEvent.keyDown(screen.getByPlaceholderText(/给主代理下达任务/), { key: 'Enter' })
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onSend.mock.calls[0][0]).toMatchObject({ permissionMode: 'auto', browserUse: 'ask' })
    })

    it('改浏览器档(放行)也立刻解锁 —— 两个设置改哪个都能出来', () => {
      const onSend = vi.fn()
      const { container, rerender } = render(
        <Composer providers={providers} disabled={false} onSend={onSend} selection={conflicting} onSelectionChange={() => {}} />,
      )
      fireEvent.change(screen.getByPlaceholderText(/给主代理下达任务/), { target: { value: '去打开后台改个配置' } })
      rerender(
        <Composer providers={providers} disabled={false} onSend={onSend}
          selection={{ ...conflicting, browserUse: 'allow' }} onSelectionChange={() => {}} />,
      )
      expect((container.querySelector('#sendBtn') as HTMLButtonElement).disabled).toBe(false)
      fireEvent.keyDown(screen.getByPlaceholderText(/给主代理下达任务/), { key: 'Enter' })
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onSend.mock.calls[0][0]).toMatchObject({ permissionMode: 'full', browserUse: 'allow' })
    })

    it('冲突时浏览器 chip 和权限 chip 都还能点 —— 否则用户被锁死在这个组合里', () => {
      const { container } = render(
        <Composer providers={providers} disabled={false} onSend={vi.fn()} selection={conflicting} onSelectionChange={() => {}} />,
      )
      expect((container.querySelector('[data-menu="browserMenu"]') as HTMLButtonElement).disabled).toBe(false)
      expect((container.querySelector('[data-menu="permMenu"]') as HTMLButtonElement | null)?.disabled ?? false).toBe(false)
    })
  })

  it('不冲突的组合没有提示', () => {
    render(
      <Composer
        providers={providers} disabled={false} onSend={vi.fn()}
        selection={{ agentId: 'claude', modelId: 'opus-4.8', permissionMode: 'auto', browserUse: 'ask' }}
        onSelectionChange={() => {}}
      />,
    )
    expect(screen.queryByText(/形同虚设/)).toBeNull()
  })

  it('选一档会把新值报上去', () => {
    const onSelectionChange = vi.fn()
    const { container } = render(
      <Composer
        providers={providers} disabled={false} onSend={vi.fn()}
        selection={{ agentId: 'claude', modelId: 'opus-4.8', permissionMode: 'auto', browserUse: 'off' }}
        onSelectionChange={onSelectionChange}
      />,
    )
    fireEvent.click(container.querySelector('[data-menu="browserMenu"]') as HTMLElement)
    fireEvent.click(container.querySelector('[data-browser="ask"]') as HTMLElement)
    expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ browserUse: 'ask' }))
  })

  it('默认(off)不选浏览器,onSend 的载荷里也带着 browserUse', () => {
    const onSend = vi.fn()
    render(
      <Composer
        providers={providers} disabled={false} onSend={onSend}
        selection={{ agentId: 'claude', modelId: 'opus-4.8', permissionMode: 'auto', browserUse: 'off' }}
        onSelectionChange={() => {}}
      />,
    )
    const ta = screen.getByPlaceholderText(/给主代理下达任务/)
    fireEvent.change(ta, { target: { value: '测试一下' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toMatchObject({ browserUse: 'off' })
  })
})
