import { useState } from 'react'
import type { Run2Api } from '../state/useRun2'
import type { StageStatus } from '../../main/run/machine'
import type { WorkOrderOutcome } from '../../main/run/workOrder'
import { Run2EventCard } from './Run2EventCard'

interface RunPanelProps { api: Run2Api }

const STAGE_GLYPH: Record<StageStatus, string> = {
  done: '✓',
  running: '⟳',
  'awaiting-gate': '⟳',
  stale: '↺',
  pending: '·',
}

// Region 1: overall status + stage-flow strip + cancel button.
function RunHead({ api }: { api: Run2Api }) {
  const { machine, status } = api.state!
  return (
    <div className="run2-head">
      <div className="run2-status">运行状态：{status}</div>
      <div className="run2-stage-flow">
        {machine.stages.map((s, i) => (
          <span key={s.key} className={`run2-stage-chip${i === machine.currentIndex ? ' current' : ''} st-${s.status}`}>
            <span className="run2-stage-glyph">{STAGE_GLYPH[s.status] ?? '·'}</span>
            <span className="run2-stage-key">{s.key}</span>
          </span>
        ))}
      </div>
      <button className="txt-btn run2-abort" onClick={() => api.abort()}>取消运行</button>
    </div>
  )
}

// Region 2: current-stage lane list, rendered from outcomes snapshot.
// P3-B simplification: WorkOrderOutcome doesn't carry the live AgentRuntime shape AgentNode
// needs (logs/state/heartbeat/...), so each outcome renders as a simple row (project + status)
// rather than reusing AgentNode — reuse without a bogus/faked AgentRuntime would be worse than
// a plain row. Live per-agent rendering via AgentNode is a later enhancement (see task brief).
function LaneRow({ outcome }: { outcome: WorkOrderOutcome }) {
  const label = outcome.order.project ?? outcome.order.name
  return (
    <div className={`run2-lane-row st-${outcome.status}`}>
      <span className="run2-lane-project">{label}</span>
      <span className="run2-lane-status">{outcome.status === 'ok' ? '完成' : '失败'}</span>
      {outcome.error && <span className="run2-lane-error">{outcome.error}</span>}
    </div>
  )
}

function CurrentStageLane({ api }: { api: Run2Api }) {
  const { machine, outcomes } = api.state!
  const currentKey = machine.stages[machine.currentIndex]?.key
  const stageOutcomes = currentKey ? outcomes[currentKey] : undefined
  return (
    <div className="run2-lane">
      <div className="run2-lane-title">当前阶段泳道{currentKey ? `：${currentKey}` : ''}</div>
      {stageOutcomes && stageOutcomes.length > 0
        ? stageOutcomes.map((o) => <LaneRow key={o.order.id} outcome={o} />)
        : <div className="run2-lane-empty">暂无进展</div>}
    </div>
  )
}

// Region 3: event inbox.
function EventInbox({ api }: { api: Run2Api }) {
  const inbox = api.state!.inbox
  return (
    <div className="run2-inbox">
      <div className="run2-inbox-title">事件收件箱</div>
      {inbox.length === 0
        ? <div className="run2-inbox-empty">运行中，暂无待办</div>
        : inbox.map((e) => <Run2EventCard key={e.id} event={e} onGate={api.resolveGate} onLane={api.resolveLane} />)}
    </div>
  )
}

// Region 4: feedback drafts — editable/removable list + an add input.
function FeedbackRow({ id, text, onEdit, onRemove }: { id: string; text: string; onEdit: (id: string, text: string) => void; onRemove: (id: string) => void }) {
  const [value, setValue] = useState(text)
  return (
    <div className="run2-fb-row">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (value !== text) onEdit(id, value) }}
      />
      <button className="txt-btn" title="删除反馈" onClick={() => onRemove(id)}>删除</button>
    </div>
  )
}

function FeedbackDraftPanel({ api }: { api: Run2Api }) {
  const feedback = api.state!.feedback
  const [draft, setDraft] = useState('')
  const submit = () => {
    const text = draft.trim()
    if (!text) return
    api.addFeedback(text)
    setDraft('')
  }
  return (
    <div className="run2-feedback">
      <div className="run2-feedback-title">反馈草稿</div>
      {feedback.map((f) => (
        <FeedbackRow key={f.id} id={f.id} text={f.text} onEdit={api.editFeedback} onRemove={api.removeFeedback} />
      ))}
      <div className="run2-fb-add">
        <input
          type="text"
          placeholder="补充反馈…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        />
        <button className="txt-btn" onClick={submit}>添加</button>
      </div>
    </div>
  )
}

export function RunPanel({ api }: RunPanelProps) {
  if (!api.state) {
    return <div className="run2-panel run2-empty">未在运行工作流</div>
  }
  return (
    <div className="run2-panel">
      <RunHead api={api} />
      <CurrentStageLane api={api} />
      <EventInbox api={api} />
      <FeedbackDraftPanel api={api} />
    </div>
  )
}
