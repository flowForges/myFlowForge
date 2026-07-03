import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CreateWorkspace } from './CreateWorkspace'

const baseProps = {
  open: true, onCancel: () => {}, projects: [], providers: [{ id: 'claude', displayName: 'Claude', installed: true, models: [{ id: 'opus-4.8', label: 'opus' }] }] as any,
  workflows: [{ id: 'standard', name: '标准', stages: [{ key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' }], plugins: [], stagePrompts: {} }] as any,
  onOpenProjectSettings: () => {}, onNewWorkflow: () => {},
}

describe('CreateWorkspace — stage prompt editing', () => {
  it('流程条点阶段 chip → 编辑追加段 → 再次打开预填', () => {
    const onCreate = vi.fn()
    render(<CreateWorkspace {...baseProps} onCreate={onCreate} />)
    // 流程条里的 design chip(可点) - title 含 "编辑「技术方案设计」"
    fireEvent.click(screen.getByTitle(/编辑「技术方案设计」/))
    fireEvent.change(screen.getByPlaceholderText(/必须画时序图/), { target: { value: '画时序图' } })
    fireEvent.click(screen.getByText('保存'))
    // 再次打开编辑器应预填(证明 state 已写入)
    fireEvent.click(screen.getByTitle(/编辑「技术方案设计」/))
    expect((screen.getByPlaceholderText(/必须画时序图/) as HTMLTextAreaElement).value).toBe('画时序图')
  })

  it('在两个阶段间直接切换时,补充要求 textarea 不串台(Bug #2)', () => {
    const twoStage = {
      ...baseProps,
      workflows: [{ id: 'standard', name: '标准', stages: [
        { key: 'requirement', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
        { key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
      ], plugins: [], stagePrompts: {} }] as any,
    }
    render(<CreateWorkspace {...twoStage} onCreate={vi.fn()} />)
    // 打开「需求评估」编辑器,输入文案但不保存
    fireEvent.click(screen.getByTitle(/编辑「需求评估」/))
    fireEvent.change(screen.getByPlaceholderText(/必须画时序图/), { target: { value: '需求侧文案' } })
    // 直接切到「技术方案设计」(stageEdit 由 truthy→truthy)——textarea 必须重置,而非沿用需求侧文案
    fireEvent.click(screen.getByTitle(/编辑「技术方案设计」/))
    expect((screen.getByPlaceholderText(/必须画时序图/) as HTMLTextAreaElement).value).toBe('')
  })

  it('onCreate 收到含追加提示词的 design stage', () => {
    const onCreate = vi.fn()
    render(<CreateWorkspace {...baseProps} onCreate={onCreate} />)
    // 填写工作区路径(id="crPath", placeholder="~/code/")使 canCreate 条件满足
    fireEvent.change(screen.getByPlaceholderText('~/code/'), { target: { value: '/tmp/myproject' } })
    // 点击 design chip 打开编辑器
    fireEvent.click(screen.getByTitle(/编辑「技术方案设计」/))
    // 输入追加文本
    fireEvent.change(screen.getByPlaceholderText(/必须画时序图/), { target: { value: '画时序图' } })
    // 保存
    fireEvent.click(screen.getByText('保存'))
    // 点击创建工作区按钮(id="crCreate", text="创建工作区")
    fireEvent.click(screen.getByText('创建工作区'))
    // onCreate 应被调用,且 stages 中 design stage 的 prompt === '画时序图'
    expect(onCreate).toHaveBeenCalledOnce()
    const opts = onCreate.mock.calls[0][0]
    const designStage = (opts.stages as Array<{ key: string; prompt?: string }>).find(s => s.key === 'design')
    expect(designStage?.prompt).toBe('画时序图')
  })
})
