import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageStream } from './MessageStream'
import type { ChatMessage } from '@shared/types'

function make200(): ChatMessage[] {
  return Array.from({ length: 200 }, (_, i) => ({
    id: `m${i}`,
    who: i % 2 === 0 ? 'user' : 'ai',
    text: `消息 ${i}`,
    ts: String(i),
  } as ChatMessage))
}

describe('MessageStream windowing', () => {
  it('with windowSize=60 renders exactly 60 messages and shows 加载更早 button', () => {
    const { container } = render(
      <MessageStream messages={make200()} streamingIds={new Set()} windowSize={60} />,
    )
    const rows = container.querySelectorAll('.msg')
    expect(rows.length).toBe(60)
    expect(screen.getByRole('button', { name: /加载更早/ })).toBeInTheDocument()
  })

  it('clicking 加载更早 increases rendered count by 50 (to 110)', () => {
    const { container } = render(
      <MessageStream messages={make200()} streamingIds={new Set()} windowSize={60} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /加载更早/ }))
    const rows = container.querySelectorAll('.msg')
    expect(rows.length).toBe(110)
  })

  it('without windowSize renders all 200 messages and no 加载更早 button', () => {
    const { container } = render(
      <MessageStream messages={make200()} streamingIds={new Set()} />,
    )
    expect(container.querySelectorAll('.msg').length).toBe(200)
    expect(screen.queryByRole('button', { name: /加载更早/ })).not.toBeInTheDocument()
  })

  it('index passed to Message is start+i (data-user-msg uses real index)', () => {
    // 200 messages, windowSize=60 → start=140; first visible user msg has index 140
    const { container } = render(
      <MessageStream messages={make200()} streamingIds={new Set()} windowSize={60} />,
    )
    const anchors = Array.from(container.querySelectorAll('[data-user-msg]'))
    // first user message visible starts at index 140 (even indices are user)
    expect(Number(anchors[0]?.getAttribute('data-user-msg'))).toBeGreaterThanOrEqual(140)
  })
})
