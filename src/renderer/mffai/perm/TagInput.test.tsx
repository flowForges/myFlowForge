// 标签式输入(08 §11、评审修订):渲染已有标签,回车或点「添加」加一个,去空白去重;点标签自己的删除按钮删它;
// 失焦也提交未点「添加」的文字(评审修订 5);disabled 时所有控件不可操作;errors 按下标标红对应标签
// (联网名单的 reason:'network' 用,评审修订 1);registerFlush 让父组件在保存前强制提交挂起的文字。
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

  it('commits pending text on blur', () => {
    const onChange = vi.fn()
    render(<TagInput label="应匹配" value={['a']} onChange={onChange} />)
    const input = screen.getByLabelText<HTMLInputElement>('应匹配')
    fireEvent.change(input, { target: { value: 'pending' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(['a', 'pending'])
    expect(input.value).toBe('')
  })

  it('disabled: no input, add, delete', () => {
    const onChange = vi.fn()
    render(<TagInput label="应匹配" value={['a']} onChange={onChange} disabled />)
    expect(screen.getByLabelText('应匹配')).toBeDisabled()
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '删除 a' })).toBeDisabled()
  })

  it('errors mark the tag at that index with its reason, by position not value', () => {
    render(<TagInput label="联网名单" value={['good.com', 'bad entry'] } onChange={() => {}}
      errors={new Map([[1, { index: 1, rule: 'bad entry', reason: 'network' }]])} />)
    expect(screen.queryByText('network')).toBeInTheDocument()
    const good = screen.getByText('good.com').closest('.mffai-tag') as HTMLElement
    const bad = screen.getByText('bad entry').closest('.mffai-tag') as HTMLElement
    expect(good.className).not.toContain('bad')
    expect(bad.className).toContain('bad')
  })

  it('registerFlush lets the parent force-commit pending text before it reads the value', () => {
    const onChange = vi.fn()
    let flush: (() => void) | undefined
    const registerFlush = (fn: () => void) => { flush = fn; return () => { flush = undefined } }
    render(<TagInput label="应匹配" value={['a']} onChange={onChange} registerFlush={registerFlush} />)
    fireEvent.change(screen.getByLabelText('应匹配'), { target: { value: 'z' } })
    expect(onChange).not.toHaveBeenCalled()
    flush?.()
    expect(onChange).toHaveBeenCalledWith(['a', 'z'])
  })

  it('registerFlush unregisters on unmount', () => {
    const unregister = vi.fn()
    const registerFlush = () => unregister
    const { unmount } = render(<TagInput label="应匹配" value={[]} onChange={() => {}} registerFlush={registerFlush} />)
    unmount()
    expect(unregister).toHaveBeenCalledTimes(1)
  })
})
