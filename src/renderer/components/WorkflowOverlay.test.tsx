import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkflowOverlay } from './WorkflowOverlay'

const launchInfo = vi.fn()
const startWorkflow = vi.fn()

// B1 (WF-B): every existing (WF-A) test constructs the overlay in CONFIG mode — run2.state === null.
// The new run-mode describe block below builds its own run2 (state !== null) via this same helper.
function makeRun2(state: any = null) {
  return {
    state,
    laneLogs: {},
    queueLength: 0,
    resolveGate: vi.fn(),
    resolveLane: vi.fn(),
    addFeedback: vi.fn(),
    editFeedback: vi.fn(),
    removeFeedback: vi.fn(),
    abort: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    jumpBack: vi.fn(),
  }
}
const configRun2 = makeRun2(null)

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
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={configRun2} onClose={vi.fn()} />)
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
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={configRun2} onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(2))
    const tabs = container.querySelectorAll('.wfo-tab')
    fireEvent.click(tabs[1])
    expect(tabs[1]).toHaveClass('on')
    expect(tabs[0]).not.toHaveClass('on')
  })

  it('disables the 启动 button when goal is empty, enables it after typing', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={configRun2} onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(2))
    const startBtn = container.querySelector('.wfo-start') as HTMLButtonElement
    expect(startBtn).toBeDisabled()

    const textarea = container.querySelector('.wfo-goal textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '把 tokens 迁移到 OKLch' } })
    expect(startBtn).not.toBeDisabled()
  })

  it('prefills the goal textarea from initialSeed', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    const { container } = render(<WorkflowOverlay workspacePath="/ws" initialSeed="我: 做个登录页" run2={configRun2} onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(2))
    const textarea = container.querySelector('.wfo-goal textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('我: 做个登录页')
    expect(container.querySelector('.wfo-start')).not.toBeDisabled()
  })

  it('calls onClose when clicking the scrim', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    const onClose = vi.fn()
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={configRun2} onClose={onClose} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(2))
    fireEvent.click(container.querySelector('.wfo-scrim')!)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when clicking the .wfo-x close button', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    const onClose = vi.fn()
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={configRun2} onClose={onClose} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(2))
    fireEvent.click(container.querySelector('.wfo-x')!)
    expect(onClose).toHaveBeenCalled()
  })

  it('renders the legend with 5 items and the head title/hint text', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={configRun2} onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(2))
    expect(container.querySelectorAll('.wfo-legend i')).toHaveLength(5)
    expect(screen.getByText('开启工作流')).toBeInTheDocument()
    expect(screen.getByText('选择流程 · 配置模块 · 下达目标')).toBeInTheDocument()
  })

  it('renders a safe empty state when window.forge.run2 is absent', () => {
    ;(window as any).forge = {}
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={configRun2} onClose={vi.fn()} />)
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
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={configRun2} onClose={vi.fn()} />)
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
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={configRun2} onClose={vi.fn()} />)
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
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={configRun2} onClose={vi.fn()} />)
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
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={configRun2} onClose={vi.fn()} />)
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

describe('WorkflowOverlay launch wiring (Task 5)', () => {
  it('prefills goal from initialSeed and clicking 启动 calls startWorkflow with workflowId/projectNames/task/runId, then onStarted on {status:"started"}', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    startWorkflow.mockResolvedValue({ status: 'started', state: {} })
    const onStarted = vi.fn()
    const { container } = render(
      <WorkflowOverlay workspacePath="/ws" initialSeed="我: 做个登录页" run2={configRun2} onClose={vi.fn()} onStarted={onStarted} />
    )
    // Wait for the flowchart nodes (not just the tabs) so the projSel-init effect (which the
    // handleStart projectNames union reads) has definitely run before we click 启动 — see Task 4's
    // tests, which rely on the same sync point.
    await waitFor(() => expect(container.querySelectorAll('.wfo-node')).toHaveLength(3))

    const textarea = container.querySelector('.wfo-goal textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('我: 做个登录页')

    const startBtn = container.querySelector('.wfo-start') as HTMLButtonElement
    expect(startBtn).not.toBeDisabled()
    fireEvent.click(startBtn)

    await waitFor(() => expect(startWorkflow).toHaveBeenCalledTimes(1))
    const arg = startWorkflow.mock.calls[0][0]
    expect(arg.workspacePath).toBe('/ws')
    expect(arg.workflowId).toBe('wf-standard')
    expect(arg.projectNames).toEqual(['api'])
    expect(arg.task).toBe('我: 做个登录页')
    expect(typeof arg.runId).toBe('string')
    expect(arg.runId.length).toBeGreaterThan(0)

    await waitFor(() => expect(onStarted).toHaveBeenCalled())
  })

  it('shows a queued note and does NOT call onStarted when startWorkflow resolves {status:"queued"}', async () => {
    launchInfo.mockResolvedValue(LAUNCH_INFO)
    startWorkflow.mockResolvedValue({ status: 'queued', position: 2 })
    const onStarted = vi.fn()
    const { container } = render(
      <WorkflowOverlay workspacePath="/ws" initialSeed="做个功能" run2={configRun2} onClose={vi.fn()} onStarted={onStarted} />
    )
    await waitFor(() => expect(container.querySelectorAll('.wfo-node')).toHaveLength(3))

    fireEvent.click(container.querySelector('.wfo-start') as HTMLButtonElement)

    await waitFor(() => expect(startWorkflow).toHaveBeenCalledTimes(1))
    expect(onStarted).not.toHaveBeenCalled()
    await waitFor(() => expect(container.textContent).toContain('位置'))
  })
})

describe('WorkflowOverlay run state (Task B1)', () => {
  const RUN_LAUNCH_INFO = {
    workflows: [
      {
        id: 'wf-standard',
        name: '标准工作流',
        stages: [
          stage({ key: 'design', name: '技术方案设计', desc: '设计技术方案' }),
          stage({ key: 'develop', name: '代码开发', code: true, desc: '按方案实现变更' }),
        ],
      },
    ],
    projects: [],
  }

  function runState(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      machine: {
        plan: {
          runId: 'run2-1',
          stages: [
            { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus', scope: 'root', gate: false },
            { key: 'develop', name: '代码开发', provider: 'codex', model: 'gpt-5-codex', scope: 'per-project', gate: true },
          ],
        },
        stages: [
          { key: 'design', status: 'done', round: 0 },
          { key: 'develop', status: 'running', round: 0 },
        ],
        currentIndex: 1,
      },
      inbox: [],
      feedback: [],
      outcomes: {},
      status: 'running',
      pendingDirective: {},
      liveLanes: {},
      stageTimings: { design: { startedAt: 1000, endedAt: 4000 }, develop: { startedAt: 5000 } },
      paused: false,
      ...overrides,
    }
  }

  it('renders .wfo-prog with doneN/total, run/done node classes + stat badges, and elapsed time for a finished stage', async () => {
    launchInfo.mockResolvedValue(RUN_LAUNCH_INFO)
    const run2 = makeRun2(runState())
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={run2} onClose={vi.fn()} />)

    await waitFor(() => expect(container.querySelectorAll('.wfo-node')).toHaveLength(2))

    expect(container.querySelector('.wfo-prog .lbl')?.textContent).toBe('已完成 1 / 2')
    expect(container.querySelector('.wfo-prog .pct')?.textContent).toBe('50%')

    const nodes = container.querySelectorAll('.wfo-node')
    const designNode = nodes[0]
    const developNode = nodes[1]

    expect(designNode).toHaveClass('done')
    expect(designNode.querySelector('.wfo-stat')).toHaveClass('ok')
    expect(designNode.querySelector('.wfo-time')?.textContent).toBe('3.0s')

    // develop is a code stage → B4 fans it out to a .wfo-group (the state class lives there, not
    // on the outer .wfo-node — see WorkflowOverlay code-stage fan-out lanes test).
    const developGroup = developNode.querySelector('.wfo-group') as HTMLElement
    expect(developGroup).toHaveClass('run')
    expect(developGroup.querySelector('.wfo-stat')).toHaveClass('run')

    // Config-mode-only chrome must be gone once running.
    expect(container.querySelector('.wfo-tabs')).toBeNull()
    expect(container.querySelector('.wfo-legend')).toBeNull()
  })

  it('config mode (run2.state === null) still renders tabs, not the progress bar', async () => {
    launchInfo.mockResolvedValue(RUN_LAUNCH_INFO)
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={configRun2} onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-tab')).toHaveLength(1))
    expect(container.querySelector('.wfo-prog')).toBeNull()
  })
})

describe('WorkflowOverlay run node body (Task B2)', () => {
  const RUN_BODY_LAUNCH_INFO = {
    workflows: [
      {
        id: 'wf-standard',
        name: '标准工作流',
        stages: [
          stage({ key: 'design', name: '技术方案设计', desc: '设计技术方案', prompt: '设计技术方案，输出模块划分' }),
          stage({ key: 'develop', name: '代码开发', code: true, desc: '按方案实现变更', prompt: '按技术方案实现代码变更' }),
        ],
      },
    ],
    projects: [],
  }

  function runningDesignState() {
    return {
      machine: {
        plan: {
          runId: 'run2-1',
          stages: [
            { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus', scope: 'root', gate: false },
            { key: 'develop', name: '代码开发', provider: 'codex', model: 'gpt-5-codex', scope: 'per-project', gate: true },
          ],
        },
        stages: [
          { key: 'design', status: 'running', round: 0 },
          { key: 'develop', status: 'pending', round: 0 },
        ],
        currentIndex: 0,
      },
      inbox: [],
      feedback: [],
      outcomes: {},
      status: 'running',
      pendingDirective: {},
      liveLanes: { 'design:root': { stageKey: 'design', state: 'run', cwd: '/ws' } },
      stageTimings: { design: { startedAt: 1000 } },
      paused: false,
    }
  }

  const scanContext = vi.fn()

  beforeEach(() => {
    scanContext.mockReset()
    scanContext.mockResolvedValue({
      skills: [{ name: 'brainstorming', path: '/x' }],
      rules: [],
      mcps: [{ name: 'forge', path: 'm' }],
    })
  })

  it('expanding a running non-code node shows LLM 输入/输出 + skill/mcp caps + blink cursor while running', async () => {
    launchInfo.mockResolvedValue(RUN_BODY_LAUNCH_INFO)
    ;(window as any).forge.scanContext = scanContext
    const run2 = makeRun2(runningDesignState())
    run2.laneLogs = {
      'design:root': [
        { laneId: 'design:root', stageKey: 'design', agentName: 'Codex', line: { ts: '', text: '技术方案草拟中', level: 'run', kind: 'output' } },
      ],
    }
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={run2} onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-node')).toHaveLength(2))

    const designNode = container.querySelectorAll('.wfo-node')[0]
    fireEvent.click(designNode.querySelector('.wfo-cardhead') as HTMLElement)

    await waitFor(() => expect(scanContext).toHaveBeenCalledWith('/ws'))
    const body = designNode.querySelector('.wfo-cardbody') as HTMLElement
    await waitFor(() => expect(body.textContent).toContain('技术方案草拟中'))

    expect(body.querySelector('.wfo-io.in')?.textContent).toBe('设计技术方案，输出模块划分')
    expect(body.querySelector('.wfo-cap.s')?.textContent).toContain('brainstorming')
    expect(body.querySelector('.wfo-cap.m')?.textContent).toContain('forge')
    expect(body.querySelector('.wfo-io:not(.in) .cur')).not.toBeNull()
  })
})

describe('WorkflowOverlay confirm/input inline actions (Task B3)', () => {
  const GATE_LAUNCH_INFO = {
    workflows: [
      {
        id: 'wf-standard',
        name: '标准工作流',
        stages: [
          stage({ key: 'design', name: '技术方案设计', desc: '设计技术方案', prompt: '设计技术方案' }),
          stage({ key: 'develop', name: '代码开发', code: true, desc: '按方案实现变更', prompt: '按技术方案实现代码变更' }),
        ],
      },
    ],
    projects: [],
  }

  function baseMachine() {
    return {
      plan: {
        runId: 'run2-1',
        stages: [
          { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus', scope: 'root', gate: true },
          { key: 'develop', name: '代码开发', provider: 'codex', model: 'gpt-5-codex', scope: 'per-project', gate: true },
        ],
      },
      stages: [
        { key: 'design', status: 'running', round: 0 },
        { key: 'develop', status: 'pending', round: 0 },
      ],
      currentIndex: 0,
    }
  }

  function confirmState() {
    return {
      machine: baseMachine(),
      inbox: [{ id: 'g1', kind: 'gate', stageKey: 'design', body: '方案已就绪' }],
      feedback: [],
      outcomes: {},
      status: 'running',
      pendingDirective: {},
      liveLanes: {},
      stageTimings: { design: { startedAt: 1000 } },
      paused: false,
    }
  }

  function inputState() {
    return {
      machine: baseMachine(),
      inbox: [{ id: 'q1', kind: 'question', stageKey: 'develop', title: '补充fixture路径' }],
      feedback: [],
      outcomes: {},
      status: 'running',
      pendingDirective: {},
      liveLanes: {},
      stageTimings: { design: { startedAt: 1000, endedAt: 2000 } },
      paused: false,
    }
  }

  it('confirm state renders .wfo-act with 确认继续/要求修改 wired to run2.resolveGate', async () => {
    launchInfo.mockResolvedValue(GATE_LAUNCH_INFO)
    const run2 = makeRun2(confirmState())
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={run2} onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-node')).toHaveLength(2))

    const designNode = container.querySelectorAll('.wfo-node')[0]
    expect(designNode).toHaveClass('confirm')
    fireEvent.click(designNode.querySelector('.wfo-cardhead') as HTMLElement)

    const act = designNode.querySelector('.wfo-act') as HTMLElement
    expect(act).not.toBeNull()
    expect(act.querySelector('.am')?.textContent).toBe('方案已就绪')

    fireEvent.click(act.querySelector('.wfo-btn.ghost') as HTMLElement)
    expect(run2.resolveGate).toHaveBeenCalledWith('g1', { type: 'redo' })

    fireEvent.click(act.querySelector('.wfo-btn.pri') as HTMLElement)
    expect(run2.resolveGate).toHaveBeenCalledWith('g1', { type: 'advance' })
  })

  it('input state renders .wfo-act with .wfo-inp + 提交 wired to run2.resolveLane', async () => {
    launchInfo.mockResolvedValue(GATE_LAUNCH_INFO)
    const run2 = makeRun2(inputState())
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={run2} onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-node')).toHaveLength(2))

    const developNode = container.querySelectorAll('.wfo-node')[1]
    // develop is a code stage → B4 fans it out to a .wfo-group; its .wfo-gact is always rendered
    // (no expand/collapse gate) once the stage is waiting on input — see B4's test.
    const developGroup = developNode.querySelector('.wfo-group') as HTMLElement
    expect(developGroup).toHaveClass('input')

    const act = developNode.querySelector('.wfo-act') as HTMLElement
    expect(act).not.toBeNull()
    expect(act.querySelector('.am')?.textContent).toBe('补充fixture路径')

    const input = act.querySelector('.wfo-inp') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'tests/fixtures/tokens/' } })
    fireEvent.click(act.querySelector('.wfo-btn.pri') as HTMLElement)
    expect(run2.resolveLane).toHaveBeenCalledWith('q1', { type: 'answer', value: 'tests/fixtures/tokens/' })
  })
})

describe('WorkflowOverlay code-stage fan-out lanes (Task B4)', () => {
  const FANOUT_LAUNCH_INFO = {
    workflows: [
      {
        id: 'wf-standard',
        name: '标准工作流',
        stages: [
          stage({ key: 'design', name: '技术方案设计', desc: '设计技术方案', prompt: '设计技术方案' }),
          stage({ key: 'develop', name: '代码开发', code: true, desc: '按方案实现变更', prompt: '按技术方案实现代码变更' }),
        ],
      },
    ],
    projects: [
      { name: 'go-blog', cwd: '/ws/go-blog', provider: 'codex', model: 'gpt-5-codex' },
      { name: 'zgh', cwd: '/ws/zgh', provider: 'claude', model: 'sonnet-4.6' },
    ],
  }

  function fanoutState() {
    return {
      machine: {
        plan: {
          runId: 'run2-1',
          stages: [
            { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus', scope: 'root', gate: false },
            { key: 'develop', name: '代码开发', provider: 'codex', model: 'gpt-5-codex', scope: 'per-project', gate: false },
          ],
        },
        stages: [
          { key: 'design', status: 'done', round: 0 },
          { key: 'develop', status: 'running', round: 0 },
        ],
        currentIndex: 1,
      },
      inbox: [],
      feedback: [],
      outcomes: {
        develop: [{ order: { id: 'develop:zgh', stageKey: 'develop', name: '代码开发', project: 'zgh', provider: 'claude', model: 'sonnet-4.6', cwd: '/ws/zgh', prompt: '' }, status: 'ok', attempts: 1 }],
      },
      status: 'running',
      pendingDirective: {},
      liveLanes: { 'develop:go-blog': { stageKey: 'develop', project: 'go-blog', state: 'run', cwd: '/ws/go-blog' } },
      stageTimings: { design: { startedAt: 1000, endedAt: 2000 }, develop: { startedAt: 2000 } },
      paused: false,
    }
  }

  const scanContext = vi.fn()

  beforeEach(() => {
    scanContext.mockReset()
    scanContext.mockResolvedValue({
      skills: [{ name: 'brainstorming', path: '/x' }],
      rules: [],
      mcps: [],
    })
  })

  it('renders the code stage as a .wfo-group with 2 parallel .wfo-lane rows (run + ok)', async () => {
    launchInfo.mockResolvedValue(FANOUT_LAUNCH_INFO)
    ;(window as any).forge.scanContext = scanContext
    const run2 = makeRun2(fanoutState())
    run2.laneLogs = {
      'develop:go-blog': [
        { laneId: 'develop:go-blog', stageKey: 'develop', agentName: 'Codex', line: { ts: '', text: '正在实现变更', level: 'run', kind: 'output' } },
      ],
    }
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={run2} onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.wfo-node')).toHaveLength(2))

    const developNode = container.querySelectorAll('.wfo-node')[1]
    const group = developNode.querySelector('.wfo-group') as HTMLElement
    expect(group).not.toBeNull()
    // The group's own container class is the stage's overall stageRunState (reused verbatim from
    // B1) — NOT derived from the individual lanes below, which is why it doesn't necessarily read
    // 'run' here even though one lane is still going. Per-lane state is what's asserted below.
    expect(group.querySelector('.wfo-gpar')?.textContent).toBe('2 仓库并行')

    const lanes = group.querySelectorAll('.wfo-lane')
    expect(lanes).toHaveLength(2)
    // order follows selectedRepos (project list order): go-blog (run), zgh (ok)
    expect(lanes[0]).toHaveClass('run')
    expect(lanes[0].querySelector('.wfo-lname b')?.textContent).toBe('go-blog')
    expect(lanes[1]).toHaveClass('ok')
    expect(lanes[1].querySelector('.wfo-lname b')?.textContent).toBe('zgh')

    // no plain .wfo-box single-lane node for a code stage in run mode
    expect(developNode.querySelector(':scope > .wfo-box')).toBeNull()

    // expand the running lane — shows its own laneLogs IO + caps
    fireEvent.click(lanes[0].querySelector('.wfo-lhead') as HTMLElement)
    await waitFor(() => expect(scanContext).toHaveBeenCalledWith('/ws/go-blog'))
    const laneBody = lanes[0].querySelector('.wfo-lbody') as HTMLElement
    await waitFor(() => expect(laneBody.textContent).toContain('正在实现变更'))
    expect(laneBody.querySelector('.wfo-cap.s')?.textContent).toContain('brainstorming')
  })
})

describe('WorkflowOverlay foot run controls (Task B5)', () => {
  const FOOT_LAUNCH_INFO = {
    workflows: [
      {
        id: 'wf-standard',
        name: '标准工作流',
        stages: [stage({ key: 'design', name: '技术方案设计', desc: '设计技术方案' })],
      },
    ],
    projects: [],
  }

  function footState(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      machine: {
        plan: { runId: 'run2-1', stages: [{ key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus', scope: 'root', gate: false }] },
        stages: [{ key: 'design', status: 'running', round: 0 }],
        currentIndex: 0,
      },
      inbox: [],
      feedback: [],
      outcomes: {},
      status: 'running',
      pendingDirective: {},
      liveLanes: {},
      stageTimings: { design: { startedAt: 1000 } },
      paused: false,
      ...overrides,
    }
  }

  it('running, not paused: shows .wfo-runctl with 终止 (abort) and 暂停 (pause), no done class', async () => {
    launchInfo.mockResolvedValue(FOOT_LAUNCH_INFO)
    const run2 = makeRun2(footState())
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={run2} onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelector('.wfo-runctl')).toBeInTheDocument())

    const runctl = container.querySelector('.wfo-runctl') as HTMLElement
    expect(runctl).not.toHaveClass('done')
    expect(runctl.querySelector('.rmsg .rd')).toBeInTheDocument()

    fireEvent.click(screen.getByText('终止'))
    expect(run2.abort).toHaveBeenCalled()

    fireEvent.click(screen.getByText('暂停'))
    expect(run2.pause).toHaveBeenCalled()
    expect(screen.queryByText('继续')).toBeNull()
  })

  it('running + paused: shows 继续 (resume) instead of 暂停', async () => {
    launchInfo.mockResolvedValue(FOOT_LAUNCH_INFO)
    const run2 = makeRun2(footState({ paused: true }))
    render(<WorkflowOverlay workspacePath="/ws" run2={run2} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('继续')).toBeInTheDocument())

    expect(screen.queryByText('暂停')).toBeNull()
    fireEvent.click(screen.getByText('继续'))
    expect(run2.resume).toHaveBeenCalled()
  })

  it('status ok: shows .wfo-runctl.done with 完成 → onClose()', async () => {
    launchInfo.mockResolvedValue(FOOT_LAUNCH_INFO)
    const run2 = makeRun2(footState({ status: 'ok', machine: { plan: { runId: 'run2-1', stages: [{ key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus', scope: 'root', gate: false }] }, stages: [{ key: 'design', status: 'done', round: 0 }], currentIndex: 0 } }))
    const onClose = vi.fn()
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={run2} onClose={onClose} />)
    await waitFor(() => expect(container.querySelector('.wfo-runctl.done')).toBeInTheDocument())

    expect(screen.queryByText('终止')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('status failed: also renders the done foot (完成 closes)', async () => {
    launchInfo.mockResolvedValue(FOOT_LAUNCH_INFO)
    const run2 = makeRun2(footState({ status: 'failed' }))
    const { container } = render(<WorkflowOverlay workspacePath="/ws" run2={run2} onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelector('.wfo-runctl.done')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '完成' })).toBeInTheDocument()
  })
})
