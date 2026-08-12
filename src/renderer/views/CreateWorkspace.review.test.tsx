import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CreateWorkspace } from './CreateWorkspace'

const workflows = [{ id: 'standard', name: '标准工作流', stages: [
  { key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
  { key: 'review', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
], plugins: [] }]
const providers = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'gpt-5-codex', label: 'gpt-5-codex' }] },
]
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
  it('defaults enabled review stage to 并行多视角 (all four lenses) in create opts — ②多镜头CR', () => {
    const onCreate = setup()
    expect(screen.getByText('单 agent 全量')).toBeInTheDocument()
    expect(screen.getByText('并行 · 按项目')).toBeInTheDocument()
    expect(screen.getByText('并行 · 按视角')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /创建/ }))
    const review = onCreate.mock.calls[0][0].workflows[0].stages.find((s: any) => s.key === 'review')
    expect(review.review).toEqual({ mode: 'parallel', reviewers: ['correctness', 'security', 'performance', 'style'] })
  })

  it('selecting single agent writes review.mode=single', () => {
    const onCreate = setup()
    fireEvent.click(screen.getByText('单 agent 全量'))
    fireEvent.click(screen.getByRole('button', { name: /创建/ }))

    const review = onCreate.mock.calls[0][0].workflows[0].stages.find((s: any) => s.key === 'review')
    expect(review.review).toEqual({ mode: 'single' })
  })
})

// 用户诉求:claude 开发 + codex CR,而且要写进工作区(不然每次启动都得重设、两处还会不一致)。
// CR 选「并行 · 按项目」时,每个项目的 reviewer 可以单独挑编码代理,与代码开发那份互不影响。
describe('CreateWorkspace 按项目 CR 的逐项目编码代理', () => {
  const pickProject = () => fireEvent.click(screen.getByText('proj1'))

  it('切到「并行 · 按项目」后为每个项目给出编码代理下拉', () => {
    setup()
    pickProject()
    expect(document.querySelector('[data-strev-pm="proj1"]')).toBeNull()   // 默认按视角,不出现
    fireEvent.click(screen.getByText('并行 · 按项目'))
    expect(document.querySelector('[data-strev-pm="proj1"]')).toBeTruthy()
  })

  it('给某项目选了 codex 后落进该阶段的 projectAgents,代码开发的项目模型不受影响', () => {
    const onCreate = setup()
    pickProject()
    fireEvent.click(screen.getByText('并行 · 按项目'))
    fireEvent.change(document.querySelector('[data-strev-pm="proj1"]')!, { target: { value: 'codex::gpt-5-codex' } })
    fireEvent.click(screen.getByRole('button', { name: /创建/ }))
    const opts = onCreate.mock.calls[0][0]
    const review = opts.workflows[0].stages.find((s: any) => s.key === 'review')
    expect(review.projectAgents).toEqual([{ name: 'proj1', provider: 'codex', model: 'gpt-5-codex' }])
    // 项目自己的编码代理(= 代码开发用的)没被动
    expect(opts.projects[0]).toMatchObject({ repoId: 'proj1', provider: 'claude', model: 'opus-4.8' })
  })

  it('没单独选过就不写 projectAgents(老工作区零变化)', () => {
    const onCreate = setup()
    pickProject()
    fireEvent.click(screen.getByText('并行 · 按项目'))
    fireEvent.click(screen.getByRole('button', { name: /创建/ }))
    const review = onCreate.mock.calls[0][0].workflows[0].stages.find((s: any) => s.key === 'review')
    expect(review.projectAgents).toBeUndefined()
  })
})
