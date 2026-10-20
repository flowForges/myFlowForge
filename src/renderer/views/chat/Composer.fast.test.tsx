import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8', fastTier: true }] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [
    { id: 'default', label: '默认' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', fastTier: true, fastTierDescription: '2x speed, increased usage' },
    { id: 'plain', label: 'Plain', fastTier: false },
  ] },
]

beforeEach(() => { (window as any).forge = { openFiles: vi.fn(async () => []), savePaste: vi.fn() } })

const sel = (agentId: string, modelId: string) => ({ agentId, modelId, permissionMode: 'auto' as const, browserUse: 'off' as const })
const chip = () => screen.queryByRole('button', { name: /快速/ })

describe('codex 快速档 chip', () => {
  it('codex + 报了快速档的模型 → 出现,title 是 codex 自己的描述', () => {
    render(<Composer providers={providers} disabled={false} onSend={vi.fn()} selection={sel('codex', 'gpt-6-astra')} onSelectionChange={() => {}} fast={false} onFastChange={vi.fn()} />)
    expect(chip()).toBeTruthy()
    expect(chip()!.getAttribute('title')).toBe('2x speed, increased usage')
    expect(chip()!.getAttribute('aria-pressed')).toBe('false')
  })

  it('codex 但模型没有快速档 / 没有档位信息(default)→ 不出现', () => {
    const { rerender } = render(<Composer providers={providers} disabled={false} onSend={vi.fn()} selection={sel('codex', 'plain')} onSelectionChange={() => {}} fast={true} onFastChange={vi.fn()} />)
    expect(chip()).toBeNull()
    rerender(<Composer providers={providers} disabled={false} onSend={vi.fn()} selection={sel('codex', 'default')} onSelectionChange={() => {}} fast={true} onFastChange={vi.fn()} />)
    expect(chip()).toBeNull()
  })

  it('别的 agent(claude)→ 不出现,即使模型对象上碰巧有 fastTier', () => {
    render(<Composer providers={providers} disabled={false} onSend={vi.fn()} selection={sel('claude', 'opus-4.8')} onSelectionChange={() => {}} fast={true} onFastChange={vi.fn()} />)
    expect(chip()).toBeNull()
  })

  it('点击调用会话 setter:关 → true,开 → false', () => {
    const onFastChange = vi.fn()
    const { rerender } = render(<Composer providers={providers} disabled={false} onSend={vi.fn()} selection={sel('codex', 'gpt-6-astra')} onSelectionChange={() => {}} fast={false} onFastChange={onFastChange} />)
    fireEvent.click(chip()!)
    expect(onFastChange).toHaveBeenLastCalledWith(true)
    rerender(<Composer providers={providers} disabled={false} onSend={vi.fn()} selection={sel('codex', 'gpt-6-astra')} onSelectionChange={() => {}} fast={true} onFastChange={onFastChange} />)
    expect(chip()!.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chip()!)
    expect(onFastChange).toHaveBeenLastCalledWith(false)
  })

  it('发送带上 fast;模型不支持时即使会话上开着也发 false', () => {
    const onSend = vi.fn()
    const { container, rerender } = render(<Composer providers={providers} disabled={false} onSend={onSend} selection={sel('codex', 'gpt-6-astra')} onSelectionChange={() => {}} fast={true} onFastChange={vi.fn()} />)
    const ta = container.querySelector('textarea')!
    fireEvent.change(ta, { target: { value: 'hi' } })
    fireEvent.click(container.querySelector('#sendBtn')!)
    expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({ fast: true }))
    rerender(<Composer providers={providers} disabled={false} onSend={onSend} selection={sel('codex', 'plain')} onSelectionChange={() => {}} fast={true} onFastChange={vi.fn()} />)
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'again' } })
    fireEvent.click(container.querySelector('#sendBtn')!)
    expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({ fast: false }))
  })
})
