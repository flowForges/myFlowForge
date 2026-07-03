import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StagePromptEditor } from './StagePromptEditor'

describe('StagePromptEditor', () => {
  it('展示只读默认正文', () => {
    render(<StagePromptEditor stageName="技术方案设计" defaultPrompt="默认正文XYZ" onSave={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('默认正文XYZ')).toBeInTheDocument()
  })
  it('保存把 trim 后的追加段传出', () => {
    const onSave = vi.fn()
    render(<StagePromptEditor stageName="技术方案设计" defaultPrompt="d" onSave={onSave} onCancel={() => {}} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  画时序图  ' } })
    fireEvent.click(screen.getByText('保存'))
    expect(onSave).toHaveBeenCalledWith('画时序图')
  })
  it('清空追加 → 传出空串', () => {
    const onSave = vi.fn()
    render(<StagePromptEditor stageName="技术方案设计" defaultPrompt="d" initial="旧" onSave={onSave} onCancel={() => {}} />)
    fireEvent.click(screen.getByText('清空追加'))
    fireEvent.click(screen.getByText('保存'))
    expect(onSave).toHaveBeenCalledWith('')
  })
  it('追加段为空时角标显示「默认」', () => {
    render(<StagePromptEditor stageName="技术方案设计" defaultPrompt="d" onSave={() => {}} onCancel={() => {}} />)
    expect(screen.getByText(/默认$/)).toBeInTheDocument()
  })
})
