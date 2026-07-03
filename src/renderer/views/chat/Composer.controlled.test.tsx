import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'opus' }, { id: 'sonnet', label: 'sonnet' }] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'default', label: '账号默认' }] },
]

beforeEach(() => { (window as any).forge = { openFiles: vi.fn(async () => []), savePaste: vi.fn() } })

describe('Composer controlled mode', () => {
  it('reflects controlled selection and emits onSelectionChange', () => {
    const onSel = vi.fn()
    const { container } = render(
      <Composer
        providers={providers} disabled={false}
        selection={{ agentId: 'codex', modelId: 'default' }}
        onSelectionChange={onSel}
        onSend={() => {}}
      />,
    )
    // The agent button label span (#agentLabel) should show the controlled agent "Codex"
    // not the first provider "Claude Code" — this verifies controlled mode is active
    const label = container.querySelector('#agentLabel') as HTMLElement
    expect(label.textContent).toBe('Codex')
  })

  it('onSelectionChange fires when clicking a different agent in controlled mode', () => {
    const onSel = vi.fn()
    const { container } = render(
      <Composer
        providers={providers} disabled={false}
        selection={{ agentId: 'codex', modelId: 'default' }}
        onSelectionChange={onSel}
        onSend={() => {}}
      />,
    )
    // open the agent menu
    fireEvent.click(container.querySelector('[data-menu="agentMenu"]') as HTMLElement)
    // click the Claude Code agent item
    const claudeItem = container.querySelector('[data-agent="Claude Code"]') as HTMLElement
    fireEvent.click(claudeItem)
    expect(onSel).toHaveBeenCalledTimes(1)
    expect(onSel.mock.calls[0][0]).toEqual({ agentId: 'claude', modelId: 'opus' })
  })

  it('uncontrolled mode (no selection prop) seeds from providers and works as before', () => {
    const onSend = vi.fn()
    const { container } = render(<Composer providers={providers} disabled={false} onSend={onSend} />)
    // Default (no selection prop): seeds to first provider: claude — check the agentLabel span
    const label = container.querySelector('#agentLabel') as HTMLElement
    expect(label.textContent).toBe('Claude Code')
    const ta = screen.getByPlaceholderText(/给主代理下达任务/)
    fireEvent.change(ta, { target: { value: '测试' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0].agent).toBe('claude')
  })
})
