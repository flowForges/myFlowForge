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
    expect(onCreate).toHaveBeenCalledWith('重构流程', ['develop'])
  })
  it('resets stage picks to develop-only after a successful create', () => {
    const onCreate = vi.fn()
    render(<WorkflowPane workflows={workflows} onCreate={onCreate} onDelete={() => {}} onUpdateWorkflow={() => {}} onUpdateStagePrompts={() => {}} />)
    const pickByText = (t: string) =>
      screen.getAllByRole('button').find((b) => b.classList.contains('wf-pick') && b.textContent === t)!
    const testPick = pickByText('写单测')
    const developPick = pickByText('代码开发')
    // pick the extra "写单测/test" stage
    fireEvent.click(testPick)
    expect(testPick.classList.contains('on')).toBe(true)
    fireEvent.change(screen.getByPlaceholderText(/流程名称/), { target: { value: '重构流程' } })
    fireEvent.click(screen.getByText('创建'))
    expect(onCreate).toHaveBeenCalledWith('重构流程', ['develop', 'test'])
    // after creation, picks revert to develop-only
    expect(pickByText('写单测').classList.contains('on')).toBe(false)
    expect(developPick.classList.contains('on')).toBe(true)
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
