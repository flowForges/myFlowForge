// src/renderer/views/chat/ChatJumpRail.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ChatJumpRail } from './ChatJumpRail'
import { fmtMsgTime } from '@shared/relTime'
import type { ChatMessage } from '@shared/types'

// A minimal stand-in for the .chat-scroll element. jsdom has no layout, so we
// fabricate geometry + a querySelector that returns nodes with offsetTop.
function fakeScroll(targets: Record<string, { offsetTop: number; node: HTMLElement }>) {
  return {
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 800,
    scrollTo: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: (sel: string) => {
      const m = sel.match(/data-user-msg="(\d+)"/)
      const hit = m ? targets[m[1]] : undefined
      if (!hit) return null
      // emulate offsetTop (read-only in real DOM) on the returned node
      Object.defineProperty(hit.node, 'offsetTop', { value: hit.offsetTop, configurable: true })
      return hit.node
    },
  } as unknown as HTMLDivElement
}

const twoUsers: ChatMessage[] = [
  { id: 'a', who: 'user', text: '  第一条   需求  ', ts: '2026-06-28T09:10:00.000Z' },
  { id: 'b', who: 'ai', text: '好的', ts: '2026-06-28T09:10:05.000Z' },
  { id: 'c', who: 'user', text: '再加个功能', ts: '2026-06-28T09:11:00.000Z' },
]

describe('ChatJumpRail', () => {
  it('hides the rail (no .on, no dots) with one or zero user messages', () => {
    const ref = { current: fakeScroll({}) }
    const { container } = render(<ChatJumpRail messages={[twoUsers[0], twoUsers[1]]} scrollRef={ref as any} />)
    const rail = container.querySelector('.chat-jump-rail')!
    expect(rail.classList.contains('on')).toBe(false)
    expect(container.querySelectorAll('.chat-jump-dot').length).toBe(0)
  })

  it('renders one dot per user message with collapsed/normalized preview + HH:MM label', () => {
    const ref = { current: fakeScroll({}) }
    const { container } = render(<ChatJumpRail messages={twoUsers} scrollRef={ref as any} />)
    const rail = container.querySelector('.chat-jump-rail')!
    expect(rail.classList.contains('on')).toBe(true)
    const dots = container.querySelectorAll('.chat-jump-dot')
    expect(dots.length).toBe(2)
    expect(Array.from(dots).map(d => d.getAttribute('data-jump-msg'))).toEqual(['0', '2'])
    // whitespace collapsed in preview text
    expect(dots[0].querySelector('.jp-t')!.textContent).toBe('第一条 需求')
    // label uses fmtMsgTime (HH:MM for same-day)
    expect(dots[0].querySelector('.jp-k')!.textContent).toBe(fmtMsgTime(twoUsers[0].ts!, Date.now()))
  })

  it('truncates preview text to 90 chars with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const msgs: ChatMessage[] = [
      { id: 'a', who: 'user', text: long, ts: '2026-06-28T09:10:00.000Z' },
      { id: 'b', who: 'user', text: 'y', ts: '2026-06-28T09:11:00.000Z' },
    ]
    const ref = { current: fakeScroll({}) }
    const { container } = render(<ChatJumpRail messages={msgs} scrollRef={ref as any} />)
    const t = container.querySelector('.jp-t')!.textContent!
    expect(t.endsWith('…')).toBe(true)
    expect(t.length).toBe(91) // 90 chars + ellipsis
  })

  it('click scrolls to the target user message and flashes it', () => {
    const node = document.createElement('div')
    const ref = { current: fakeScroll({ '2': { offsetTop: 640, node } }) }
    const { container } = render(<ChatJumpRail messages={twoUsers} scrollRef={ref as any} />)
    const secondDot = container.querySelectorAll('.chat-jump-dot')[1]
    fireEvent.click(secondDot)
    expect((ref.current as any).scrollTo).toHaveBeenCalledWith({ top: 622, behavior: 'smooth' }) // 640-18
    expect(node.classList.contains('jump-flash')).toBe(true)
  })
})
