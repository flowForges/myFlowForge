import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkflowPane } from './WorkflowPane'
import type { Plugin } from '@shared/plugin'

const workflows = [
  { id: 'standard', name: '标准工作流', stages: [
    { key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
    { key: 'test', defaultAgent: 'claude', defaultModel: 'opus-4.8' }
  ], plugins: [] }
]

describe('WorkflowPane', () => {
  it('lists templates with stage count + delete, and creates a new workflow', () => {
    const onCreate = vi.fn(); const onDelete = vi.fn()
    render(<WorkflowPane workflows={workflows} onCreate={onCreate} onDelete={onDelete} onUpdateWorkflow={() => {}} onUpdateStagePrompts={() => {}} />)
    expect(screen.getByText('标准工作流')).toBeInTheDocument()
    expect(screen.getByText('2 阶段')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('删除'))
    expect(onDelete).toHaveBeenCalledWith('standard')
    fireEvent.change(screen.getByPlaceholderText(/流程名称/), { target: { value: '重构流程' } })
    const mk = screen.getByText('创建')
    expect(mk).not.toBeDisabled()
    fireEvent.click(mk)
    // draft starts with develop → create passes the ordered full stage config
    expect(onCreate).toHaveBeenCalledWith('重构流程', [{ key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' }])
  })
  it('new-workflow draft: add a built-in stage, then create with both in order', () => {
    const onCreate = vi.fn()
    render(<WorkflowPane workflows={workflows} onCreate={onCreate} onDelete={() => {}} onUpdateWorkflow={() => {}} onUpdateStagePrompts={() => {}} />)
    // the "加阶段" row offers built-ins not yet in the draft; add 写单测/test
    fireEvent.click(screen.getByText('+ 写单测'))
    fireEvent.change(screen.getByPlaceholderText(/流程名称/), { target: { value: '重构流程' } })
    fireEvent.click(screen.getByText('创建'))
    const [name, stages] = onCreate.mock.calls[0]
    expect(name).toBe('重构流程')
    expect(stages.map((s: any) => s.key)).toEqual(['develop', 'test'])   // draft order preserved
  })
  it('new-workflow draft: reference a library custom stage → create includes a libId stage', () => {
    // The draft no longer adds an empty placeholder; custom stages come from the shared library
    // (从库选择 / 新建共享). Referencing a lib def inserts a stage carrying its libId.
    const onCreate = vi.fn()
    const def = { id: 'lib-9', key: 'lib-9', name: '安全审计', defaultAgent: 'claude', defaultModel: '' }
    const onUpsertCustomStage = vi.fn(async () => def)
    render(<WorkflowPane workflows={workflows} customStages={[def] as any} onUpsertCustomStage={onUpsertCustomStage as any} onCreate={onCreate} onDelete={() => {}} onUpdateWorkflow={() => {}} onUpdateStagePrompts={() => {}} />)
    fireEvent.click(screen.getByText('安全审计'))   // 从库选择: reference the library def in the draft
    fireEvent.change(screen.getByPlaceholderText(/流程名称/), { target: { value: 'X' } })
    fireEvent.click(screen.getByText('创建'))
    const [, stages] = onCreate.mock.calls[0]
    expect(stages.some((s: any) => s.libId === 'lib-9')).toBe(true)
  })
  it('shows the empty state when there are no templates', () => {
    render(<WorkflowPane workflows={[]} onCreate={() => {}} onDelete={() => {}} onUpdateWorkflow={() => {}} onUpdateStagePrompts={() => {}} />)
    expect(screen.getByText(/还没有工作流模板/)).toBeInTheDocument()
  })

  it('drags second chip before first within same after-group', () => {
    const plugins: Plugin[] = [
      { id: 'p1', name: 'A', prompt: '', after: '__start', skills: [], tools: [] },
      { id: 'p2', name: 'B', prompt: '', after: '__start', skills: [], tools: [] },
    ]
    const wf = { id: 'w1', name: 'W', stages: [], plugins }
    const onUpdate = vi.fn()
    render(<WorkflowPane workflows={[wf]} onCreate={() => {}} onDelete={() => {}} onUpdateWorkflow={onUpdate} onUpdateStagePrompts={() => {}} />)
    // get chips by finding spans with class wf-plug-chip
    const chips = screen.getAllByText(/^[AB]$/).filter(el => el.closest('.wf-plug-chip'))
    // chips[0] = A, chips[1] = B
    const chipA = chips[0].closest('.wf-plug-chip')!
    const chipB = chips[1].closest('.wf-plug-chip')!
    fireEvent.dragStart(chipB) // drag B
    fireEvent.dragOver(chipA) // dragOver A (calls preventDefault)
    fireEvent.drop(chipA)     // drop onto A
    expect(onUpdate).toHaveBeenCalledWith('w1', [
      { id: 'p2', name: 'B', prompt: '', after: '__start', skills: [], tools: [] },
      { id: 'p1', name: 'A', prompt: '', after: '__start', skills: [], tools: [] },
    ])
  })
})
