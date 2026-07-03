import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PetBubble } from './PetBubble'

describe('PetBubble', () => {
  it('渲染问候+阶段,点击触发 onOpen', () => {
    const onOpen = vi.fn()
    render(<PetBubble active={[{ name: 'Codex', role: '', stage: '技术方案设计' }]} seed="r1" corner="right" onOpen={onOpen} />)
    expect(screen.getByText('正在执行:技术方案设计 · Codex')).toBeInTheDocument()
    fireEvent.click(screen.getByText('正在执行:技术方案设计 · Codex'))
    expect(onOpen).toHaveBeenCalled()
  })
  it('无执行代理时不渲染', () => {
    const { container } = render(<PetBubble active={[]} seed="r1" corner="right" onOpen={() => {}} />)
    expect(container.querySelector('.pet-bubble')).toBeNull()
  })
})
