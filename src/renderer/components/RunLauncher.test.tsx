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
})
