import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkflowPane } from './WorkflowPane'

const wf = { id: 'standard', name: '标准', stages: [{ key: 'design' }], plugins: [], stagePrompts: {} } as any

it('点阶段 chip 编辑追加段 → onUpdateStagePrompts(id, map)', () => {
  const onUpdateStagePrompts = vi.fn()
  render(<WorkflowPane workflows={[wf]} onCreate={() => {}} onDelete={() => {}} onUpdateWorkflow={() => {}} onUpdateStagePrompts={onUpdateStagePrompts} />)
  fireEvent.click(screen.getByTitle(/编辑「技术方案设计」/))
  fireEvent.change(screen.getByPlaceholderText(/必须画时序图/), { target: { value: '画时序图' } })
  fireEvent.click(screen.getByText('保存'))
  expect(onUpdateStagePrompts).toHaveBeenCalledWith('standard', { design: '画时序图' })
})

it('清空追加 → map 删除该 key', () => {
  const onUpdateStagePrompts = vi.fn()
  const wf2 = { ...wf, stagePrompts: { design: '旧' } }
  render(<WorkflowPane workflows={[wf2]} onCreate={() => {}} onDelete={() => {}} onUpdateWorkflow={() => {}} onUpdateStagePrompts={onUpdateStagePrompts} />)
  fireEvent.click(screen.getByTitle(/编辑「技术方案设计」/))
  fireEvent.click(screen.getByText('清空追加'))
  fireEvent.click(screen.getByText('保存'))
  expect(onUpdateStagePrompts).toHaveBeenCalledWith('standard', {})
})
