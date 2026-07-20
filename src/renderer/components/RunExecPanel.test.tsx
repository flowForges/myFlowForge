import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RunExecPanel } from './RunExecPanel'
import type { Run2Api } from '../state/useRun2'

function makeRun2(state: any = null, laneLogs: Record<string, any[]> = {}): Run2Api {
  return {
    state,
    laneLogs,
    queueLength: 0,
    start: vi.fn(),
    resolveGate: vi.fn(),
    resolveLane: vi.fn(),
    addFeedback: vi.fn(),
    editFeedback: vi.fn(),
    removeFeedback: vi.fn(),
    abort: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    jumpBack: vi.fn(),
  } as unknown as Run2Api
}

function baseState(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    machine: {
      plan: {
        runId: 'run2-1',
        stages: [
          { key: 'assess', name: '需求评估', provider: 'claude', model: 'opus', scope: 'root', gate: false, prompt: '评估需求' },
          { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus', scope: 'root', gate: true, prompt: '设计技术方案' },
          { key: 'develop', name: '代码开发', provider: 'codex', model: 'gpt-5-codex', scope: 'per-project', gate: false, prompt: '实现代码变更' },
          { key: 'review', name: '代码评审', provider: 'claude', model: 'opus', scope: 'root', gate: false, prompt: '评审代码' },
        ],
      },
      stages: [
        { key: 'assess', status: 'done', round: 0 },
        { key: 'design', status: 'done', round: 0 },
        { key: 'develop', status: 'running', round: 0 },
        { key: 'review', status: 'pending', round: 0 },
      ],
      currentIndex: 2,
    },
    inbox: [],
    feedback: [],
    outcomes: {
      develop: [
        { order: { id: 'develop:zgh', stageKey: 'develop', name: '代码开发', project: 'zgh', provider: 'claude', model: 'sonnet-4.6', cwd: '/ws/zgh', prompt: '' }, status: 'ok', attempts: 1 },
      ],
    },
    status: 'running',
    pendingDirective: {},
    liveLanes: {
      'develop:go-blog': { stageKey: 'develop', project: 'go-blog', state: 'run', cwd: '/ws/go-blog' },
    },
    stageTimings: {
      assess: { startedAt: 0, endedAt: 500 },
      design: { startedAt: 500, endedAt: 1500 },
      develop: { startedAt: 1500 },
    },
    paused: false,
    ...overrides,
  }
}

beforeEach(() => {
  ;(window as any).forge = {}
})

describe('RunExecPanel', () => {
  it('renders progress, stage names, and fan-out lane cards (project name + state)', () => {
    const run2 = makeRun2(baseState())
    render(<RunExecPanel run2={run2} />)

    expect(screen.getByText('已完成 2 / 4')).toBeInTheDocument()
    expect(screen.getByText('分支：—')).toBeInTheDocument()

    // Stage headers (.stage-name) — one per stage.
    expect(document.querySelectorAll('.stage-name')).toHaveLength(4)
    expect(screen.getAllByText('需求评估').length).toBeGreaterThan(0)
    expect(screen.getAllByText('技术方案设计').length).toBeGreaterThan(0)
    expect(screen.getAllByText('代码开发').length).toBeGreaterThan(0)
    expect(screen.getAllByText('代码评审').length).toBeGreaterThan(0)

    // Fan-out lanes for the running per-project stage render as AgentNode cards, one per project.
    const goBlogCard = screen.getByText('go-blog').closest('.agent-node')
    expect(goBlogCard).not.toBeNull()
    expect(goBlogCard!.querySelector('.agent-state')?.textContent).toContain('执行中')

    const zghCard = screen.getByText('zgh').closest('.agent-node')
    expect(zghCard).not.toBeNull()
    expect(zghCard!.querySelector('.agent-state')?.textContent).toContain('完成')
  })

  // Improvement ⑥: per-lane (per-project) execution timing end-to-end — state.laneTimings flows
  // through runExecAdapter into AgentNode's `.agent-elapsed` chip, with a done lane showing its
  // frozen total and a still-running lane (no endedAt) showing elapsed-so-far.
  it('renders per-lane elapsed time: frozen total for a done lane, ticking elapsed for a running lane', () => {
    const now = Date.now()
    const run2 = makeRun2(baseState({
      laneTimings: {
        'develop:zgh': { startedAt: now - 75_000, endedAt: now - 3_000 }, // done: frozen 72s = 1m 12s
        'develop:go-blog': { startedAt: now - 20_000 }, // still running: ~20s
      },
    }))
    render(<RunExecPanel run2={run2} />)

    const zghCard = screen.getByText('zgh').closest('.agent-node')!
    expect(zghCard.querySelector('.agent-elapsed')).toHaveTextContent('1m 12s')

    const goBlogCard = screen.getByText('go-blog').closest('.agent-node')!
    expect(goBlogCard.querySelector('.agent-elapsed')).toHaveTextContent('20s')
  })

  it('does not render any per-node decision action (gate/auth/failure buttons)', () => {
    const gatedState = baseState({
      inbox: [{ id: 'g1', kind: 'gate', stageKey: 'design', body: '方案已就绪' }],
    })
    const run2 = makeRun2(gatedState)
    render(<RunExecPanel run2={run2} />)

    expect(screen.queryByText('确认继续')).toBeNull()
    expect(screen.queryByText('批准')).toBeNull()
    expect(screen.queryByText('重跑')).toBeNull()
    expect(screen.queryByText('要求修改')).toBeNull()
    expect(screen.queryByText('拒绝')).toBeNull()
    expect(screen.queryByText('跳过')).toBeNull()
    expect(screen.queryByText('提交')).toBeNull()
    expect(document.querySelector('.wfo-act')).toBeNull()
  })

  // Regression: the old 代理-tab AgentNode showed a "日志台" button (onViewLog) opening the bottom
  // 实时日志 drawer filtered to that agent — RunExecPanel's run2 cards dropped it. Wire it back.
  it('renders a 日志台 button on each agent card when onViewLog is provided, and calls it with (laneId, name)', () => {
    const run2 = makeRun2(baseState())
    const onViewLog = vi.fn()
    render(<RunExecPanel run2={run2} onViewLog={onViewLog} />)

    const zghCard = screen.getByText('zgh').closest('.agent-node')!
    const logBtn = zghCard.querySelector('.proc-expand') as HTMLElement
    expect(logBtn).not.toBeNull()
    fireEvent.click(logBtn)
    // AdaptedAgent.id for a per-project lane is the laneId `${stageKey}:${project}` (see
    // runExecAdapter.ts) — that's what must be passed so the log-console filter (keyed on
    // LogLine.filterId for run2 lines) actually matches this lane's log lines.
    expect(onViewLog).toHaveBeenCalledWith('develop:zgh', 'zgh')
  })

  it('does not render a 日志台 button when onViewLog is not provided', () => {
    const run2 = makeRun2(baseState())
    render(<RunExecPanel run2={run2} />)
    const zghCard = screen.getByText('zgh').closest('.agent-node')!
    expect(zghCard.querySelector('.proc-expand')).toBeNull()
  })

  it('omits the 日志台 button in read-only/historical replay even when onViewLog is passed (no live log stream to show)', () => {
    const onViewLog = vi.fn()
    render(<RunExecPanel staticState={baseState() as any} readOnly onViewLog={onViewLog} />)
    const zghCard = screen.getByText('zgh').closest('.agent-node')!
    expect(zghCard.querySelector('.proc-expand')).toBeNull()
  })

  it('shows run-level 暂停/终止 controls and wires them to run2', () => {
    const run2 = makeRun2(baseState())
    render(<RunExecPanel run2={run2} />)

    const pauseBtn = screen.getByText('暂停')
    fireEvent.click(pauseBtn)
    expect(run2.pause).toHaveBeenCalled()

    const abortBtn = screen.getByText(/终止/)
    fireEvent.click(abortBtn)
    expect(run2.abort).toHaveBeenCalled()

    // Fix 2: the 终止 button's icon must be a filled glyph (an empty stroked outline previously
    // read as a broken/unloaded icon) — assert the svg has no stroke and paints via fill.
    const stopSvg = abortBtn.querySelector('svg')!
    expect(stopSvg).not.toBeNull()
    expect(stopSvg.getAttribute('fill')).toBe('currentColor')
    expect(stopSvg.getAttribute('stroke')).toBe('none')
  })

  // Fix 3: header title ("工作流执行中"/"历史运行回看") and the 分支 caption must stack vertically
  // (not sit side by side on one row, which wrapped the bold title in the narrow inspector).
  it('stacks the header title and 分支 caption vertically', () => {
    const run2 = makeRun2(baseState())
    render(<RunExecPanel run2={run2} />)

    const title = screen.getByText('工作流执行中')
    const branch = screen.getByText(/分支：/)
    const titleRow = title.closest('.wfo-title')
    expect(titleRow).not.toBeNull()
    // Both the title and the branch caption live inside the same `.wfo-title` stack.
    expect(titleRow!.contains(branch)).toBe(true)
  })

  it('shows 继续 instead of 暂停 when the run is paused, wired to resume', () => {
    const run2 = makeRun2(baseState({ paused: true }))
    render(<RunExecPanel run2={run2} />)

    const resumeBtn = screen.getByText('继续')
    fireEvent.click(resumeBtn)
    expect(run2.resume).toHaveBeenCalled()
    expect(screen.queryByText('暂停')).toBeNull()
  })

  it('renders "—" for tempBranch when the plan does not have one yet', () => {
    const run2 = makeRun2(baseState())
    render(<RunExecPanel run2={run2} />)
    expect(screen.getByText('分支：—')).toBeInTheDocument()
  })

  it('Finding 1: a finalize-gate merge conflict shows the real error, not the generic "存在失败阶段" banner', () => {
    // Every stage done (100%), no FailureEvent, no failed WorkOrderOutcome anywhere — this is the
    // finalize-merge-conflict shape: `runFinalizeGate` set state.error and the run ended 'failed'
    // even though every stage itself succeeded.
    const state = baseState({
      status: 'failed',
      error: '合并临时分支失败 — a: CONFLICT (content): Merge conflict in app.ts',
      machine: {
        plan: baseState().machine.plan,
        stages: [
          { key: 'assess', status: 'done', round: 0 },
          { key: 'design', status: 'done', round: 0 },
          { key: 'develop', status: 'done', round: 0 },
          { key: 'review', status: 'done', round: 0 },
        ],
        currentIndex: 4,
      },
      outcomes: {
        develop: [
          { order: { id: 'develop:zgh', stageKey: 'develop', name: '代码开发', project: 'zgh', provider: 'claude', model: 'sonnet-4.6', cwd: '/ws/zgh', prompt: '' }, status: 'ok', attempts: 1 },
        ],
      },
    })
    const run2 = makeRun2(state)
    render(<RunExecPanel run2={run2} />)

    expect(screen.getByText(/合并临时分支失败.*CONFLICT/)).toBeInTheDocument()
    expect(screen.queryByText('工作流已结束 · 存在失败阶段，请检查后处理')).toBeNull()
  })

  it('a genuine per-lane stage failure (no state.error) keeps the existing "存在失败阶段" text', () => {
    const state = baseState({
      status: 'failed',
      outcomes: {
        develop: [
          { order: { id: 'develop:zgh', stageKey: 'develop', name: '代码开发', project: 'zgh', provider: 'claude', model: 'sonnet-4.6', cwd: '/ws/zgh', prompt: '' }, status: 'failed', error: 'boom', attempts: 1 },
        ],
      },
    })
    const run2 = makeRun2(state)
    render(<RunExecPanel run2={run2} />)
    expect(screen.getByText('工作流已结束 · 存在失败阶段，请检查后处理')).toBeInTheDocument()
  })

  it('a plain abort (no error, no failed outcome) shows a neutral "已结束" instead of the misleading banner', () => {
    const state = baseState({ status: 'failed' })
    const run2 = makeRun2(state)
    render(<RunExecPanel run2={run2} />)
    expect(screen.getByText('工作流已结束')).toBeInTheDocument()
    expect(screen.queryByText('工作流已结束 · 存在失败阶段，请检查后处理')).toBeNull()
  })

  it('renders a 已失效 marker on a stale (jumped-back-past) stage, and only on that stage', () => {
    const staleState = baseState({
      machine: {
        plan: baseState().machine.plan,
        stages: [
          { key: 'assess', status: 'running', round: 1 },
          { key: 'design', status: 'stale', round: 0 },
          { key: 'develop', status: 'stale', round: 0 },
          { key: 'review', status: 'pending', round: 0 },
        ],
        currentIndex: 0,
      },
    })
    const run2 = makeRun2(staleState)
    render(<RunExecPanel run2={run2} />)

    const staleChips = screen.getAllByText('已失效')
    expect(staleChips).toHaveLength(2)
    // The marker sits inside the invalidated stages' own header, not the running/pending ones.
    const designHeader = screen.getAllByText('技术方案设计')[0].closest('.stage-head')!
    const developHeader = screen.getAllByText('代码开发')[0].closest('.stage-head')!
    const assessHeader = screen.getAllByText('需求评估')[0].closest('.stage-head')!
    const reviewHeader = screen.getAllByText('代码评审')[0].closest('.stage-head')!
    expect(designHeader.querySelector('.stage-stale')).not.toBeNull()
    expect(developHeader.querySelector('.stage-stale')).not.toBeNull()
    expect(assessHeader.querySelector('.stage-stale')).toBeNull()
    expect(reviewHeader.querySelector('.stage-stale')).toBeNull()
  })

  it('renders nothing but an idle message when there is no active run', () => {
    const run2 = makeRun2(null)
    render(<RunExecPanel run2={run2} />)
    expect(screen.getByText('无正在运行的工作流')).toBeInTheDocument()
    expect(screen.queryByText('暂停')).toBeNull()
    expect(screen.queryByText(/终止/)).toBeNull()
  })

  // Spec §12.7 (run-history): staticState/readOnly power the historical-replay path — a finished
  // run's saved state rendered through the SAME stage/agent cards, with no live run2 wired at all
  // and no run-level control buttons.
  describe('staticState/readOnly (run-history replay)', () => {
    it('renders stage cards from staticState with no run2 prop, and hides 暂停/继续/终止', () => {
      render(<RunExecPanel staticState={baseState({ status: 'ok' }) as any} readOnly />)

      expect(screen.getByText('已完成 2 / 4')).toBeInTheDocument()
      expect(screen.getAllByText('代码开发').length).toBeGreaterThan(0)
      expect(screen.getByText('历史运行回看')).toBeInTheDocument()
      expect(screen.queryByText('暂停')).toBeNull()
      expect(screen.queryByText('继续')).toBeNull()
      expect(screen.queryByText(/终止/)).toBeNull()
    })

    it('a live run (no staticState/readOnly) still shows its control buttons', () => {
      const run2 = makeRun2(baseState())
      render(<RunExecPanel run2={run2} />)
      expect(screen.getByText('暂停')).toBeInTheDocument()
      expect(screen.getByText(/终止/)).toBeInTheDocument()
      expect(screen.queryByText('历史运行回看')).toBeNull()
    })

    it('a readOnly non-terminal staticState shows a neutral message, not the live "正在执行…" controls', () => {
      render(<RunExecPanel staticState={baseState({ status: 'running' }) as any} readOnly />)
      expect(screen.getByText(/只读回看/)).toBeInTheDocument()
      expect(screen.queryByText('暂停')).toBeNull()
      expect(screen.queryByText(/终止/)).toBeNull()
    })

    // Important fix: a lane that was mid-flight when the app was hard-killed persists
    // {startedAt} with no endedAt — non-terminal, so it re-appears in run-history replay. The
    // elapsed pill must NOT tick against the current time there (that renders "minutes since the
    // crash"); it must show 未完成. The same shape on a LIVE panel still ticks normally.
    it('a crashed lane (startedAt, no endedAt) shows 未完成 in read-only replay, not minutes-since-crash', () => {
      const longAgo = Date.now() - 18_732 * 60_000
      const crashedState = baseState({
        status: 'running',
        laneTimings: { 'develop:go-blog': { startedAt: longAgo } },
      })
      render(<RunExecPanel staticState={crashedState as any} readOnly />)

      const goBlogCard = screen.getByText('go-blog').closest('.agent-node')!
      const pill = goBlogCard.querySelector('.agent-elapsed')
      expect(pill).toHaveTextContent('未完成')
      expect(pill?.textContent).not.toMatch(/\d+m/)
    })

    // Minor guard: staticState without readOnly must still be treated as read-only for control
    // rendering (a static snapshot has no live process behind it even if a caller forgets the flag).
    it('staticState without readOnly still hides the live run-level controls (defensive)', () => {
      render(<RunExecPanel staticState={baseState({ status: 'running' }) as any} />)
      expect(screen.queryByText('暂停')).toBeNull()
      expect(screen.queryByText('正在执行…')).toBeNull()
      expect(screen.queryByText(/终止/)).toBeNull()
    })

    it('the same crashed-shape lane on a LIVE panel still ticks elapsed-so-far against now', () => {
      const now = Date.now()
      const run2 = makeRun2(baseState({
        laneTimings: { 'develop:go-blog': { startedAt: now - 20_000 } },
      }))
      render(<RunExecPanel run2={run2} />)

      const goBlogCard = screen.getByText('go-blog').closest('.agent-node')!
      expect(goBlogCard.querySelector('.agent-elapsed')).toHaveTextContent('20s')
    })
  })
})
