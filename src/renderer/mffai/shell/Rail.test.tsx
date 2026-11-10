import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Rail } from './Rail'
import { MFFAI_PAGES } from '../route'

const LABELS = ['对话', '任务', '记忆', '插件', '连接', '权限', '调试']
const buttons = () => [...document.querySelectorAll('.mffai-nav button')] as HTMLButtonElement[]

describe('Rail', () => {
  it('seven buttons in the nav in today\'s order with today\'s labels; power sits outside the nav', () => {
    render(<Rail page="chat" counts={{}} onSelect={() => {}} power={<span data-testid="pw">p</span>} />)
    expect(buttons().map((b) => b.querySelector('.mffai-navlabel')!.textContent)).toEqual(LABELS)
    expect(screen.getByTestId('pw').closest('.mffai-nav')).toBeNull()
    expect(screen.getByTestId('pw').closest('.mffai-rail')).not.toBeNull()
    // 每个按钮一个装饰图标
    for (const b of buttons()) expect(b.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  })

  it('.on follows the page', () => {
    const r = render(<Rail page="memory" counts={{}} onSelect={() => {}} power={null} />)
    expect(buttons().filter((b) => b.classList.contains('on')).map((b) => b.querySelector('.mffai-navlabel')!.textContent)).toEqual(['记忆'])
    r.rerender(<Rail page="debug" counts={{}} onSelect={() => {}} power={null} />)
    expect(buttons().filter((b) => b.classList.contains('on')).map((b) => b.querySelector('.mffai-navlabel')!.textContent)).toEqual(['调试'])
  })

  it('counts show only when non-zero; plugins badge is the error tone, chat and memory the warn tone', () => {
    render(<Rail page="chat" counts={{ chat: 2, tasks: 0, memory: 3, plugins: 1 }} onSelect={() => {}} power={null} />)
    const n = (i: number) => buttons()[i].querySelector('.mffai-navnum')
    expect(n(0)!.textContent).toBe('2')
    expect(n(1)).toBeNull()
    expect(n(2)!.textContent).toBe('3')
    expect(n(3)!.textContent).toBe('1')
    expect(n(0)!.classList.contains('warn') && n(2)!.classList.contains('warn')).toBe(true)
    expect(n(3)!.classList.contains('err')).toBe(true)
    expect(n(4)).toBeNull()
  })

  it('disabled disables all seven and nothing is selected', () => {
    const onSelect = vi.fn()
    render(<Rail page="chat" counts={{}} disabled onSelect={onSelect} power={null} />)
    expect(buttons().every((b) => b.disabled)).toBe(true)
    fireEvent.click(buttons()[1])
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('clicking calls onSelect with that page', () => {
    const onSelect = vi.fn()
    render(<Rail page="chat" counts={{}} onSelect={onSelect} power={null} />)
    buttons().forEach((b) => fireEvent.click(b))
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual([...MFFAI_PAGES])
  })
})
