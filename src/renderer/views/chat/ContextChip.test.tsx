import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContextChip, fmtTokens } from './ContextChip'

/**
 * 用户 2026-09-14 原话:「上下文要真实,从官方自己的能力里取的,不能是你自己计算的,那个不准确」。
 *
 * ★★所以这组用例真正钉的是一件事:**没有官方窗口时,绝不显示百分比**。
 *  以前窗口是按模型名硬猜的(带 "1m" 算 1M,否则一律 200K),那个百分比看着很像回事却没人核对过。
 */
describe('ContextChip', () => {
  const props = { canCompact: true, onCompact: vi.fn() }

  it('一个 token 都没拿到 → 整枚不出现(不占地方,也不显示 0)', () => {
    const { container } = render(<ContextChip {...props} />)
    expect(container.querySelector('.ctx-chip')).toBeNull()
    const { container: c2 } = render(<ContextChip {...props} usage={{ used: 0 }} />)
    expect(c2.querySelector('.ctx-chip')).toBeNull()
  })

  it('★★没有官方窗口 → 只显示 token 数,不画占比条、不写百分比', () => {
    const { container } = render(<ContextChip {...props} usage={{ used: 45200 }} />)
    expect(screen.getByText('45.2K')).toBeInTheDocument()
    expect(container.querySelector('.ctx-chip-pct')).toBeNull()
    expect(container.querySelector('.ctx-chip-bar')).toBeNull()
    expect(container.textContent).not.toContain('%')
  })

  it('有官方窗口 → 显示 已用 / 窗口 · 占比,并画条', () => {
    const { container } = render(<ContextChip {...props} usage={{ used: 45200, window: 272000 }} />)
    expect(screen.getByText('45.2K')).toBeInTheDocument()
    expect(screen.getByText('272.0K')).toBeInTheDocument()
    expect(screen.getByText('17%')).toBeInTheDocument()
    expect(container.querySelector('.ctx-chip-bar i')).toHaveStyle({ width: '17%' })
  })

  it('快满了给个视觉提醒(≥80%)', () => {
    const { container } = render(<ContextChip {...props} usage={{ used: 90000, window: 100000 }} />)
    expect(container.querySelector('.ctx-chip')?.className).toContain('hot')
  })

  it('点开 tips:说清数是谁报的;窗口未知时**明说**,不留白让人以为是 bug', () => {
    render(<ContextChip {...props} usage={{ used: 1234 }} providerLabel="Claude Code" />)
    fireEvent.click(screen.getByRole('button', { name: /上下文/ }))
    expect(screen.getByText('未知')).toBeInTheDocument()
    expect(screen.getByRole('dialog').textContent).toContain('Claude Code')
    expect(screen.getByRole('dialog').textContent).toContain('不猜')
  })

  it('tips 里点「压缩上下文」会真的调 onCompact,并收起浮层', () => {
    const onCompact = vi.fn()
    render(<ContextChip canCompact onCompact={onCompact} usage={{ used: 1234, window: 200000 }} />)
    fireEvent.click(screen.getByRole('button', { name: /上下文/ }))
    fireEvent.click(screen.getByText('压缩上下文'))
    expect(onCompact).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('★不支持压缩的 provider:按钮置灰,并且**说清为什么** —— 别让人对着灰按钮猜', () => {
    render(<ContextChip canCompact={false} compactHint="cursor 不支持由 Forge 触发的上下文压缩" onCompact={vi.fn()} usage={{ used: 999 }} />)
    fireEvent.click(screen.getByRole('button', { name: /上下文/ }))
    expect((screen.getByText('压缩上下文') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/cursor 不支持/)).toBeInTheDocument()
  })

  it('压缩中:按钮变文案并禁用(别让人连点两次)', () => {
    render(<ContextChip canCompact compacting onCompact={vi.fn()} usage={{ used: 999 }} />)
    fireEvent.click(screen.getByRole('button', { name: /上下文/ }))
    expect((screen.getByText('压缩中…') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('fmtTokens', () => {
  it('三档:原样 / K / M', () => {
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(45200)).toBe('45.2K')
    expect(fmtTokens(272000)).toBe('272.0K')
    expect(fmtTokens(1_234_567)).toBe('1.23M')
  })
})
