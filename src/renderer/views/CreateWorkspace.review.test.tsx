import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CreateWorkspace } from './CreateWorkspace'

const workflows = [{ id: 'standard', name: '标准工作流', stages: [
  { key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
  { key: 'review', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
], plugins: [] }]
const providers = [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }]
const projects = [{ id: 'proj1', name: 'proj1', repoUrl: 'git@x:y/proj1.git', defaultBranch: 'main' }]

function setup(onCreate = vi.fn()) {
  render(
    <CreateWorkspace
      open
      onCancel={() => {}}
      onCreate={onCreate}
      projects={projects}
      workflows={workflows}
      providers={providers}
      onOpenProjectSettings={() => {}}
      onNewWorkflow={() => {}}
    />,
  )
  fireEvent.change(screen.getByPlaceholderText(/~\/code|路径/i), { target: { value: '~/code/ws-review' } })
  return onCreate
}

describe('CreateWorkspace review CR mode', () => {
  it('defaults enabled review stage to parallel/per-project in create opts', () => {
    const onCreate = setup()
    expect(screen.getByText('单 agent 全量')).toBeInTheDocument()
    expect(screen.getByText('并行 · 按项目')).toBeInTheDocument()
    expect(screen.getByText('并行 · 按视角')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /创建/ }))
    const review = onCreate.mock.calls[0][0].workflows[0].stages.find((s: any) => s.key === 'review')
    expect(review.review).toEqual({ mode: 'parallel', scope: 'per-project' })
  })

  it('selecting single agent writes review.mode=single', () => {
    const onCreate = setup()
    fireEvent.click(screen.getByText('单 agent 全量'))
    fireEvent.click(screen.getByRole('button', { name: /创建/ }))

    const review = onCreate.mock.calls[0][0].workflows[0].stages.find((s: any) => s.key === 'review')
    expect(review.review).toEqual({ mode: 'single' })
  })
})
