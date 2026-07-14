import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'opus' }] } as unknown as ProviderInfo]
const ta = () => screen.getByPlaceholderText(/给主代理下达任务/) as HTMLTextAreaElement

// The parent remounts the Composer per chat (key={draftKey}); drafts persist in a module store keyed by
// draftKey, so each session keeps its own unsent text and it never leaks into another session.
describe('Composer per-session draft (draftKey + remount)', () => {
  it('isolates drafts per key and restores on return', () => {
    const view = render(<Composer key="wsA A1" providers={providers} disabled={false} onSend={vi.fn()} draftKey="wsA A1" />)
    fireEvent.change(ta(), { target: { value: 'hello from A1' } })
    expect(ta().value).toBe('hello from A1')

    // Switch to another session → remount with a new key → this draft must NOT leak.
    view.rerender(<Composer key="wsA A2" providers={providers} disabled={false} onSend={vi.fn()} draftKey="wsA A2" />)
    expect(ta().value).toBe('')
    fireEvent.change(ta(), { target: { value: 'draft A2' } })
    expect(ta().value).toBe('draft A2')

    // Back to A1 → its own draft is restored from the store.
    view.rerender(<Composer key="wsA A1" providers={providers} disabled={false} onSend={vi.fn()} draftKey="wsA A1" />)
    expect(ta().value).toBe('hello from A1')

    // A2 still has its own.
    view.rerender(<Composer key="wsA A2" providers={providers} disabled={false} onSend={vi.fn()} draftKey="wsA A2" />)
    expect(ta().value).toBe('draft A2')
  })
})
