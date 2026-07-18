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

function stage(overrides: Partial<Record<string, unknown>> & { key: string }) {
  return {
    name: overrides.key as string,
    provider: 'claude',
    model: 'opus',
    gate: false,
    code: false,
    desc: '',
    prompt: '',
    ...overrides,
  }
}

const LAUNCH_INFO = {
  workflows: [
    {
      id: 'wf-standard',
      name: '标准工作流',
      stages: [stage({ key: 'assess' }), stage({ key: 'design' }), stage({ key: 'develop', code: true })],
    },
    { id: 'wf-quick', name: '快速修复', stages: [stage({ key: 'assess' }), stage({ key: 'develop', code: true })] },
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

describe('WorkflowOverlay config-state flowchart (Task 3)', () => {
  const CHART_INFO = {
    workflows: [
      {
        id: 'wf-standard',
        name: '标准工作流',
        stages: [
          {
            key: 'requirement',
            name: '需求评审',
            provider: 'claude',
            model: 'opus',
            gate: false,
            code: false,
            desc: '拆解需求 · 明确范围与验收标准',
            prompt: '拆解本次需求',
          },
          {
            key: 'develop',
            name: '代码开发',
            provider: 'codex',
            model: 'gpt-5-codex',
            gate: true,
            code: true,
            desc: '按方案实现变更',
            prompt: '按技术方案实现代码变更',
          },
        ],
      },
      {
        id: 'wf-quick',
        name: '快速修复',
        stages: [
          {
            key: 'requirement',
            name: '需求评审',
            provider: 'claude',
            model: 'opus',
            gate: false,
            code: false,
            desc: '拆解需求',
            prompt: '拆解本次需求',
          },
        ],
      },
    ],
    projects: [],
  }

  it('renders start/end terminals, one .wfo-node per stage, connectors between them, and .wfo-mode.code for code stages', async () => {
    launchInfo.mockResolvedValue(CHART_INFO)
    const { container } = render(<WorkflowOverlay workspacePath="/ws" onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-node')).toHaveLength(2))

    expect(container.querySelector('.wfo-term.start')).toBeInTheDocument()
    expect(container.querySelector('.wfo-term.end')).toBeInTheDocument()
    // one connector before the first node + one after each node (stages.length + 1)
    expect(container.querySelectorAll('.wfo-conn')).toHaveLength(3)

    expect(screen.getByText('需求评审')).toBeInTheDocument()
    expect(screen.getByText('代码开发')).toBeInTheDocument()

    const nodes = container.querySelectorAll('.wfo-node')
    const requirementMode = nodes[0].querySelector('.wfo-mode')
    const developMode = nodes[1].querySelector('.wfo-mode')
    expect(requirementMode).not.toHaveClass('code')
    expect(developMode).toHaveClass('code')
    // gate:true stage shows a gate marker; gate:false does not
    expect(nodes[0].querySelector('.wfo-gate')).toBeNull()
    expect(nodes[1].querySelector('.wfo-gate')).not.toBeNull()
    // code stage gets a read-only model summary chip, non-code stage gets an editable one
    expect(nodes[0].querySelector('.wfo-model.ro')).toBeNull()
    expect(nodes[1].querySelector('.wfo-model.ro')).not.toBeNull()
  })

  it('clicking a node header toggles .open on that node', async () => {
    launchInfo.mockResolvedValue(CHART_INFO)
    const { container } = render(<WorkflowOverlay workspacePath="/ws" onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-node')).toHaveLength(2))

    const nodes = container.querySelectorAll('.wfo-node')
    const developHead = nodes[1].querySelector('.wfo-cardhead') as HTMLElement
    expect(nodes[1]).not.toHaveClass('open')
    fireEvent.click(developHead)
    expect(nodes[1]).toHaveClass('open')
    fireEvent.click(developHead)
    expect(nodes[1]).not.toHaveClass('open')
  })

  it('switching the workflow tab re-renders the chart for that workflow', async () => {
    launchInfo.mockResolvedValue(CHART_INFO)
    const { container } = render(<WorkflowOverlay workspacePath="/ws" onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-node')).toHaveLength(2))

    const tabs = container.querySelectorAll('.wfo-tab')
    fireEvent.click(tabs[1])
    await waitFor(() => expect(container.querySelectorAll('.wfo-node')).toHaveLength(1))
  })
})

describe('WorkflowOverlay node body (Task 4)', () => {
  const BODY_INFO = {
    workflows: [
      {
        id: 'wf-standard',
        name: '标准工作流',
        stages: [
          {
            key: 'requirement',
            name: '需求评审',
            provider: 'claude',
            model: 'opus',
            gate: false,
            code: false,
            desc: '拆解需求',
            prompt: '拆解本次需求，明确范围与验收标准',
          },
          {
            key: 'develop',
            name: '代码开发',
            provider: 'codex',
            model: 'gpt-5-codex',
            gate: true,
            code: true,
            desc: '按方案实现变更',
            prompt: '按技术方案实现代码变更',
          },
        ],
      },
    ],
    projects: [
      { name: 'api', cwd: '/ws/api', provider: 'claude', model: 'sonnet' },
      { name: 'web', cwd: '/ws/web' },
      { name: 'infra', cwd: '/ws/infra' },
    ],
  }

  async function renderExpanded(nodeIndex: number) {
    launchInfo.mockResolvedValue(BODY_INFO)
    const { container } = render(<WorkflowOverlay workspacePath="/ws" onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-node')).toHaveLength(2))
    const nodes = container.querySelectorAll('.wfo-node')
    fireEvent.click(nodes[nodeIndex].querySelector('.wfo-cardhead') as HTMLElement)
    return { container, nodes }
  }

  it('expanding the code stage shows prompt + all projects selected by default + per-project model chips', async () => {
    const { nodes } = await renderExpanded(1)
    const body = nodes[1].querySelector('.wfo-cardbody') as HTMLElement

    expect(body.querySelector('.wfo-prompt')?.textContent).toBe('按技术方案实现代码变更')

    const projRows = body.querySelectorAll('.wfo-proj')
    expect(projRows).toHaveLength(3)
    projRows.forEach((row) => expect(row).toHaveClass('on'))
    expect(body.querySelector('.wfo-sec-h .c')?.textContent).toBe('已选 3 / 3')
    // every selected project shows its own model chip
    expect(body.querySelectorAll('.wfo-model.sm')).toHaveLength(3)
  })

  it('clicking a project .wfo-ckhit toggles it off, drops its model chip, and updates the selected count', async () => {
    const { nodes } = await renderExpanded(1)
    const body = nodes[1].querySelector('.wfo-cardbody') as HTMLElement

    const firstHit = body.querySelector('.wfo-ckhit[data-proj="develop::api"]') as HTMLElement
    fireEvent.click(firstHit)

    const projRows = body.querySelectorAll('.wfo-proj')
    expect(projRows[0]).not.toHaveClass('on')
    expect(projRows[1]).toHaveClass('on')
    expect(projRows[2]).toHaveClass('on')
    expect(body.querySelector('.wfo-sec-h .c')?.textContent).toBe('已选 2 / 3')
    expect(body.querySelectorAll('.wfo-model.sm')).toHaveLength(2)
    expect(projRows[0].querySelector('.wfo-model.sm')).toBeNull()

    // clicking again re-selects it
    fireEvent.click(firstHit)
    expect(projRows[0]).toHaveClass('on')
    expect(body.querySelector('.wfo-sec-h .c')?.textContent).toBe('已选 3 / 3')
  })

  it('expanding a non-code stage shows only 阶段指令, no project section', async () => {
    const { nodes } = await renderExpanded(0)
    const body = nodes[0].querySelector('.wfo-cardbody') as HTMLElement

    expect(body.querySelector('.wfo-prompt')?.textContent).toBe('拆解本次需求，明确范围与验收标准')
    expect(body.querySelectorAll('.wfo-sec')).toHaveLength(1)
    expect(body.querySelector('.wfo-proj')).toBeNull()
  })

  it('clicking a per-project model chip cycles its model label', async () => {
    const { nodes } = await renderExpanded(1)
    const body = nodes[1].querySelector('.wfo-cardbody') as HTMLElement

    const chip = body.querySelector('.wfo-model.sm[data-pmodel="develop::api"]') as HTMLElement
    const before = chip.querySelector('.mv')?.textContent
    fireEvent.click(chip)
    const after = body.querySelector('.wfo-model.sm[data-pmodel="develop::api"] .mv')?.textContent
    expect(after).not.toBe(before)
  })

  it('clicking a non-code stage header model chip cycles its stage model label', async () => {
    const { nodes } = await renderExpanded(0)
    const chip = nodes[0].querySelector('.wfo-cardhead .wfo-model[data-model="requirement"]') as HTMLElement
    const before = chip.querySelector('.mv')?.textContent
    fireEvent.click(chip)
    const after = (nodes[0].querySelector('.wfo-cardhead .wfo-model[data-model="requirement"] .mv') as HTMLElement)
      .textContent
    expect(after).not.toBe(before)
    // clicking the model chip must not also toggle node open/closed
    expect(nodes[0]).toHaveClass('open')
  })
})
