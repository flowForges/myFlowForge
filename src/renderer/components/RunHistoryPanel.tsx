import { useEffect, useState, type ReactElement } from 'react'
import type { RunHistoryEntry, SavedControllerState } from '../../main/run/persist'
import type { RunControllerState } from '../../main/run/controller'
import { RunExecPanel } from './RunExecPanel'
import { toHistoricalState } from './runHistoryAdapter'

// Spec §12.7: 工作区加「运行历史」列表，每条 run 一行，点开进只读运行面板回看产物与各阶段轮次。
// List is loaded once per workspace switch via `listRuns`; clicking a row loads that run's full
// saved state via `loadRun`, adapts it (runHistoryAdapter), and shows it through the SAME
// `RunExecPanel` a live run uses — just with `readOnly` so the run-level 暂停/继续/终止 controls
// never render for a run nothing is driving anymore.
const STATUS_LABEL: Record<string, string> = { running: '执行中', awaiting: '等待中', ok: '已完成', failed: '已失败' }

// Run-state UX fix: a saved entry with status running/awaiting but NO live controller behind it
// (the app was killed mid-run) is NOT actually "执行中" — it's an orphaned/interrupted run. Only
// the workspace's single currently-live run (liveRunId, threaded down from WorkspaceView's
// `run2.state?.machine.plan.runId`) gets to keep the live running/awaiting label; every other
// non-terminal entry is relabeled 中断 so it doesn't clutter the list looking like active work.
function statusLabelFor(e: RunHistoryEntry, liveRunId: string | null | undefined): { text: string; cls: string } {
  const isLive = !!liveRunId && e.runId === liveRunId
  const nonTerminal = e.status === 'running' || e.status === 'awaiting'
  if (nonTerminal && !isLive) return { text: '中断', cls: 'interrupted' }
  return { text: STATUS_LABEL[e.status] ?? e.status, cls: e.status }
}

function fmtTime(ms: number): string {
  try { return new Date(ms).toLocaleString() } catch { return '' }
}

export function RunHistoryPanel({
  listRuns,
  loadRun,
  liveRunId,
  deleteRun,
}: {
  listRuns: () => Promise<RunHistoryEntry[]>
  loadRun: (runId: string) => Promise<SavedControllerState | null>
  /** The runId of this workspace's currently-live run (if any) — see statusLabelFor's doc. */
  liveRunId?: string | null
  /** Removes one run's saved state so it disappears from history. Omitted entirely when a caller
   *  doesn't wire it (older tests) — the delete button then simply never renders. */
  deleteRun?: (runId: string) => Promise<void>
}): ReactElement {
  const [entries, setEntries] = useState<RunHistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<{ runId: string; state: RunControllerState } | null>(null)
  // Two-click inline confirm ("delete this entry?") instead of a heavier modal — armed by runId,
  // disarmed on any outcome (confirm, cancel, or picking a different row's delete button).
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setSelected(null)
    setLoading(true)
    listRuns()
      .then((list) => { if (alive) setEntries(list) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openRun = (runId: string) => {
    loadRun(runId).then((saved) => {
      if (!saved) return
      setSelected({ runId, state: toHistoricalState(saved) })
    })
  }

  const handleDelete = (runId: string) => {
    if (!deleteRun) return
    setConfirmId(null)
    deleteRun(runId).then(() => {
      setEntries((prev) => prev.filter((e) => e.runId !== runId))
    })
  }

  if (selected) {
    return (
      <div className="run-history">
        <div className="run-history-head">
          <button className="txt-btn" onClick={() => setSelected(null)}>← 返回运行历史</button>
        </div>
        <RunExecPanel staticState={selected.state} readOnly />
      </div>
    )
  }

  return (
    <div className="run-history">
      {loading && <div className="run-history-empty">加载中…</div>}
      {!loading && entries.length === 0 && <div className="run-history-empty">暂无运行历史</div>}
      {!loading && entries.map((e) => {
        const pct = e.totalStages ? Math.round((e.doneCount / e.totalStages) * 100) : 0
        const isLive = !!liveRunId && e.runId === liveRunId
        const label = statusLabelFor(e, liveRunId)
        const confirming = confirmId === e.runId
        return (
          // A nested <button> inside a <button> is invalid HTML (the delete button needs its own
          // click target) — the row itself uses role="button" on a <div>, same pattern as App.tsx's
          // existing button-in-button workaround.
          <div
            key={e.runId}
            className="run-history-row"
            role="button"
            tabIndex={0}
            onClick={() => openRun(e.runId)}
            onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') openRun(e.runId) }}
          >
            <span className={`rh-status rh-${label.cls}`}>{label.text}</span>
            <span className="rh-name">{e.workflowName ?? e.task ?? e.runId}</span>
            <span className="rh-prog">{e.doneCount}/{e.totalStages} · {pct}%</span>
            <span className="rh-time">{fmtTime(e.modifiedAt)}</span>
            {/* Never offer delete for the currently-live run — it has an active controller driving
                it; deleting its saved state out from under that would just corrupt the live run. */}
            {deleteRun && !isLive && (
              confirming ? (
                <span className="rh-del-confirm" onClick={(ev) => ev.stopPropagation()}>
                  <button
                    className="txt-btn rh-del-yes"
                    onClick={() => handleDelete(e.runId)}
                  >确认删除</button>
                  <button
                    className="txt-btn"
                    onClick={() => setConfirmId(null)}
                  >取消</button>
                </span>
              ) : (
                <button
                  className="rh-del-btn"
                  title="删除此运行记录"
                  aria-label="删除此运行记录"
                  onClick={(ev) => { ev.stopPropagation(); setConfirmId(e.runId) }}
                >🗑</button>
              )
            )}
          </div>
        )
      })}
    </div>
  )
}
