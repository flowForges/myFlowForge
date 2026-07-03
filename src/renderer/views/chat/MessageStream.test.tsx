import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageStream } from './MessageStream'
import type { ChatMessage } from '@shared/types'

const msgs: ChatMessage[] = [
  { id: 'u1', who: 'user', text: '迁移 token', ts: '1' },
  { id: 'a1', who: 'ai', text: '已完成 47 处替换', model: 'Claude Code · opus-4.8', ts: '2',
    think: { label: '已编排 3 个子代理', elapsed: 23, steps: ['扫描代码库', '生成依赖图谱'] } }
]

describe('MessageStream', () => {
  it('renders user + ai messages with model + think steps, and toggles the think block', () => {
    render(<MessageStream messages={msgs} streamingIds={new Set()} />)
    expect(screen.getByText('迁移 token')).toBeInTheDocument()
    expect(screen.getByText('已完成 47 处替换')).toBeInTheDocument()
    expect(screen.getByText('Claude Code · opus-4.8')).toBeInTheDocument()
    const head = screen.getByText('已编排 3 个子代理')
    fireEvent.click(head)
    expect(screen.getByText('扫描代码库')).toBeVisible()
  })

  it('renders a 查看变更 button on a done message with changes and fires onViewChanges', () => {
    const onViewChanges = vi.fn()
    const done: ChatMessage[] = [
      { id: 'd1', who: 'ai', text: '完成', model: 'Claude Code · 转述', ts: '3',
        changes: { total: 3, add: 10, del: 2 } }
    ]
    render(<MessageStream messages={done} streamingIds={new Set()} onViewChanges={onViewChanges} />)
    const btn = screen.getByRole('button', { name: /查看变更/ })
    expect(btn).toHaveTextContent('3 文件 +10 −2')
    fireEvent.click(btn)
    expect(onViewChanges).toHaveBeenCalledTimes(1)
  })

  it('does not render 查看变更 when there are no changes', () => {
    const msgs: ChatMessage[] = [{ id: 'd2', who: 'ai', text: '完成', ts: '4', changes: { total: 0, add: 0, del: 0 } }]
    render(<MessageStream messages={msgs} streamingIds={new Set()} onViewChanges={() => {}} />)
    expect(screen.queryByText(/查看变更/)).not.toBeInTheDocument()
  })
})

const anchorMsgs: ChatMessage[] = [
  { id: 'a', who: 'user', text: '第一条需求', ts: '2026-06-28T09:10:00.000Z' },
  { id: 'b', who: 'ai', text: '好的', ts: '2026-06-28T09:10:05.000Z' },
  { id: 'c', who: 'user', text: '再加个功能', ts: '2026-06-28T09:11:00.000Z' },
]

describe('MessageStream data-user-msg anchors', () => {
  it('tags user messages with their array index and leaves AI messages untagged', () => {
    const { container } = render(
      <MessageStream messages={anchorMsgs} streamingIds={new Set()} />,
    )
    const anchors = Array.from(container.querySelectorAll('[data-user-msg]'))
    expect(anchors.map(a => a.getAttribute('data-user-msg'))).toEqual(['0', '2'])
    // exactly the two user messages, none for the AI message
    expect(anchors.length).toBe(2)
  })
})
