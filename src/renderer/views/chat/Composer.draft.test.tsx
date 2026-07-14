import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [{ id: 'claude', label: 'Claude Code', models: ['opus'], installed: true } as unknown as ProviderInfo]

describe('Composer per-session draft (draftKey)', () => {
  it('keeps drafts separate per key and restores on return', () => {
    const view = render(<Composer providers={providers} disabled={false} onSend={vi.fn()} draftKey="wsA A1" />)
    const ta = () => screen.getByPlaceholderText(/给主代理下达任务/) as HTMLTextAreaElement

    fireEvent.change(ta(), { target: { value: 'hello from A1' } })
    expect(ta().value).toBe('hello from A1')

    // Switch to another session → this draft must NOT leak.
    view.rerender(<Composer providers={providers} disabled={false} onSend={vi.fn()} draftKey="wsA A2" />)
    expect(ta().value).toBe('')

    // Type something else in A2.
    fireEvent.change(ta(), { target: { value: 'draft A2' } })
    expect(ta().value).toBe('draft A2')

    // Back to A1 → its own draft is restored.
    view.rerender(<Composer providers={providers} disabled={false} onSend={vi.fn()} draftKey="wsA A1" />)
    expect(ta().value).toBe('hello from A1')

    // And A2 still has its own.
    view.rerender(<Composer providers={providers} disabled={false} onSend={vi.fn()} draftKey="wsA A2" />)
    expect(ta().value).toBe('draft A2')
  })
})
