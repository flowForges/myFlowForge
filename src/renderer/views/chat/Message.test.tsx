import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Message } from './Message'

describe('Message', () => {
  it('ai message with thinking, done: shows 回答 eyebrow and ans body', () => {
    const { container } = render(<Message msg={{ id: 'a', who: 'ai', text: 'hi', think: { label: '已思考', steps: ['x'] } } as any} streaming={false} />)
    expect(screen.getByText('回答')).toBeInTheDocument()
    expect(container.querySelector('.msg-body.ans')).toBeTruthy()
  })
  it('ai message while streaming: caret, no 回答 eyebrow', () => {
    const { container } = render(<Message msg={{ id: 'a', who: 'ai', text: 'hi', think: { label: '思考中', steps: [] } } as any} streaming />)
    expect(screen.getByText('回答中')).toBeInTheDocument()
    expect(container.querySelector('.msg-body .pending')).toBeTruthy()
  })

  it('renders user text in a dedicated bubble that preserves literal text', () => {
    const { container } = render(<Message msg={{ id: 'u', who: 'user', text: '第一行\n第二行' } as any} streaming={false} />)
    const bubble = container.querySelector('.user-bubble')
    expect(bubble).toBeTruthy()
    expect(bubble).toHaveTextContent('第一行 第二行')
  })

  it('separates AI thinking from the final answer block', () => {
    const { container } = render(<Message msg={{ id: 'a', who: 'ai', text: '最终结果', think: { label: '思考过程', steps: ['分析中'] } } as any} streaming={false} />)
    expect(container.querySelector('.think')).toBeTruthy()
    expect(container.querySelector('.answer-block .msg-body.ans')).toBeTruthy()
  })

  it('shows the hover meta (local HH:MM time + copy) when not streaming, and hides it while streaming', () => {
    // Use TODAY at a fixed local time so the label is bare HH:MM (a hardcoded past date would format as
    // 昨天/前天/date once the calendar advances). Local 14:07 → ISO (UTC) → rendered back as local 14:07.
    const d = new Date(); d.setHours(14, 7, 0, 0)
    const iso = d.toISOString()
    const { container, rerender } = render(<Message msg={{ id: 'a', who: 'ai', text: 'hi', ts: iso } as any} streaming={false} />)
    expect(container.querySelector('.msg-meta')).toBeTruthy()
    expect(container.querySelector('.mm-time')!.textContent).toBe('14:07')   // local time, not UTC
    expect(container.querySelector('.mm-copy')).toBeTruthy()
    rerender(<Message msg={{ id: 'a', who: 'ai', text: 'hi', ts: iso } as any} streaming />)
    expect(container.querySelector('.msg-meta')).toBeNull()
  })

  it('copy button writes the message text to the clipboard and flips to 已复制', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    const { container } = render(<Message msg={{ id: 'u', who: 'user', text: '部署到预发布', ts: '09:00:00' } as any} streaming={false} />)
    fireEvent.click(container.querySelector('.mm-copy')!)
    expect(writeText).toHaveBeenCalledWith('部署到预发布')
    await waitFor(() => expect(container.querySelector('.mm-copy.done')).toBeTruthy())
    expect(screen.getByText('已复制')).toBeInTheDocument()
  })

  it('renders an openable 打开文档 chip when the message carries design docs', () => {
    const onOpenDoc = vi.fn()
    const doc = { path: 'docs/plan.md', cwd: '/ws/proj', name: '设计' }
    const { container } = render(
      <Message msg={{ id: 'a', who: 'ai', text: '✓ 设计完成', docs: [doc] } as any} streaming={false} onOpenDoc={onOpenDoc} />,
    )
    const btn = container.querySelector('.msg-doc') as HTMLElement
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
    expect(onOpenDoc).toHaveBeenCalledWith(doc)
  })

  it('does not render loaded skills/rules inline in the message body', () => {
    render(<Message msg={{ id: 'a', who: 'ai', text: 'hi', context: { skills: [{ name: 'forge-workflow', path: 'x' }], rules: [{ name: 'AGENTS.md', path: 'y' }] } } as any} streaming={false} />)
    expect(screen.queryByText('Skill')).toBeNull()
    expect(screen.queryByText('forge-workflow')).toBeNull()
    expect(screen.queryByText('Rule')).toBeNull()
    expect(screen.queryByText('AGENTS.md')).toBeNull()
  })
})
