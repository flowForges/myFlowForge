import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { TermProxyPane } from './TermProxyPane'

describe('TermProxyPane', () => {
  it('edits the proxy and reports changes; reset clears it', () => {
    const onChange = vi.fn()
    render(<TermProxyPane termProxy="http://127.0.0.1:7897" onChange={onChange} />)
    const input = screen.getByPlaceholderText('http://127.0.0.1:7897') as HTMLInputElement
    expect(input.value).toBe('http://127.0.0.1:7897')
    fireEvent.change(input, { target: { value: 'http://127.0.0.1:1080' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith('http://127.0.0.1:1080')
    fireEvent.click(screen.getByText('清空 · 直连'))
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('flashes the saved class transiently after a save', () => {
    vi.useFakeTimers()
    try {
      const onChange = vi.fn()
      render(<TermProxyPane termProxy="http://127.0.0.1:7897" onChange={onChange} />)
      const input = screen.getByPlaceholderText('http://127.0.0.1:7897') as HTMLInputElement
      const status = screen.getByText('已保存').closest('.proxy-status') as HTMLElement

      expect(status.classList.contains('saved')).toBe(false)

      fireEvent.change(input, { target: { value: 'http://127.0.0.1:1080' } })
      fireEvent.blur(input)
      expect(status.classList.contains('saved')).toBe(true)

      act(() => {
        vi.advanceTimersByTime(1400)
      })
      expect(status.classList.contains('saved')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
