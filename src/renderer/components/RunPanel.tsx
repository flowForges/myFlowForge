import { useState } from 'react'
import type { Run2Api } from '../state/useRun2'
import type { StageStatus } from '../../main/run/machine'
import type { WorkOrderOutcome } from '../../main/run/workOrder'
import type { LiveLane } from '../../main/run/controller'
import { Run2EventCard } from './Run2EventCard'
import { Markdown } from '../views/chat/markdown'
import { Run2FileViewer } from './Run2FileViewer'

interface RunPanelProps { api: Run2Api }

const STAGE_GLYPH: Record<StageStatus, string> = {
  done: '✓',
  running: '⟳',
  'awaiting-gate': '⟳',
  stale: '↺',
  pending: '·',
}

// Region 1: overall status + stage-flow strip + cancel button.
function RunHead({ api, selectedStageKey, onSelectStage }: { api: Run2Api; selectedStageKey: string | undefined; onSelectStage: (key: string) => void }) {
  const { machine, status } = api.state!
  return (
    <div className="run2-head">
      <div className="run2-status">运行状态：{status}</div>
      <div className="run2-stage-flow">
        {machine.stages.map((s, i) => (
          <span
            key={s.key}
            role="button"
            tabIndex={0}
            className={`run2-stage-chip${i === machine.currentIndex ? ' current' : ''}${s.key === selectedStageKey ? ' selected' : ''} st-${s.status}`}
            onClick={() => onSelectStage(s.key)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectStage(s.key) } }}
          >
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

// Live lane row: a stage's currently-running work order (not yet settled into `outcomes`).
function LiveLaneRow({ id, lane }: { id: string; lane: LiveLane }) {
  const label = lane.project ?? 'root'
  return (
    <div className="run2-lane-row live st-run">
      <span className="run2-lane-project">{label}</span>
      <span className="run2-lane-status">⟳ {lane.state ?? '执行中'}</span>
      {lane.activity && <span className="run2-lane-activity">{lane.activity}</span>}
    </div>
  )
}

function CurrentStageLane({ api }: { api: Run2Api }) {
  const { machine, outcomes, liveLanes } = api.state!
  const currentKey = machine.stages[machine.currentIndex]?.key
  const stageOutcomes = currentKey ? outcomes[currentKey] : undefined
  const liveEntries = currentKey
    ? Object.entries(liveLanes).filter(([, l]) => l.stageKey === currentKey)
    : []
  const hasOutcomes = !!stageOutcomes && stageOutcomes.length > 0
  const hasLive = liveEntries.length > 0
  return (
    <div className="run2-lane">
      <div className="run2-lane-title">当前阶段泳道{currentKey ? `：${currentKey}` : ''}</div>
      {hasOutcomes && stageOutcomes!.map((o) => <LaneRow key={o.order.id} outcome={o} />)}
      {hasLive && liveEntries.map(([id, l]) => <LiveLaneRow key={id} id={id} lane={l} />)}
      {!hasOutcomes && !hasLive && <div className="run2-lane-empty">暂无进展</div>}
    </div>
  )
}

// Region 2b: stage output — what each project produced for the selected stage
// (result.summary/filesChanged/testsRun/doubts), not just live/settled activity status.
function OutcomeCard({ outcome, onOpenFile }: { outcome: WorkOrderOutcome; onOpenFile: (path: string, cwd: string | undefined) => void }) {
  const label = outcome.order.project ?? 'root'
  const { result } = outcome
  return (
    <div className={`run2-output-card st-${outcome.status}`}>
      <div className="run2-output-head">
        <span className="run2-output-project">{label}</span>
        <span className="run2-output-status">{outcome.status === 'ok' ? '完成' : '失败'}</span>
      </div>
      {result && (
        <>
          <div className="run2-output-summary"><Markdown text={result.summary} /></div>
          {result.filesChanged.length > 0 && (
            <div className="run2-output-files">
              <div className="run2-output-subtitle">改动文件</div>
              <ul>
                {result.filesChanged.map((f) => (
                  <li key={f}>
                    <button
                      type="button"
                      className="txt-btn run2-output-file-btn"
                      onClick={() => onOpenFile(f, outcome.order.cwd)}
                    >
                      {f}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.testsRun && (
            <div className="run2-output-tests">
              测试：{result.testsRun.passed ? '通过' : '未通过'}
              {result.testsRun.detail ? `（${result.testsRun.detail}）` : ''}
            </div>
          )}
          {result.blockers.length > 0 && (
            <div className="run2-output-blockers">
              <div className="run2-output-subtitle">阻塞</div>
              <ul>
                {result.blockers.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
          )}
          {result.doubts.length > 0 && (
            <div className="run2-output-doubts">
              <div className="run2-output-subtitle">存疑</div>
              <ul>
                {result.doubts.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
      {outcome.error && <div className="run2-output-error">失败原因：{outcome.error}</div>}
    </div>
  )
}

function StageOutput({ api, selectedStageKey, onOpenFile }: { api: Run2Api; selectedStageKey: string | undefined; onOpenFile: (path: string, cwd: string | undefined) => void }) {
  const { outcomes, liveLanes } = api.state!
  const stageOutcomes = selectedStageKey ? outcomes[selectedStageKey] : undefined
  const liveEntries = selectedStageKey
    ? Object.entries(liveLanes).filter(([, l]) => l.stageKey === selectedStageKey)
    : []
  const hasOutcomes = !!stageOutcomes && stageOutcomes.length > 0
  const hasLive = liveEntries.length > 0
  return (
    <div className="run2-stage-output">
      <div className="run2-stage-output-title">阶段产出{selectedStageKey ? `：${selectedStageKey}` : ''}</div>
      {hasOutcomes && stageOutcomes!.map((o) => <OutcomeCard key={o.order.id} outcome={o} onOpenFile={onOpenFile} />)}
      {!hasOutcomes && hasLive && liveEntries.map(([id, l]) => <LiveLaneRow key={id} id={id} lane={l} />)}
      {!hasOutcomes && !hasLive && <div className="run2-stage-output-empty">执行中/未开始</div>}
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
  // `selectedStageKey` is a pure user override (undefined = "follow current stage"). RunPanel
  // mounts while `api.state === null` (before a run starts), so we MUST NOT snapshot the current
  // key into state at init — that would freeze it to `undefined` forever. Instead we derive the
  // effective selection at render time (below), which follows the current stage until the user
  // explicitly clicks/keys a chip. Hook runs unconditionally to keep hook order stable.
  const [selectedStageKey, setSelectedStageKey] = useState<string | undefined>(undefined)
  // P5-UI Task 2: which changed file (if any) is open in the Run2FileViewer modal. `cwd` is the
  // work order's project dir — filesChanged paths are relative to it.
  const [viewingFile, setViewingFile] = useState<{ path: string; cwd: string | undefined } | null>(null)
  if (!api.state) {
    return <div className="run2-panel run2-empty">未在运行工作流</div>
  }
  const { machine } = api.state
  const currentKey = machine.stages[machine.currentIndex]?.key
  const effectiveKey = selectedStageKey ?? currentKey
  return (
    <div className="run2-panel">
      <RunHead api={api} selectedStageKey={effectiveKey} onSelectStage={setSelectedStageKey} />
      <CurrentStageLane api={api} />
      <StageOutput
        api={api}
        selectedStageKey={effectiveKey}
        onOpenFile={(path, cwd) => setViewingFile({ path, cwd })}
      />
      <EventInbox api={api} />
      <FeedbackDraftPanel api={api} />
      {viewingFile && (
        <Run2FileViewer
          path={viewingFile.path}
          cwd={viewingFile.cwd}
          onClose={() => setViewingFile(null)}
        />
      )}
    </div>
  )
}
