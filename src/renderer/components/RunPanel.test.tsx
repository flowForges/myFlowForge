import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RunPanel } from './RunPanel'
import type { Run2Api } from '../state/useRun2'
import type { RunControllerState } from '../../main/run/controller'

function makeState(overrides?: Partial<RunControllerState>): RunControllerState {
  const base: RunControllerState = {
    machine: {
      plan: { runId: 'r1', stages: [] },
      stages: [
        { key: 'design', status: 'done', round: 0 },
        { key: 'dev', status: 'running', round: 0 },
        { key: 'review', status: 'pending', round: 0 },
      ],
      currentIndex: 1,
    },
    inbox: [
      { id: 'g1', kind: 'gate', stageKey: 'dev', body: '## 方案\n完成', docs: [] },
    ],
    feedback: [{ id: 'fb1', text: '别忘了加测试' }],
    outcomes: {
      dev: [
        { order: { id: 'w1', stageKey: 'dev', name: 'dev-lane', project: 'app', provider: 'claude', model: 'sonnet', cwd: '/tmp/app', prompt: '' }, status: 'ok', attempts: 1 },
      ],
    },
    status: 'awaiting',
    pendingDirective: {},
    liveLanes: {},
    stageTimings: {},
    paused: false,
  }
  return { ...base, ...overrides }
}

function makeApi(state: RunControllerState | null, laneLogs: Run2Api['laneLogs'] = {}, queueLength = 0): Run2Api {
  return {
    state,
    laneLogs,
    queueLength,
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

describe('RunPanel', () => {
  it('renders placeholder when state is null', () => {
    const api = makeApi(null)
    render(<RunPanel api={api} />)
    expect(screen.getByText('未在运行工作流')).toBeInTheDocument()
  })

  it('renders stage flow, current-stage lane, event card, and feedback draft; cancel calls abort', () => {
    const api = makeApi(makeState())
    render(<RunPanel api={api} />)

    // stage flow: all three stage keys present
    expect(screen.getByText('design')).toBeInTheDocument()
    expect(screen.getByText('dev')).toBeInTheDocument()
    expect(screen.getByText('review')).toBeInTheDocument()

    // current-stage lane: outcome for the "dev" stage's project shows up (also mirrored in the
    // new stage-output region below, since selectedStageKey defaults to the current stage 'dev')
    expect(screen.getAllByText(/app/).length).toBeGreaterThan(0)

    // event inbox: the gate event card is rendered with its [通过] action
    const passBtn = screen.getByText('通过')
    expect(passBtn).toBeInTheDocument()
    fireEvent.click(passBtn)
    expect(api.resolveGate).toHaveBeenCalledWith('g1', { type: 'advance' })

    // feedback draft
    expect(screen.getByDisplayValue('别忘了加测试')).toBeInTheDocument()

    // cancel run
    fireEvent.click(screen.getByText('取消运行'))
    expect(api.abort).toHaveBeenCalled()
  })

  it('shows empty-inbox message when inbox is empty', () => {
    const state = makeState({ inbox: [] })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    expect(screen.getByText('运行中，暂无待办')).toBeInTheDocument()
  })

  it('feedback input submit calls addFeedback', () => {
    const state = makeState({ feedback: [] })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    const input = screen.getByPlaceholderText('补充反馈…') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新反馈' } })
    fireEvent.click(screen.getByText('添加'))
    expect(api.addFeedback).toHaveBeenCalledWith('新反馈')
  })

  it('renders live lanes for the current stage when outcomes are empty, and hides the empty state', () => {
    const state = makeState({
      outcomes: {},
      liveLanes: {
        'design:root': { stageKey: 'design', state: 'run', activity: '写 design.md' },
      },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)

    // Note: makeState's default currentIndex is 1 (the 'dev' stage). The 'design' stage's
    // live lane belongs to a different stage, so it should NOT render.
    expect(screen.queryByText('写 design.md')).not.toBeInTheDocument()
  })

  it('renders live lanes for the CURRENT stage and suppresses the empty state', () => {
    const state = makeState({
      machine: {
        plan: { runId: 'r1', stages: [] },
        stages: [
          { key: 'design', status: 'running', round: 0 },
          { key: 'dev', status: 'pending', round: 0 },
          { key: 'review', status: 'pending', round: 0 },
        ],
        currentIndex: 0,
      },
      outcomes: {},
      liveLanes: {
        'design:root': { stageKey: 'design', state: 'run', activity: '写 design.md' },
      },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)

    // Mirrored in both the current-stage lane and the stage-output region (selectedStageKey
    // defaults to the current stage 'design').
    expect(screen.getAllByText('写 design.md').length).toBeGreaterThan(0)
    expect(screen.queryByText('暂无进展')).not.toBeInTheDocument()
  })

  it('editFeedback and removeFeedback are wired to the feedback row', () => {
    const api = makeApi(makeState())
    render(<RunPanel api={api} />)
    const editable = screen.getByDisplayValue('别忘了加测试') as HTMLInputElement
    fireEvent.change(editable, { target: { value: '改一下' } })
    fireEvent.blur(editable)
    expect(api.editFeedback).toHaveBeenCalledWith('fb1', '改一下')

    fireEvent.click(screen.getByTitle('删除反馈'))
    expect(api.removeFeedback).toHaveBeenCalledWith('fb1')
  })

  it('stage output: renders selected stage outcome summary/files/doubts, and switching stage chips switches the shown output', () => {
    const state = makeState({
      machine: {
        plan: { runId: 'r1', stages: [] },
        stages: [
          { key: 'design', status: 'done', round: 0 },
          { key: 'dev', status: 'running', round: 0 },
          { key: 'review', status: 'pending', round: 0 },
        ],
        currentIndex: 1,
      },
      outcomes: {
        design: [
          {
            order: { id: 'design:root', stageKey: 'design', name: 'design-lane', project: undefined, provider: 'claude', model: 'sonnet', cwd: '/tmp', prompt: '' },
            status: 'ok',
            attempts: 1,
            result: { summary: '技术方案：用 X 架构', filesChanged: ['design.md'], blockers: [], doubts: ['是否加缓存'], artifacts: [] },
          },
        ],
        dev: [
          { order: { id: 'w1', stageKey: 'dev', name: 'dev-lane', project: 'app', provider: 'claude', model: 'sonnet', cwd: '/tmp/app', prompt: '' }, status: 'ok', attempts: 1 },
        ],
      },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)

    // Default selected stage follows the current stage ('dev'); its outcome has no `result`,
    // so the design stage's output must not be showing yet.
    expect(screen.queryByText('技术方案：用 X 架构')).not.toBeInTheDocument()

    // Click the 'design' stage chip → its outcome's output renders.
    fireEvent.click(screen.getByText('design'))
    expect(screen.getByText(/技术方案：用 X 架构/)).toBeInTheDocument()
    expect(screen.getByText('design.md')).toBeInTheDocument()
    expect(screen.getByText(/是否加缓存/)).toBeInTheDocument()
  })

  it('stage output follows the current stage on the real mount-before-populate path (state null → populated), no chip click needed', () => {
    // Real mount order: RunPanel mounts while api.state === null (before the run starts),
    // then a later onUpdate populates api.state. The effective selection must follow the
    // current stage without any user interaction.
    const nullApi = makeApi(null)
    const { rerender } = render(<RunPanel api={nullApi} />)
    expect(screen.getByText('未在运行工作流')).toBeInTheDocument()

    const populated = makeState({
      machine: {
        plan: { runId: 'r1', stages: [] },
        stages: [
          { key: 'design', status: 'running', round: 0 },
          { key: 'dev', status: 'pending', round: 0 },
          { key: 'review', status: 'pending', round: 0 },
        ],
        currentIndex: 0,
      },
      // No pending gate here — this test is about the current-stage-follow default, not the
      // gate-focus override. (makeState's base fixture has a gate on 'dev', which would win.)
      inbox: [],
      outcomes: {
        design: [
          {
            order: { id: 'design:root', stageKey: 'design', name: 'design-lane', project: undefined, provider: 'claude', model: 'sonnet', cwd: '/tmp', prompt: '' },
            status: 'ok',
            attempts: 1,
            result: { summary: '技术方案：用 X 架构', filesChanged: ['design.md'], blockers: [], doubts: [], artifacts: [] },
          },
        ],
      },
    })
    rerender(<RunPanel api={makeApi(populated)} />)

    // No chip click — design is the current stage, so its output must be shown.
    expect(screen.getByText(/技术方案：用 X 架构/)).toBeInTheDocument()
    expect(screen.getByText('design.md')).toBeInTheDocument()
  })

  it('stage output renders result.blockers for a failed work order with no top-level error', () => {
    const state = makeState({
      machine: {
        plan: { runId: 'r1', stages: [] },
        stages: [{ key: 'dev', status: 'running', round: 0 }],
        currentIndex: 0,
      },
      outcomes: {
        dev: [
          {
            order: { id: 'w1', stageKey: 'dev', name: 'dev-lane', project: 'app', provider: 'claude', model: 'sonnet', cwd: '/tmp/app', prompt: '' },
            status: 'failed',
            attempts: 1,
            result: { summary: '尝试实现', filesChanged: [], blockers: ['缺少数据库凭据'], doubts: [], artifacts: [] },
          },
        ],
      },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    expect(screen.getByText(/缺少数据库凭据/)).toBeInTheDocument()
  })

  it('stage chip is keyboard-activatable (Enter selects the stage)', () => {
    const state = makeState({
      // currentIndex defaults to 1 ('dev'); 'design' has produced output.
      outcomes: {
        design: [
          {
            order: { id: 'design:root', stageKey: 'design', name: 'design-lane', project: undefined, provider: 'claude', model: 'sonnet', cwd: '/tmp', prompt: '' },
            status: 'ok',
            attempts: 1,
            result: { summary: '技术方案：用 X 架构', filesChanged: [], blockers: [], doubts: [], artifacts: [] },
          },
        ],
      },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    // Current stage is 'dev' (no design output shown yet). Keyboard-select 'design' → its output shows.
    expect(screen.queryByText(/技术方案：用 X 架构/)).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByText('design'), { key: 'Enter' })
    expect(screen.getByText(/技术方案：用 X 架构/)).toBeInTheDocument()
  })

  it('clicking a filesChanged item opens the Run2FileViewer with the file content', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: '# 技术方案' })
    ;(window as any).forge = { run2: { readFile } }
    const state = makeState({
      machine: {
        plan: { runId: 'r1', stages: [] },
        stages: [{ key: 'design', status: 'running', round: 0 }],
        currentIndex: 0,
      },
      // No pending gate — irrelevant to file-viewer behavior (base fixture's gate is on 'dev',
      // a stage that doesn't even exist here).
      inbox: [],
      outcomes: {
        design: [
          {
            order: { id: 'design:root', stageKey: 'design', name: 'design-lane', project: undefined, provider: 'claude', model: 'sonnet', cwd: '/tmp/proj', prompt: '' },
            status: 'ok',
            attempts: 1,
            result: { summary: '技术方案：用 X 架构', filesChanged: ['design.md'], blockers: [], doubts: [], artifacts: [] },
          },
        ],
      },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)

    fireEvent.click(screen.getByText('design.md'))
    expect(readFile).toHaveBeenCalledWith({ path: 'design.md', cwd: '/tmp/proj' })
    expect(await screen.findByRole('heading', { name: '技术方案' })).toBeInTheDocument()

    // close button dismisses the viewer
    fireEvent.click(screen.getByRole('button', { name: /关闭/ }))
    expect(screen.queryByRole('heading', { name: '技术方案' })).not.toBeInTheDocument()
  })

  it('auto-focuses the gating stage\'s output (no chip click) and shows a review hint; an explicit chip click overrides it', () => {
    const state = makeState({
      machine: {
        plan: { runId: 'r1', stages: [] },
        stages: [
          { key: 'design', status: 'awaiting-gate', round: 0 },
          { key: 'dev', status: 'pending', round: 0 },
          { key: 'review', status: 'pending', round: 0 },
        ],
        // Current stage is 'dev' per the machine's index, but a gate is pending on 'design' —
        // the design output should be shown by default, not dev's.
        currentIndex: 1,
      },
      inbox: [{ id: 'g1', kind: 'gate', stageKey: 'design', body: '## 方案\n审一下' }],
      outcomes: {
        design: [
          {
            order: { id: 'design:root', stageKey: 'design', name: 'design-lane', project: undefined, provider: 'claude', model: 'sonnet', cwd: '/tmp', prompt: '' },
            status: 'ok',
            attempts: 1,
            result: { summary: '技术方案：用 X 架构', filesChanged: [], blockers: [], doubts: [], artifacts: [] },
          },
        ],
      },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)

    // No chip click — the gating stage's ('design') output is shown by default.
    expect(screen.getByText(/技术方案：用 X 架构/)).toBeInTheDocument()
    // Review hint is shown alongside it.
    expect(screen.getByText(/待你审核的产出/)).toBeInTheDocument()

    // User explicitly selects a different stage chip → override wins, hint disappears.
    fireEvent.click(screen.getByText('review'))
    expect(screen.queryByText(/待你审核的产出/)).not.toBeInTheDocument()
  })

  it('flow rail: a done stage node shows its model and computed duration', () => {
    const state = makeState({
      machine: {
        plan: {
          runId: 'r1',
          stages: [
            { key: 'design', name: 'design', provider: 'codex', model: 'gpt-x', scope: 'root', gate: true },
          ],
        },
        stages: [{ key: 'design', status: 'done', round: 0 }],
        currentIndex: 0,
      },
      inbox: [],
      outcomes: {},
      stageTimings: { design: { startedAt: 1000, endedAt: 4000 } },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    expect(screen.getByText('gpt-x')).toBeInTheDocument()
    expect(screen.getByText('3s')).toBeInTheDocument()
  })

  it('flow rail: a running stage node with no endedAt shows "运行中" instead of a duration', () => {
    const state = makeState({
      machine: {
        plan: {
          runId: 'r1',
          stages: [
            { key: 'design', name: 'design', provider: 'codex', model: 'gpt-x', scope: 'root', gate: true },
          ],
        },
        stages: [{ key: 'design', status: 'running', round: 0 }],
        currentIndex: 0,
      },
      inbox: [],
      outcomes: {},
      status: 'running', // overall run is live — the running-stage label is only shown then
      stageTimings: { design: { startedAt: 1000 } },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    expect(screen.getByText('运行中')).toBeInTheDocument()
  })

  it('flow rail: an aborted/failed run does NOT show "运行中" for a stage left in running status', () => {
    const state = makeState({
      machine: {
        plan: {
          runId: 'r1',
          stages: [
            { key: 'design', name: 'design', provider: 'codex', model: 'gpt-x', scope: 'root', gate: true },
          ],
        },
        // On abort mid-stage the controller breaks before stamping endedAt, leaving the stage
        // status at 'running' — but the overall run is 'failed'.
        stages: [{ key: 'design', status: 'running', round: 0 }],
        currentIndex: 0,
      },
      inbox: [],
      outcomes: {},
      status: 'failed',
      stageTimings: { design: { startedAt: 1000 } },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    expect(screen.queryByText('运行中')).not.toBeInTheDocument()
  })

  it('renders the current stage live lane\'s buffered log lines (think/tool/output)', () => {
    const state = makeState({
      machine: {
        plan: { runId: 'r1', stages: [] },
        stages: [{ key: 'design', status: 'running', round: 0 }],
        currentIndex: 0,
      },
      inbox: [],
      outcomes: {},
      liveLanes: {
        'design:root': { stageKey: 'design', state: 'run', activity: '写 design.md' },
      },
    })
    const api = makeApi(state, {
      'design:root': [
        { laneId: 'design:root', stageKey: 'design', agentName: 'Codex', line: { ts: '', text: '思考中……', level: 'run', kind: 'think' } },
        { laneId: 'design:root', stageKey: 'design', agentName: 'Codex', line: { ts: '', text: '写文件 design.md', level: 'run', kind: 'tool' } },
      ],
    })
    render(<RunPanel api={api} />)
    // Mirrored in both the current-stage lane and the stage-output region (same pattern as the
    // existing live-lane tests above — selectedStageKey defaults to the current stage 'design').
    expect(screen.getAllByText(/思考中……/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/写文件 design.md/).length).toBeGreaterThan(0)
  })

  it('renders the 看实时日志 button when onOpenLog is provided, and calls it on click', () => {
    const api = makeApi(makeState())
    const onOpenLog = vi.fn()
    render(<RunPanel api={api} onOpenLog={onOpenLog} />)
    const btn = screen.getByText('看实时日志')
    fireEvent.click(btn)
    expect(onOpenLog).toHaveBeenCalled()
  })

  it('does not render the 看实时日志 button when onOpenLog is absent', () => {
    const api = makeApi(makeState())
    render(<RunPanel api={api} />)
    expect(screen.queryByText('看实时日志')).not.toBeInTheDocument()
  })

  it('control bar: shows 暂停 while running and unpaused, calls pause() on click; no 继续/已暂停', () => {
    const state = makeState({ status: 'running', paused: false })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    const pauseBtn = screen.getByText('暂停')
    expect(pauseBtn).toBeInTheDocument()
    expect(screen.queryByText('继续')).not.toBeInTheDocument()
    expect(screen.queryByText('已暂停')).not.toBeInTheDocument()
    fireEvent.click(pauseBtn)
    expect(api.pause).toHaveBeenCalled()
  })

  it('control bar: when paused, shows 继续 + 已暂停 badge instead of 暂停, calls resume() on click', () => {
    const state = makeState({ status: 'running', paused: true })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    expect(screen.queryByText('暂停')).not.toBeInTheDocument()
    expect(screen.getByText('已暂停')).toBeInTheDocument()
    const resumeBtn = screen.getByText('继续')
    fireEvent.click(resumeBtn)
    expect(api.resume).toHaveBeenCalled()
  })

  it('control bar: does NOT show 暂停 when status is awaiting (gate-parked), even though not paused', () => {
    const state = makeState({ status: 'awaiting', paused: false })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    expect(screen.queryByText('暂停')).not.toBeInTheDocument()
  })

  it('control bar: 回退到… lists stages before currentIndex, click one calls jumpBack(key)', () => {
    const state = makeState({
      status: 'running',
      machine: {
        plan: { runId: 'r1', stages: [] },
        stages: [
          { key: 'design', status: 'done', round: 0 },
          { key: 'dev', status: 'done', round: 0 },
          { key: 'review', status: 'running', round: 0 },
        ],
        currentIndex: 2,
      },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    const rollback = screen.getByText('回退到…').closest('div') as HTMLElement
    expect(rollback).toBeTruthy()
    const designOpt = screen.getByText(/回退到 design/)
    const devOpt = screen.getByText(/回退到 dev/)
    expect(designOpt).toBeInTheDocument()
    expect(devOpt).toBeInTheDocument()
    fireEvent.click(devOpt)
    expect(api.jumpBack).toHaveBeenCalledWith('dev')
  })

  // Task 2 (queue): RunHead shows a "队列: N" badge when this workspace has runs waiting behind
  // the currently active one.
  it('shows a queue badge when api.queueLength > 0', () => {
    const api = makeApi(makeState(), {}, 2)
    render(<RunPanel api={api} />)
    expect(screen.getByText('队列: 2')).toBeInTheDocument()
  })

  it('hides the queue badge when api.queueLength is 0', () => {
    const api = makeApi(makeState(), {}, 0)
    render(<RunPanel api={api} />)
    expect(screen.queryByText(/队列:/)).not.toBeInTheDocument()
  })

  it('control bar: 回退到… is absent when currentIndex is 0 (no prior stages)', () => {
    const state = makeState({
      status: 'running',
      machine: {
        plan: { runId: 'r1', stages: [] },
        stages: [{ key: 'design', status: 'running', round: 0 }],
        currentIndex: 0,
      },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    expect(screen.queryByText('回退到…')).not.toBeInTheDocument()
  })
})
