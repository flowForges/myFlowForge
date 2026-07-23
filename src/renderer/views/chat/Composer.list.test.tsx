import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'opus' }] },
]

beforeEach(() => { (window as any).forge = { openFiles: vi.fn(async () => []), savePaste: vi.fn() } })

function typed(value: string): HTMLTextAreaElement {
  const ta = screen.getByPlaceholderText(/给主代理下达任务/) as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value } })
  ta.selectionStart = ta.selectionEnd = value.length   // caret at end
  return ta
}

describe('Composer smart list continuation', () => {
  it('plain Enter on a list line continues the list instead of sending', () => {
    const onSend = vi.fn()
    render(<Composer providers={providers} disabled={false} onSend={onSend} />)
    const ta = typed('1. 买菜')
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(ta.value).toBe('1. 买菜\n2. ')
  })

  it('⌘/Ctrl+Enter sends even from a list line (escape hatch)', () => {
    const onSend = vi.fn()
    render(<Composer providers={providers} disabled={false} onSend={onSend} />)
    const ta = typed('1. 买菜')
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0].text).toBe('1. 买菜')
  })

  it('plain Enter on a non-list line still sends (regression)', () => {
    const onSend = vi.fn()
    render(<Composer providers={providers} disabled={false} onSend={onSend} />)
    const ta = typed('普通消息')
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
  })
})
