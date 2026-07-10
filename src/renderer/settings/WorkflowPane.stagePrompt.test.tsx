import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkflowPane } from './WorkflowPane'

// #3: clicking a stage chip now opens the full StageConfigEditor (name/prompt/agent/flags), persisted
// via onUpdateStages over the whole stages list. The old append-only stagePrompts flow is superseded.
const wf = { id: 'standard', name: '标准', stages: [{ key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' }], plugins: [], stagePrompts: {} } as any

it('点内置阶段 chip → 编辑追加要求 → onUpdateStages 写入 stage.prompt', () => {
  const onUpdateStages = vi.fn()
  render(<WorkflowPane workflows={[wf]} onCreate={() => {}} onDelete={() => {}} onUpdateWorkflow={() => {}} onUpdateStagePrompts={() => {}} onUpdateStages={onUpdateStages} />)
  fireEvent.click(screen.getByText('技术方案设计').closest('.wf-stage-chip')!)
  fireEvent.change(screen.getByPlaceholderText(/额外要求/), { target: { value: '画时序图' } })
  fireEvent.click(screen.getByText('保存阶段'))
  expect(onUpdateStages).toHaveBeenCalledTimes(1)
  const [id, stages] = onUpdateStages.mock.calls[0]
  expect(id).toBe('standard')
  expect(stages[0]).toMatchObject({ key: 'design', prompt: '画时序图' })
})

it('新增自定义阶段 → onUpdateStages 追加一个 custom-* 阶段', () => {
  const onUpdateStages = vi.fn()
  render(<WorkflowPane workflows={[wf]} onCreate={() => {}} onDelete={() => {}} onUpdateWorkflow={() => {}} onUpdateStagePrompts={() => {}} onUpdateStages={onUpdateStages} />)
  fireEvent.click(screen.getByTitle('新增阶段'))
  // the saved-workflow add-picker's 自定义 button (the new-flow draft has one too)
  fireEvent.click(screen.getAllByText('+ 自定义阶段').find(b => b.closest('.wf-add-picker'))!)
  expect(onUpdateStages).toHaveBeenCalledTimes(1)
  const [, stages] = onUpdateStages.mock.calls[0]
  expect(stages.length).toBe(2)
  expect(stages[1].key).toMatch(/^custom-/)
})

it('内置阶段编辑器显示只读基座提示词', () => {
  const onUpdateStages = vi.fn()
  render(<WorkflowPane workflows={[wf]} onCreate={() => {}} onDelete={() => {}} onUpdateWorkflow={() => {}} onUpdateStagePrompts={() => {}} onUpdateStages={onUpdateStages} />)
  fireEvent.click(screen.getByText('技术方案设计').closest('.wf-stage-chip')!)
  expect(screen.getByText('内置提示词(不可改)')).toBeInTheDocument()
  // behavior flags are present
  expect(screen.getByText('人工门控')).toBeInTheDocument()
  expect(screen.getByText('按项目拆分')).toBeInTheDocument()
})
