import { it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { BusyElsewhereStrip } from './BusyElsewhereStrip'

it('renders nothing when the session is not held elsewhere', () => {
  const { container } = render(<BusyElsewhereStrip app={null} onRetry={vi.fn()} />)
  expect(container).toBeEmptyDOMElement()
})

it('shows exactly which app holds the session, and 重试 re-runs the send', () => {
  const onRetry = vi.fn()
  const { container } = render(<BusyElsewhereStrip app="Codex" onRetry={onRetry} />)
  const strip = container.querySelector('.busy-strip')!
  const btn = strip.querySelector('button')!
  expect(strip.textContent!.replace(btn.textContent!, '')).toBe('这个会话正在 Codex 中进行 · 先在那边停止')
  expect(btn.textContent).toBe('重试')
  btn.click()
  expect(onRetry).toHaveBeenCalledOnce()
})
