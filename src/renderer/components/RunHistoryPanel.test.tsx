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
})
