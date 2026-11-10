// 保存条:干净时不渲染;脏时浮出 未保存 + 保存;保存中 保存 不可点
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SaveBar } from './SaveBar'

describe('SaveBar', () => {
  it('renders nothing when clean', () => {
    const { container } = render(<SaveBar dirty={false} busy={false} onSave={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('dirty: shows 未保存 and an enabled 保存 that calls onSave once', () => {
    const onSave = vi.fn()
    render(<SaveBar dirty busy={false} onSave={onSave} />)
    expect(screen.getByText('未保存')).toBeInTheDocument()
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).not.toBeDisabled()
    expect(save).toHaveClass('mffai-primary')
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('busy: 保存 is disabled and does not call onSave', () => {
    const onSave = vi.fn()
    render(<SaveBar dirty busy onSave={onSave} />)
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()
  })
})
