import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StatusBar } from './StatusBar'
import type { StatusbarUsage } from '@shared/plugins'

// ─── Mock data ───────────────────────────────────────────────────────────────

const provider = {
  id: 'claude',
  displayName: 'Claude',
  installed: true,
  authOk: true,
  models: [],
}

const usage: StatusbarUsage = {
  window5h: { used: 30, limit: 100, resetAt: Date.now() + 2 * 60 * 60 * 1000 },
  weekly: { used: 50, limit: 200 },
  label: 'Claude Pro',
}

const usageByProvider: Record<string, StatusbarUsage> = {
  claude: usage,
}

const base = {
  branch: 'main',
  providers: [provider] as any[],
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('StatusBar usage popover', () => {
  it('T1: clicking pill with usage opens .usage-pop showing window5h + weekly progress bars', () => {
    const { container } = render(
      <StatusBar {...base} usageByProvider={usageByProvider} />,
    )

    // Popover should be present in DOM but without .on class initially
    const popBefore = container.querySelector('.usage-pop')
    expect(popBefore).not.toBeNull()
    expect(popBefore!.classList.contains('on')).toBe(false)

    // Click the provider pill
    const pill = screen.getByText('Claude').closest('button')!
    fireEvent.click(pill)

    // Popover should now have .on class (visible)
    const pop = container.querySelector('.usage-pop')
    expect(pop).not.toBeNull()
    expect(pop!.classList.contains('on')).toBe(true)

    // Usage is shown as a percentage now (not raw used/limit):
    // window5h = 30/100 = 30%, weekly = 50/200 = 25%
    expect(pop!.textContent).toContain('30%')
    expect(pop!.textContent).toContain('25%')

    // Progress bars (2 of them — one for each bucket), threshold-colored .sbp-fill
    const bars = container.querySelectorAll('.sbp-fill')
    expect(bars.length).toBeGreaterThanOrEqual(2)

    const widths = Array.from(bars).map(b => (b as HTMLElement).style.width)
    expect(widths).toContain('30%')
    expect(widths).toContain('25%')
    // 30% and 25% are both below the warn threshold → ok tier
    for (const bar of Array.from(bars)) expect(bar.className).toContain('ok')
  })

  it('T2: clicking pill WITHOUT usage data does NOT open .usage-pop', () => {
    const { container } = render(
      // usageByProvider has no entry for 'claude'
      <StatusBar {...base} usageByProvider={{}} />,
    )

    const pill = screen.getByText('Claude').closest('button')!
    fireEvent.click(pill)

    // No popover should appear
    expect(container.querySelector('.usage-pop')).toBeNull()
  })

  it('T3: outside click closes the open popover', () => {
    const { container } = render(
      <StatusBar {...base} usageByProvider={usageByProvider} />,
    )

    // Open the popover
    const pill = screen.getByText('Claude').closest('button')!
    fireEvent.click(pill)
    expect(container.querySelector('.usage-pop.on')).not.toBeNull()

    // Click outside (on document body)
    fireEvent.click(document.body)

    // Popover .on class should be removed (closed), element stays in DOM
    expect(container.querySelector('.usage-pop.on')).toBeNull()
    expect(container.querySelector('.usage-pop')).not.toBeNull()
  })

  it('T4: usage with limit:0 renders 0%-width bars, no NaN', () => {
    const zeroLimitUsage: StatusbarUsage = {
      window5h: { used: 0, limit: 0 },
      weekly: { used: 5, limit: 0 },
      label: 'Zero Limit',
    }
    const { container } = render(
      <StatusBar {...base} usageByProvider={{ claude: zeroLimitUsage }} />,
    )
    // Open the popover
    const pill = screen.getByText('Claude').closest('button')!
    fireEvent.click(pill)

    const bars = container.querySelectorAll('.sbp-fill')
    expect(bars.length).toBeGreaterThanOrEqual(2)
    for (const bar of Array.from(bars)) {
      const w = (bar as HTMLElement).style.width
      expect(w).toBe('0%')  // must not be NaN%
    }
  })
})
