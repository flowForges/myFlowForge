// 标签式输入(08 §11):渲染已有标签,回车或点「添加」加一个,去空白去重;点标签自己的删除按钮删它
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TagInput } from './TagInput'

describe('TagInput', () => {
  it('renders existing tags', () => {
    render(<TagInput label="应匹配" value={['a', 'b']} onChange={() => {}} />)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('b')).toBeInTheDocument()
  })

  it('adds a trimmed tag on Enter and clears the input', () => {
    const onChange = vi.fn()
    render(<TagInput label="应匹配" value={['a']} onChange={onChange} />)
    const input = screen.getByLabelText<HTMLInputElement>('应匹配')
    fireEvent.change(input, { target: { value: '  c  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['a', 'c'])
    expect(input.value).toBe('')
  })

  it('adds via the 添加 button', () => {
    const onChange = vi.fn()
    render(<TagInput label="应匹配" value={[]} onChange={onChange} />)
    const input = screen.getByLabelText('应匹配')
    fireEvent.change(input, { target: { value: 'z' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(onChange).toHaveBeenCalledWith(['z'])
  })

  it('empty text and an exact duplicate are no-ops', () => {
    const onChange = vi.fn()
    render(<TagInput label="应匹配" value={['a']} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(onChange).not.toHaveBeenCalled()
    const input = screen.getByLabelText('应匹配')
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes a tag by its own delete button, leaving the others', () => {
    const onChange = vi.fn()
    render(<TagInput label="应匹配" value={['a', 'b', 'c']} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '删除 b' }))
    expect(onChange).toHaveBeenCalledWith(['a', 'c'])
  })
})
