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

function fmtTime(ms: number): string {
  try { return new Date(ms).toLocaleString() } catch { return '' }
}

export function RunHistoryPanel({
  listRuns,
  loadRun,
}: {
  listRuns: () => Promise<RunHistoryEntry[]>
  loadRun: (runId: string) => Promise<SavedControllerState | null>
}): ReactElement {
  const [entries, setEntries] = useState<RunHistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<{ runId: string; state: RunControllerState } | null>(null)

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
        return (
          <button key={e.runId} className="run-history-row" onClick={() => openRun(e.runId)}>
            <span className={`rh-status rh-${e.status}`}>{STATUS_LABEL[e.status] ?? e.status}</span>
            <span className="rh-name">{e.workflowName ?? e.task ?? e.runId}</span>
            <span className="rh-prog">{e.doneCount}/{e.totalStages} · {pct}%</span>
            <span className="rh-time">{fmtTime(e.modifiedAt)}</span>
          </button>
        )
      })}
    </div>
  )
}
