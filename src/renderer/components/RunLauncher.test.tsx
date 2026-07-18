import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RunLauncher } from './RunLauncher'

const launchInfo = vi.fn()
const startWorkflow = vi.fn()

beforeEach(() => {
  launchInfo.mockReset()
  startWorkflow.mockReset()
  ;(window as any).forge = {
    run2: {
      launchInfo,
      startWorkflow,
    },
  }
})

describe('RunLauncher', () => {
  it('renders workflow name, both project checkboxes, and a seed textarea after mount', async () => {
    launchInfo.mockResolvedValue({
      workflows: [{ id: 'wf1', name: '标准五段' }],
      projects: [{ name: 'api', cwd: '/ws/api' }, { name: 'web', cwd: '/ws/web' }],
    })
    render(<RunLauncher workspacePath="/ws" />)
    expect(launchInfo).toHaveBeenCalledWith('/ws')
    await waitFor(() => expect(screen.getByText('标准五段')).toBeInTheDocument())
    expect(screen.getByLabelText('api')).toBeInTheDocument()
    expect(screen.getByLabelText('web')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('starts the workflow with the picked workflowId, checked projectNames, and typed task', async () => {
    launchInfo.mockResolvedValue({
      workflows: [{ id: 'wf1', name: '标准五段' }],
      projects: [{ name: 'api', cwd: '/ws/api' }, { name: 'web', cwd: '/ws/web' }],
    })
    const onStarted = vi.fn()
    render(<RunLauncher workspacePath="/ws" onStarted={onStarted} />)
    await waitFor(() => expect(screen.getByText('标准五段')).toBeInTheDocument())

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '加一个登录页' } })
    fireEvent.click(screen.getByLabelText('web'))
    fireEvent.click(screen.getByText('启动'))

    await waitFor(() => expect(startWorkflow).toHaveBeenCalled())
    expect(startWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/ws',
      workflowId: 'wf1',
      projectNames: ['api'],
      task: '加一个登录页',
      runId: expect.stringMatching(/^run2-/),
    }))
    await waitFor(() => expect(onStarted).toHaveBeenCalled())
  })

  // Task 2 (queue): manager.start() now returns a union — {status:'started'} vs {status:'queued'}.
  // A queued start must NOT switch the caller into the run view (there's no active run for THIS
  // launch yet), and must surface a local "已加入队列" note instead.
  it('shows a queued note and does not call onStarted when startWorkflow resolves status:"queued"', async () => {
    launchInfo.mockResolvedValue({
      workflows: [{ id: 'wf1', name: '标准五段' }],
      projects: [{ name: 'api', cwd: '/ws/api' }],
    })
    startWorkflow.mockResolvedValue({ status: 'queued', position: 2 })
    const onStarted = vi.fn()
    render(<RunLauncher workspacePath="/ws" onStarted={onStarted} />)
    await waitFor(() => expect(screen.getByText('标准五段')).toBeInTheDocument())

    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => expect(startWorkflow).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('已加入队列（位置 2），等待当前工作流完成')).toBeInTheDocument())
    expect(onStarted).not.toHaveBeenCalled()
  })

  it('calls onStarted (as before) when startWorkflow resolves status:"started"', async () => {
    launchInfo.mockResolvedValue({
      workflows: [{ id: 'wf1', name: '标准五段' }],
      projects: [{ name: 'api', cwd: '/ws/api' }],
    })
    startWorkflow.mockResolvedValue({ status: 'started', state: { status: 'running' } })
    const onStarted = vi.fn()
    render(<RunLauncher workspacePath="/ws" onStarted={onStarted} />)
    await waitFor(() => expect(screen.getByText('标准五段')).toBeInTheDocument())

    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => expect(onStarted).toHaveBeenCalled())
    expect(screen.queryByText(/已加入队列/)).not.toBeInTheDocument()
  })

  it('shows a placeholder and disables the start button when the workspace has no workflows', async () => {
    launchInfo.mockResolvedValue({ workflows: [], projects: [] })
    render(<RunLauncher workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('该工作区暂无工作流')).toBeInTheDocument())
    expect(screen.getByText('启动')).toBeDisabled()
  })

  it('renders a safe placeholder when window.forge.run2 is absent', () => {
    ;(window as any).forge = {}
    render(<RunLauncher workspacePath="/ws" />)
    expect(screen.getByText('该工作区暂无工作流')).toBeInTheDocument()
  })

  it('displays an error and re-enables the button when startWorkflow rejects', async () => {
    const errorMsg = '工作流没有可执行阶段'
    launchInfo.mockResolvedValue({
      workflows: [{ id: 'wf1', name: '标准五段' }],
      projects: [{ name: 'api', cwd: '/ws/api' }],
    })
    startWorkflow.mockRejectedValue(new Error(errorMsg))
    render(<RunLauncher workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('标准五段')).toBeInTheDocument())

    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => expect(screen.getByText(errorMsg)).toBeInTheDocument())
    expect(screen.getByText('启动')).not.toBeDisabled()
  })

  it('displays an error message when launchInfo rejects', async () => {
    launchInfo.mockRejectedValue(new Error('network failed'))
    render(<RunLauncher workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('加载工作流失败')).toBeInTheDocument())
    expect(screen.getByText('启动')).toBeDisabled()
  })

  // Task 2: opened from a workflow "/" command in chat, the launcher is pre-seeded with the picked
  // workflow + the current conversation transcript, so the user doesn't retype context.
  it('prefills the seed textarea and preselects the workflow from initialSeed/initialWorkflowId', async () => {
    launchInfo.mockResolvedValue({
      workflows: [{ id: 'wf0', name: '其他工作流' }, { id: 'wf1', name: '标准五段' }],
      projects: [{ name: 'api', cwd: '/ws/api' }],
    })
    render(<RunLauncher workspacePath="/ws" initialSeed="我: 做个登录页" initialWorkflowId="wf1" />)
    await waitFor(() => expect(screen.getByText('标准五段')).toBeInTheDocument())
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('我: 做个登录页')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('wf1')
  })

  // Task 2: the launcher renders the SELECTED workflow's stage flow (from LaunchInfo.workflows[].stages,
  // added by Task 1) so the user can see what a workflow actually does before starting it.
  it('renders the selected workflow stage flow (name, provider·model, gate badge) and updates it on workflow switch', async () => {
    launchInfo.mockResolvedValue({
      workflows: [
        {
          id: 'wf1',
          name: '标准五段',
          stages: [
            { key: 'design', name: '技术方案设计', provider: 'codex', model: 'gpt-x', gate: true },
            { key: 'develop', name: '代码开发', provider: 'codex', model: 'gpt-x', gate: false },
          ],
        },
        {
          id: 'wf2',
          name: '快速迭代',
          stages: [
            { key: 'quick', name: '直接开发', provider: 'claude', model: 'sonnet', gate: false },
          ],
        },
      ],
      projects: [{ name: 'api', cwd: '/ws/api' }],
    })
    render(<RunLauncher workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('标准五段')).toBeInTheDocument())

    // Both wf1 stages render with a provider·model chip.
    expect(screen.getByText('技术方案设计')).toBeInTheDocument()
    expect(screen.getByText('代码开发')).toBeInTheDocument()
    expect(screen.getAllByText(/codex.*gpt-x/)).toHaveLength(2)

    // Only the gated stage gets a gate badge.
    const designRow = screen.getByText('技术方案设计').closest('.run2-launch-stage')!
    const developRow = screen.getByText('代码开发').closest('.run2-launch-stage')!
    expect(designRow.querySelector('.run2-launch-stage-gate')).not.toBeNull()
    expect(developRow.querySelector('.run2-launch-stage-gate')).toBeNull()

    // Switching the workflow select swaps the rendered stage flow.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'wf2' } })
    await waitFor(() => expect(screen.getByText('直接开发')).toBeInTheDocument())
    expect(screen.queryByText('技术方案设计')).not.toBeInTheDocument()
    expect(screen.queryByText('代码开发')).not.toBeInTheDocument()
    expect(screen.getByText(/claude.*sonnet/)).toBeInTheDocument()
  })

  it('shows a placeholder note when the selected workflow has no stages', async () => {
    launchInfo.mockResolvedValue({
      workflows: [{ id: 'wf1', name: '空流程', stages: [] }],
      projects: [{ name: 'api', cwd: '/ws/api' }],
    })
    render(<RunLauncher workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('空流程')).toBeInTheDocument())
    expect(screen.getByText('（无阶段）')).toBeInTheDocument()
  })

  // Task 2: project selection moved from checkboxes to toggle chips, but the accessible name +
  // start-time projectNames contract is unchanged.
  it('toggles project chips and only starts with the ones still checked', async () => {
    launchInfo.mockResolvedValue({
      workflows: [{ id: 'wf1', name: '标准五段', stages: [] }],
      projects: [{ name: 'api', cwd: '/ws/api' }, { name: 'web', cwd: '/ws/web' }],
    })
    render(<RunLauncher workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('标准五段')).toBeInTheDocument())

    const apiChip = screen.getByLabelText('api')
    const webChip = screen.getByLabelText('web')
    expect(apiChip).toHaveAttribute('aria-pressed', 'true')
    expect(webChip).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(webChip)
    expect(webChip).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => expect(startWorkflow).toHaveBeenCalled())
    expect(startWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      projectNames: ['api'],
    }))
  })
})
