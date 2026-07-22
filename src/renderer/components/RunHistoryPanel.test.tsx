import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RunHistoryPanel } from './RunHistoryPanel'
import type { RunHistoryEntry, SavedControllerState } from '../../main/run/persist'

beforeEach(() => {
  ;(window as any).forge = {}
})

const entries: RunHistoryEntry[] = [
  { runId: 'run-2', status: 'failed', doneCount: 1, totalStages: 3, task: '需求B', modifiedAt: 2000 },
  { runId: 'run-1', status: 'ok', doneCount: 2, totalStages: 2, task: '需求A', modifiedAt: 1000 },
]

function savedFor(runId: string): SavedControllerState {
  return {
    machine: {
      plan: { runId, stages: [{ key: 'design', name: 'D', provider: 'x', model: 'm', scope: 'root', gate: false }] },
      stages: [{ key: 'design', status: 'done', round: 0 }],
      currentIndex: 0,
    },
    inbox: [],
    feedback: [],
    outcomes: { design: [{ id: 'design:root', status: 'ok', attempts: 1 }] },
    status: 'ok',
    pendingDirective: {},
    stageTimings: {},
    task: `saved-${runId}`,
  } as unknown as SavedControllerState
}

describe('RunHistoryPanel', () => {
  it('renders a row per saved run, newest-first as given by listRuns', async () => {
    const listRuns = vi.fn(async () => entries)
    const loadRun = vi.fn(async () => null)
    render(<RunHistoryPanel listRuns={listRuns} loadRun={loadRun} />)

    await waitFor(() => expect(screen.getByText('需求B')).toBeInTheDocument())
    expect(screen.getByText('需求A')).toBeInTheDocument()
    expect(listRuns).toHaveBeenCalled()
  })

  // Regression (N3): WorkspaceView reuses this panel across workspace switches, so the caller
  // must remount it via `key={wsPath}` for a switch to re-fetch. Simulate that remount here by
  // re-rendering with a different `key` (the same mechanism React uses when the caller's key prop
  // changes) and assert the new workspace's list replaces the old one instead of sticking around.
  it('remounts and re-fetches when given a new key (simulating a workspace switch)', async () => {
    const listRunsA = vi.fn(async () => entries)
    const entriesB: RunHistoryEntry[] = [
      { runId: 'run-b1', status: 'ok', doneCount: 1, totalStages: 1, task: '工作区B的需求', modifiedAt: 500 },
    ]
    const listRunsB = vi.fn(async () => entriesB)
    const loadRun = vi.fn(async () => null)

    const { rerender } = render(<RunHistoryPanel key="ws-a" listRuns={listRunsA} loadRun={loadRun} />)
    await waitFor(() => expect(screen.getByText('需求B')).toBeInTheDocument())
    expect(listRunsA).toHaveBeenCalledTimes(1)

    rerender(<RunHistoryPanel key="ws-b" listRuns={listRunsB} loadRun={loadRun} />)

    await waitFor(() => expect(screen.getByText('工作区B的需求')).toBeInTheDocument())
    expect(screen.queryByText('需求B')).toBeNull()
    expect(screen.queryByText('需求A')).toBeNull()
    expect(listRunsB).toHaveBeenCalledTimes(1)
  })

  it('shows an empty message when there are no saved runs', async () => {
    const listRuns = vi.fn(async () => [])
    const loadRun = vi.fn(async () => null)
    render(<RunHistoryPanel listRuns={listRuns} loadRun={loadRun} />)
    await waitFor(() => expect(screen.getByText('暂无运行历史')).toBeInTheDocument())
  })

  it('clicking a row loads that run and shows it read-only in RunExecPanel, with a 返回 back to the list', async () => {
    const listRuns = vi.fn(async () => entries)
    const loadRun = vi.fn(async (runId: string) => savedFor(runId))
    render(<RunHistoryPanel listRuns={listRuns} loadRun={loadRun} />)

    await waitFor(() => expect(screen.getByText('需求B')).toBeInTheDocument())
    fireEvent.click(screen.getByText('需求B'))

    await waitFor(() => expect(loadRun).toHaveBeenCalledWith('run-2'))
    // Read-only replay: no live run-level controls, and the list itself is gone (detail view only).
    await waitFor(() => expect(screen.getByText('历史运行回看')).toBeInTheDocument())
    expect(screen.queryByText('暂停')).toBeNull()
    expect(screen.queryByText(/终止/)).toBeNull()
    expect(screen.queryByText('需求A')).toBeNull()

    fireEvent.click(screen.getByText('← 返回运行历史'))
    await waitFor(() => expect(screen.getByText('需求B')).toBeInTheDocument())
    expect(screen.getByText('需求A')).toBeInTheDocument()
  })

  // Run-state UX fix: a saved non-terminal run (running/awaiting) with no live controller behind
  // it (the app died mid-run) must not read as active work — only the workspace's actual live run
  // (liveRunId) keeps the live label.
  describe('中断 label vs live label', () => {
    const nonTerminalEntries: RunHistoryEntry[] = [
      { runId: 'run-live', status: 'running', doneCount: 1, totalStages: 4, task: '进行中的需求', modifiedAt: 3000 },
      { runId: 'run-orphan', status: 'running', doneCount: 0, totalStages: 4, task: '被中断的需求', modifiedAt: 2000 },
      { runId: 'run-awaiting-orphan', status: 'awaiting', doneCount: 2, totalStages: 4, task: '等待中但被中断', modifiedAt: 1000 },
    ]

    it('labels the live run 执行中 and every other non-terminal entry 中断', async () => {
      const listRuns = vi.fn(async () => nonTerminalEntries)
      const loadRun = vi.fn(async () => null)
      render(<RunHistoryPanel listRuns={listRuns} loadRun={loadRun} liveRunId="run-live" />)

      await waitFor(() => expect(screen.getByText('进行中的需求')).toBeInTheDocument())

      const liveRow = screen.getByText('进行中的需求').closest('.run-history-row')!
      expect(liveRow.querySelector('.rh-status')).toHaveTextContent('执行中')

      const orphanRow = screen.getByText('被中断的需求').closest('.run-history-row')!
      expect(orphanRow.querySelector('.rh-status')).toHaveTextContent('中断')

      const awaitingOrphanRow = screen.getByText('等待中但被中断').closest('.run-history-row')!
      expect(awaitingOrphanRow.querySelector('.rh-status')).toHaveTextContent('中断')
    })

    it('with no liveRunId at all, every non-terminal entry shows 中断 (nothing is live)', async () => {
      const listRuns = vi.fn(async () => nonTerminalEntries)
      const loadRun = vi.fn(async () => null)
      render(<RunHistoryPanel listRuns={listRuns} loadRun={loadRun} />)

      await waitFor(() => expect(screen.getByText('进行中的需求')).toBeInTheDocument())
      expect(screen.getAllByText('中断')).toHaveLength(3)
    })

    it('terminal entries (ok/failed) are unaffected by liveRunId', async () => {
      const listRuns = vi.fn(async () => entries)
      const loadRun = vi.fn(async () => null)
      render(<RunHistoryPanel listRuns={listRuns} loadRun={loadRun} liveRunId="some-other-run" />)

      await waitFor(() => expect(screen.getByText('需求B')).toBeInTheDocument())
      expect(screen.getByText('需求B').closest('.run-history-row')!.querySelector('.rh-status')).toHaveTextContent('已失败')
      expect(screen.getByText('需求A').closest('.run-history-row')!.querySelector('.rh-status')).toHaveTextContent('已完成')
    })
  })

  describe('delete', () => {
    it('renders no delete button when deleteRun is not provided', async () => {
      const listRuns = vi.fn(async () => entries)
      const loadRun = vi.fn(async () => null)
      render(<RunHistoryPanel listRuns={listRuns} loadRun={loadRun} />)
      await waitFor(() => expect(screen.getByText('需求B')).toBeInTheDocument())
      expect(document.querySelector('.rh-del-btn')).toBeNull()
    })

    it('clicking delete then confirm calls deleteRun(runId) and removes the row, without opening it', async () => {
      const listRuns = vi.fn(async () => entries)
      const loadRun = vi.fn(async () => null)
      const deleteRun = vi.fn(async () => {})
      render(<RunHistoryPanel listRuns={listRuns} loadRun={loadRun} deleteRun={deleteRun} />)

      await waitFor(() => expect(screen.getByText('需求B')).toBeInTheDocument())
      const row = screen.getByText('需求B').closest('.run-history-row')!
      fireEvent.click(row.querySelector('.rh-del-btn')!)
      fireEvent.click(screen.getByText('确认删除'))

      expect(deleteRun).toHaveBeenCalledWith('run-2')
      expect(loadRun).not.toHaveBeenCalled()
      await waitFor(() => expect(screen.queryByText('需求B')).toBeNull())
      expect(screen.getByText('需求A')).toBeInTheDocument()
    })

    it('hides the delete button for the currently-live run', async () => {
      const listRuns = vi.fn(async () => entries)
      const loadRun = vi.fn(async () => null)
      const deleteRun = vi.fn(async () => {})
      render(<RunHistoryPanel listRuns={listRuns} loadRun={loadRun} deleteRun={deleteRun} liveRunId="run-2" />)

      await waitFor(() => expect(screen.getByText('需求B')).toBeInTheDocument())
      const liveRow = screen.getByText('需求B').closest('.run-history-row')!
      expect(liveRow.querySelector('.rh-del-btn')).toBeNull()

      const otherRow = screen.getByText('需求A').closest('.run-history-row')!
      expect(otherRow.querySelector('.rh-del-btn')).not.toBeNull()
    })
  })
})
