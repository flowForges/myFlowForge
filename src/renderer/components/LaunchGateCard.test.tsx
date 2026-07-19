import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LaunchGateCard, type LaunchGateConfig } from './LaunchGateCard'

const base: LaunchGateConfig = {
  seed: '把 token 迁到 OKLCH',
  workflows: [{ id: 'std', name: '标准工作流', stageCount: 4 }, { id: 'basic', name: '基础流程', stageCount: 2 }],
  selectedWorkflowId: 'std',
  projects: [
    { name: 'go-blog', selected: true, provider: 'claude', model: 'claude-opus-4-8' },
    { name: 'zgh', selected: false, provider: 'claude', model: 'claude-opus-4-8' },
  ],
  supplement: '',
}

describe('LaunchGateCard 活态', () => {
  it('展示种子、工作流、项目；确认回传当前配置', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} onConfirm={onConfirm} onCancel={() => {}} />)
    expect(screen.getByText('把 token 迁到 OKLCH')).toBeTruthy()
    expect(screen.getByText('标准工作流')).toBeTruthy()
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ selectedWorkflowId: 'std' }))
  })

  it('取消触发 onCancel', () => {
    const onCancel = vi.fn()
    render(<LaunchGateCard config={base} onConfirm={() => {}} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('frozen 态渲染静态记录、无确认按钮', () => {
    render(<LaunchGateCard config={base} frozen={{ workflowName: '标准工作流', projects: ['go-blog'], supplement: '', decidedAt: 1 }} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.queryByText('确认')).toBeNull()
    expect(screen.getByText(/标准工作流/)).toBeTruthy()
  })

  it('切换工作流选中态后确认，回传新的 selectedWorkflowId', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.click(screen.getByText('基础流程'))
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ selectedWorkflowId: 'basic' }))
  })

  it('取消勾选项目后确认，该项目 selected 变为 false', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.click(screen.getByText('go-blog'))
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        projects: expect.arrayContaining([expect.objectContaining({ name: 'go-blog', selected: false })]),
      })
    )
  })

  it('编辑补充说明后确认，回传新文本', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('补充说明…（可选）'), { target: { value: '记得加测试' } })
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ supplement: '记得加测试' }))
  })
})
