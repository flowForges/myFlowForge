import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { Message } from './Message'

/**
 * ★「你的选择」画在**问题被回答的位置**:前文 → 选择 → 后文。
 *  原来它是会话末尾单独一条,而后续输出流进上面那条回复 —— 读起来是倒着的。
 */
const order = (root: HTMLElement, ...needles: string[]) => {
  const body = root.querySelector('.msg-body.ans')!.textContent ?? ''
  return needles.map((n) => body.indexOf(n))
}

describe('Message 里的「你的选择」锚点', () => {
  it('前文、选择、后文按位置排', () => {
    const text = '先问一句。好的,接着做。'
    const { container } = render(
      <Message msg={{ id: 'a', who: 'ai', text, ts: 'x', answers: [{ at: '先问一句。'.length, text: '📝 你的选择\n\n**Q?**\n- A' }] } as any} streaming={false} />,
    )
    const [before, note, after] = order(container, '先问一句。', '你的选择', '好的,接着做。')
    expect(before).toBeGreaterThanOrEqual(0)
    expect(note).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(note)
    expect(container.querySelectorAll('.ans-note')).toHaveLength(1)
  })

  it('生成中:光标在最后一段之后,选择块不当流式渲染', () => {
    const { container } = render(
      <Message msg={{ id: 'a', who: 'ai', text: '前文后文', ts: '', answers: [{ at: 2, text: '选了 A' }] } as any} streaming />,
    )
    const [before, note, after] = order(container, '前文', '选了 A', '后文')
    expect(note).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(note)
    const body = container.querySelector('.msg-body.ans')!
    expect(body.lastElementChild?.classList.contains('pending')).toBe(true)
  })

  it('锚点超出正文(被改写短了)夹到末尾,不丢', () => {
    const { container } = render(
      <Message msg={{ id: 'a', who: 'ai', text: '短', ts: 'x', answers: [{ at: 99, text: '选了 B' }] } as any} streaming={false} />,
    )
    const [before, note] = order(container, '短', '选了 B')
    expect(before).toBeGreaterThanOrEqual(0)
    expect(note).toBeGreaterThan(before)
  })

  it('没有选择时结构和以前一样(只有一段正文)', () => {
    const { container } = render(<Message msg={{ id: 'a', who: 'ai', text: 'hi', ts: 'x' } as any} streaming={false} />)
    expect(container.querySelector('.ans-note')).toBeNull()
    expect(container.querySelector('.msg-body.ans')!.textContent).toBe('hi')
  })
})

describe('Message 复制带上「你的选择」', () => {
  it('复制出去的全文里选择在原位', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    const { container } = render(
      <Message msg={{ id: 'a', who: 'ai', text: '前文后文', ts: 'x', answers: [{ at: 2, text: '选了 A' }] } as any} streaming={false} />,
    )
    fireEvent.click(container.querySelector('.mm-copy')!)
    expect(writeText).toHaveBeenCalledWith('前文\n\n选了 A\n\n后文')
  })
})
