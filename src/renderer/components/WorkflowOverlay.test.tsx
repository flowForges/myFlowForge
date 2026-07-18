import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkflowOverlay } from './WorkflowOverlay'

const launchInfo = vi.fn()

beforeEach(() => {
  launchInfo.mockReset()
  ;(window as any).forge = {
    run2: {
      launchInfo,
    },
  }
})

const LAUNCH_INFO = {
  workflows: [
    { id: 'wf-standard', name: '标准工作流', stages: [{ key: 'assess' }, { key: 'design' }, { key: 'develop' }] },
    { id: 'wf-quick', name: '快速修复', stages: [{ key: 'assess' }, { key: 'develop' }] },
  ],
  projects: [{ name: 'api', cwd: '/ws/api' }],
}

describe('WorkflowOverlay', () => {
  it('renders one .wfo-tab per workflow, first selected by default', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    const { container } = render(<WorkflowOverlay workspacePath="/ws" onClose={vi.fn()} />)
    expect(launchInfo).toHaveBeenCalledWith('/ws')
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(2))
    const tabs = container.querySelectorAll('.wfo-tab')
    expect(tabs[0]).toHaveClass('on')
    expect(tabs[1]).not.toHaveClass('on')
    expect(tabs[0].textContent).toContain('标准工作流')
    expect(tabs[0].querySelector('.n')?.textContent).toBe('3')
  })

  it('clicking the second tab makes it .on and unsets the first', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    const { container } = render(<WorkflowOverlay workspacePath="/ws" onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(2))
    const tabs = container.querySelectorAll('.wfo-tab')
    fireEvent.click(tabs[1])
    expect(tabs[1]).toHaveClass('on')
    expect(tabs[0]).not.toHaveClass('on')
  })

  it('disables the 启动 button when goal is empty, enables it after typing', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    const { container } = render(<WorkflowOverlay workspacePath="/ws" onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(2))
    const startBtn = container.querySelector('.wfo-start') as HTMLButtonElement
    expect(startBtn).toBeDisabled()

    const textarea = container.querySelector('.wfo-goal textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '把 tokens 迁移到 OKLch' } })
    expect(startBtn).not.toBeDisabled()
  })

  it('prefills the goal textarea from initialSeed', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    const { container } = render(<WorkflowOverlay workspacePath="/ws" initialSeed="我: 做个登录页" onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(2))
    const textarea = container.querySelector('.wfo-goal textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('我: 做个登录页')
    expect(container.querySelector('.wfo-start')).not.toBeDisabled()
  })

  it('calls onClose when clicking the scrim', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    const onClose = vi.fn()
    const { container } = render(<WorkflowOverlay workspacePath="/ws" onClose={onClose} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(2))
    fireEvent.click(container.querySelector('.wfo-scrim')!)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when clicking the .wfo-x close button', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    const onClose = vi.fn()
    const { container } = render(<WorkflowOverlay workspacePath="/ws" onClose={onClose} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(2))
    fireEvent.click(container.querySelector('.wfo-x')!)
    expect(onClose).toHaveBeenCalled()
  })

  it('renders the legend with 5 items and the head title/hint text', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    const { container } = render(<WorkflowOverlay workspacePath="/ws" onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(2))
    expect(container.querySelectorAll('.wfo-legend i')).toHaveLength(5)
    expect(screen.getByText('开启工作流')).toBeInTheDocument()
    expect(screen.getByText('选择流程 · 配置模块 · 下达目标')).toBeInTheDocument()
  })

  it('renders a safe empty state when window.forge.run2 is absent', () => {
    ;(window as any).forge = {}
    const { container } = render(<WorkflowOverlay workspacePath="/ws" onClose={vi.fn()} />)
    expect(container.querySelectorAll('.wfo-tab')).toHaveLength(0)
  })
})
