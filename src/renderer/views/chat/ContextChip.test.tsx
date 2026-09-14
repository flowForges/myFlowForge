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
  const props = {}

  it('一个 token 都没拿到 → 整枚不出现(不占地方,也不显示 0)', () => {
    const { container } = render(<ContextChip {...props} />)
    expect(container.querySelector('.ctx-ring-btn')).toBeNull()
    const { container: c2 } = render(<ContextChip {...props} usage={{ used: 0 }} />)
    expect(c2.querySelector('.ctx-ring-btn')).toBeNull()
  })

  it('★★没有官方窗口 → 画**虚线**环,不画填充 —— 满环/空环都是在假装知道', () => {
    const { container } = render(<ContextChip {...props} usage={{ used: 45200 }} />)
    expect(container.querySelector('.ctx-ring-unknown')).not.toBeNull()
    expect(container.querySelector('.ctx-ring-fill')).toBeNull()
    // 数字不摊在输入框上(用户:第一版「太丑了」),只在 title 里备查。
    expect(container.textContent).toBe('')
    expect(container.querySelector('.ctx-ring-btn')?.getAttribute('title')).toContain('未上报窗口')
  })

  it('有官方窗口 → 实心进度环,弧长按占比走', () => {
    const { container } = render(<ContextChip {...props} usage={{ used: 45200, window: 272000 }} />)
    const fill = container.querySelector('.ctx-ring-fill') as SVGCircleElement
    expect(fill).not.toBeNull()
    // r=9 → 周长 ≈ 56.55;17% 已用 ⇒ 还剩 83% 的偏移。
    const C = 2 * Math.PI * 9
    expect(Number(fill.getAttribute('stroke-dashoffset'))).toBeCloseTo(C * (1 - 0.17), 1)
    expect(container.querySelector('.ctx-ring-btn')?.getAttribute('title')).toContain('17%')
  })

  it('★「满了就是红的」:70% 转黄、90% 转红', () => {
    const cls = (used: number) =>
      (render(<ContextChip {...props} usage={{ used, window: 100 }} />).container
        .querySelector('.ctx-ring-btn') as HTMLElement).className
    expect(cls(50)).not.toMatch(/warn|crit/)
    expect(cls(75)).toContain('warn')
    expect(cls(95)).toContain('crit')
  })

  it('★★★「已用 > 窗口」是不可能的数 —— 退回未知档,不画满环也不写 100%', () => {
    // 用户 2026-09-14 截图:已用 794,430 / 窗口 200,000,界面照样画成 100%。
    // 公式的 bug 是一回事;界面替一个显然不可能的数圆场,是更该修的那回事。
    const { container } = render(<ContextChip {...props} usage={{ used: 794430, window: 200000 }} />)
    expect(container.querySelector('.ctx-ring-fill')).toBeNull()
    expect(container.querySelector('.ctx-ring-unknown')).not.toBeNull()
    expect(container.querySelector('.ctx-ring-btn')?.getAttribute('title')).not.toContain('%')
  })

  it('对不上的时候 tips 要说清楚,而不是默默不显示占比', () => {
    render(<ContextChip {...props} usage={{ used: 794430, window: 200000 }} />)
    fireEvent.click(screen.getByRole('button', { name: /上下文/ }))
    expect(screen.getByRole('dialog').textContent).toContain('对不上')
  })

  it('刚好等于窗口仍算可信(100% 是合法的)', () => {
    const { container } = render(<ContextChip {...props} usage={{ used: 200000, window: 200000 }} />)
    expect(container.querySelector('.ctx-ring-fill')).not.toBeNull()
    expect(container.querySelector('.ctx-ring-btn')?.getAttribute('title')).toContain('100%')
  })

  it('点开 tips:说清数是谁报的;窗口未知时**明说**,不留白让人以为是 bug', () => {
    render(<ContextChip {...props} usage={{ used: 1234 }} providerLabel="Claude Code" />)
    fireEvent.click(screen.getByRole('button', { name: /上下文/ }))
    expect(screen.getByText('未知')).toBeInTheDocument()
    expect(screen.getByRole('dialog').textContent).toContain('Claude Code')
    expect(screen.getByRole('dialog').textContent).toContain('不猜')
  })

  it('★★不再提供「压缩上下文」按钮,只说一句由 CLI 自动压缩', () => {
    // 2026-09-14 撤掉:协议路径在实验室跑得通、到用户机器上就是不成。一个**时灵时不灵**的按钮
    // 比没有按钮更糟 —— 它让人以为压过了。
    render(<ContextChip {...props} usage={{ used: 1234, window: 200000 }} />)
    fireEvent.click(screen.getByRole('button', { name: /上下文/ }))
    expect(screen.queryByText('压缩上下文')).toBeNull()
    expect(screen.getByRole('dialog').textContent).toContain('自动压缩')
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
