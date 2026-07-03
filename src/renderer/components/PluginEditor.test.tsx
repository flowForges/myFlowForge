import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PluginEditor } from './PluginEditor'

describe('PluginEditor', () => {
  it('disables save until name is non-empty', () => {
    render(<PluginEditor afterLabel="需求分析 之后" onSave={() => {}} onCancel={() => {}} />)
    const save = screen.getByText('添加插件') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText(/当前时间/), { target: { value: '读取记忆' } })
    expect(save.disabled).toBe(false)
  })

  it('toggles skill/tool chips and reports them on save', () => {
    const onSave = vi.fn()
    render(<PluginEditor afterLabel="x" initial={{ name: 'p', prompt: 'do' }} onSave={onSave} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /code-review/ }))
    fireEvent.click(screen.getByRole('button', { name: /读取文件/ }))
    fireEvent.click(screen.getByText('保存'))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ skills: ['code-review'], tools: ['read'] }))
  })

  it('shows presets only in add mode (no initial.name)', () => {
    const presets = [{ name: '获取当前时间', prompt: '获取并返回当前时间' }]
    const { container: c1 } = render(<PluginEditor afterLabel="x" presets={presets} onSave={() => {}} onCancel={() => {}} />)
    expect(c1.querySelector('.plug-presets')).toBeTruthy()

    const { container: c2 } = render(<PluginEditor afterLabel="x" presets={presets} initial={{ name: 'existing' }} onSave={() => {}} onCancel={() => {}} />)
    expect(c2.querySelector('.plug-presets')).toBeNull()
  })

  it('renders a preset glyph svg when the preset carries a glyph id', () => {
    const presets = [
      { name: '当前时间', glyph: 'clock', prompt: 'p' },
      { name: '空白插件', prompt: '' }, // no glyph → no svg
    ]
    const { container } = render(<PluginEditor afterLabel="x" presets={presets} onSave={() => {}} onCancel={() => {}} />)
    const buttons = container.querySelectorAll('.plug-preset')
    expect(buttons[0].querySelector('svg')).not.toBeNull()
    expect(buttons[1].querySelector('svg')).toBeNull()
  })

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn()
    render(<PluginEditor afterLabel="x" onSave={() => {}} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('prefills name and prompt from initial prop', () => {
    render(<PluginEditor afterLabel="x" initial={{ name: 'My Plugin', prompt: 'do something' }} onSave={() => {}} onCancel={() => {}} />)
    expect((screen.getByPlaceholderText(/当前时间/) as HTMLInputElement).value).toBe('My Plugin')
    expect((screen.getByPlaceholderText(/描述这个插件/) as HTMLTextAreaElement).value).toBe('do something')
  })

  it('shows 编辑插件 in header when editing, 新增插件 when adding', () => {
    const { rerender, getByText } = render(<PluginEditor afterLabel="x" onSave={() => {}} onCancel={() => {}} />)
    expect(getByText('新增插件')).toBeInTheDocument()

    rerender(<PluginEditor afterLabel="x" initial={{ name: 'p' }} onSave={() => {}} onCancel={() => {}} />)
    expect(getByText('编辑插件')).toBeInTheDocument()
  })
})
