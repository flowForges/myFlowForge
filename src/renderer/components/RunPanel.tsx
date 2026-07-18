import { useEffect, useState } from 'react'
import type { Run2Api } from '../state/useRun2'
import type { StageStatus } from '../../main/run/machine'
import type { WorkOrderOutcome } from '../../main/run/workOrder'
import type { LiveLane, RunLogLine } from '../../main/run/controller'
import type { GateEvent } from '../../main/run/events'
import type { AgentContextMeta } from '@shared/types'
import { Run2EventCard } from './Run2EventCard'
import { Markdown } from '../views/chat/markdown'
import { Run2FileViewer } from './Run2FileViewer'

interface RunPanelProps {
  api: Run2Api
  /** Opens the bottom real-time LogConsole (shell/App owns its open state + focus). Optional:
   *  when not threaded through by the caller, the 看实时日志 button simply doesn't render rather
   *  than being wired to a no-op — see task-3 brief ("拿不到打开回调则本按钮 best-effort/降级")。 */
  onOpenLog?: () => void
}

const LOG_KIND_LABEL: Record<NonNullable<RunLogLine['line']['kind']>, string> = {
  think: '💭 思',
  tool: '🔧 执',
  file: '📄 文',
  output: '▶ 出',
}

// Compact scroll area showing a lane's recently buffered think/tool/file/output lines (from the
// run2:log stream, buffered per-lane in useRun2). This is the "see the execution" view — a live
// feed, not a full transcript (the bottom LogConsole remains the full transcript / expanded view).
function LaneLog({ lines }: { lines: RunLogLine[] }) {
  if (lines.length === 0) return null
  return (
    <div className="run2-lane-log">
      {lines.map((l, i) => {
        const kind = l.line.kind ?? 'output'
        return (
          // Stable-ish key: ts + index. The buffer is append-and-evict (oldest dropped at the
          // 40-cap), so a bare index churns every row on eviction — pairing it with the line's
          // timestamp keeps keys stable across evictions well enough at this size.
          <div key={`${l.line.ts}-${i}`} className={`run2-lane-log-line l-${kind}`}>
            <span className="run2-lane-log-kind">{LOG_KIND_LABEL[kind]}</span>
            <span className="run2-lane-log-text">{l.line.text}</span>
          </div>
        )
      })}
    </div>
  )
}

// P-B2 Task 2: what would this lane's agent load if it ran in its cwd right now — skills/rules/
// mcps — reusing the same cwd-scanner (`window.forge.scanContext`) the old orchestrator's "已加载
// SKILL/RULE/MCP" chips used. No engine change: this purely reads the lane's cwd (LiveLane.cwd for
// running lanes — see task-1 — or outcome.order.cwd for settled ones) and scans it client-side.
const laneContextCache = new Map<string, AgentContextMeta>()

function LaneContext({ cwd }: { cwd?: string }) {
  const [meta, setMeta] = useState<AgentContextMeta | null>(() => (cwd ? laneContextCache.get(cwd) ?? null : null))
  useEffect(() => {
    if (!cwd) { setMeta(null); return }
    const cached = laneContextCache.get(cwd)
    if (cached) { setMeta(cached); return }
    const scan = window.forge?.scanContext
    if (!scan) return
    let alive = true
    scan(cwd)
      .then((m: AgentContextMeta) => {
        if (!m) return
        laneContextCache.set(cwd, m)
        if (alive) setMeta(m)
      })
      .catch(() => { /* best-effort — a scan failure just means no chips, not a crash */ })
    return () => { alive = false }
  }, [cwd])

  if (!cwd || !meta) return null
  const { skills, rules, mcps } = meta
  const hasMcps = !!mcps && mcps.length > 0
  if (skills.length === 0 && rules.length === 0 && !hasMcps) return null
  return (
    <div className="run2-lane-ctx">
      <span className="run2-lane-ctx-title">可用能力</span>
      {skills.length > 0 && (
        <span className="run2-ctx-group run2-ctx-group-skill">
          {skills.map((s) => <span key={s.name} className="run2-ctx-skill">{s.name}</span>)}
        </span>
      )}
      {rules.length > 0 && (
        <span className="run2-ctx-group run2-ctx-group-rule">
          {rules.map((r) => <span key={r.name} className="run2-ctx-rule">{r.name}</span>)}
        </span>
      )}
      {hasMcps && (
        <span className="run2-ctx-group run2-ctx-group-mcp">
          {mcps!.map((m) => <span key={m.name} className="run2-ctx-mcp">{m.name}</span>)}
        </span>
      )}
    </div>
  )
}

const STAGE_GLYPH: Record<StageStatus, string> = {
  done: '✓',
  running: '⟳',
  'awaiting-gate': '⟳',
  stale: '↺',
  pending: '·',
}

// Pure helper: ms → human duration, e.g. 3000 -> "3s". Kept simple per task brief (no m:ss).
export function fmtDuration(ms: number): string {
  return `${Math.round(ms / 1000)}s`
}

// Run control bar: pause/resume (stage-boundary only, see task-4 brief) + rollback-to-an-earlier-
// stage. Kept as its own component (rendered inside RunHead) so the pause/resume/rollback gating
// logic reads as one unit next to the abort button it sits beside.
function RunControlBar({ api }: { api: Run2Api }) {
  const { status, paused, machine } = api.state!
  // 暂停 must be gated on status==='running' (not just !paused) — otherwise it's a dead no-op
  // while the run is parked at a gate (status==='awaiting'). See T1 review note in the task brief.
  const showPause = status === 'running' && !paused
  const priorStages = machine.stages.filter((_, i) => i < machine.currentIndex)
  return (
    <div className="run2-ctrl">
      {showPause && (
        <button type="button" className="txt-btn run2-ctrl-pause" onClick={() => api.pause()}>暂停</button>
      )}
      {paused && (
        <>
          <span className="run2-paused-badge">已暂停</span>
          <button type="button" className="txt-btn run2-ctrl-resume" onClick={() => api.resume()}>继续</button>
        </>
      )}
      {priorStages.length > 0 && (
        <div className="run2-ctrl-rollback">
          <span className="run2-ctrl-rollback-label">回退到…</span>
          {priorStages.map((s) => (
            // Full button text is "回退到 <key>" (not the bare key) — the bare stage key is
            // already used as the stage-flow chip's text, and rendering it again here would make
            // that text ambiguous for anything querying by stage key (tests included).
            <button
              type="button"
              key={s.key}
              className="txt-btn run2-ctrl-rollback-item"
              disabled={status !== 'running'}
              onClick={() => api.jumpBack(s.key)}
            >
              回退到 {s.key}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Region 1: overall status + stage-flow rail + cancel button. Each node shows the stage's model
// (from machine.plan.stages, matched by key), status glyph, and duration (from stageTimings —
// defend against it being absent on old/persisted state). Nodes stay clickable/keyboard-selectable,
// driving the same selection StageOutput reads.
function RunHead({ api, selectedStageKey, onSelectStage }: { api: Run2Api; selectedStageKey: string | undefined; onSelectStage: (key: string) => void }) {
  const { machine, status, stageTimings } = api.state!
  return (
    <div className="run2-head">
      <div className="run2-status">运行状态：{status}</div>
      {api.queueLength > 0 && <span className="run2-queue-badge">队列: {api.queueLength}</span>}
      <div className="run2-stage-flow run2-rail">
        {machine.stages.map((s, i) => {
          const model = machine.plan.stages.find((p) => p.key === s.key)?.model ?? ''
          const timing = stageTimings?.[s.key]
          // Only surface a live "运行中" label while the OVERALL run is actually running. On
          // abort/failure the controller breaks before stamping `endedAt` and leaves the stage
          // status at 'running', which would otherwise render "运行中" forever on a dead run.
          const dur = timing?.endedAt != null
            ? fmtDuration(timing.endedAt - timing.startedAt)
            : (s.status === 'running' && status === 'running' ? '运行中' : '')
          return (
            <span key={s.key} className="run2-rail-item">
              {i > 0 && <span className="run2-rail-link" aria-hidden="true">→</span>}
              <span
                role="button"
                tabIndex={0}
                className={`run2-stage-chip run2-rail-node${i === machine.currentIndex ? ' current' : ''}${s.key === selectedStageKey ? ' selected' : ''} st-${s.status}`}
                onClick={() => onSelectStage(s.key)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectStage(s.key) } }}
              >
                <span className="run2-stage-glyph">{STAGE_GLYPH[s.status] ?? '·'}</span>
                <span className="run2-stage-key">{s.key}</span>
                {model && <span className="run2-rail-model">{model}</span>}
                {dur && <span className="run2-rail-dur">{dur}</span>}
              </span>
            </span>
          )
        })}
      </div>
      <RunControlBar api={api} />
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
// `logLines` (when present) renders the lane's recently buffered think/tool/file/output stream
// inline, right under the status row — the "see the execution" view this task adds.
function LiveLaneRow({ id, lane, logLines }: { id: string; lane: LiveLane; logLines?: RunLogLine[] }) {
  const label = lane.project ?? 'root'
  return (
    <div className="run2-lane-row live st-run">
      <span className="run2-lane-project">{label}</span>
      <span className="run2-lane-status">⟳ {lane.state ?? '执行中'}</span>
      {lane.activity && <span className="run2-lane-activity">{lane.activity}</span>}
      {logLines && logLines.length > 0 && <LaneLog lines={logLines} />}
      <LaneContext cwd={lane.cwd} />
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
      {hasLive && liveEntries.map(([id, l]) => <LiveLaneRow key={id} id={id} lane={l} logLines={api.laneLogs[id]} />)}
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
      <LaneContext cwd={outcome.order.cwd} />
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

function StageOutput({ api, selectedStageKey, gateStageKey, onOpenFile }: { api: Run2Api; selectedStageKey: string | undefined; gateStageKey: string | undefined; onOpenFile: (path: string, cwd: string | undefined) => void }) {
  const { outcomes, liveLanes } = api.state!
  const stageOutcomes = selectedStageKey ? outcomes[selectedStageKey] : undefined
  const liveEntries = selectedStageKey
    ? Object.entries(liveLanes).filter(([, l]) => l.stageKey === selectedStageKey)
    : []
  const hasOutcomes = !!stageOutcomes && stageOutcomes.length > 0
  const hasLive = liveEntries.length > 0
  // Shown when the currently-displayed stage's output is on screen BECAUSE a gate is pending on
  // it (i.e. this is the gate-focus default, not just an incidental match from a user chip
  // click on the same key — though visually the two are indistinguishable and that's fine: the
  // hint is correct either way since the gate really is pending on this stage).
  const showGateHint = !!gateStageKey && selectedStageKey === gateStageKey
  return (
    <div className="run2-stage-output">
      {showGateHint && (
        <div className="run2-gate-review-hint">⬇ 这是待你审核的产出，看完在收件箱决定 通过/打回/回退</div>
      )}
      <div className="run2-stage-output-title">阶段产出{selectedStageKey ? `：${selectedStageKey}` : ''}</div>
      {hasOutcomes && stageOutcomes!.map((o) => <OutcomeCard key={o.order.id} outcome={o} onOpenFile={onOpenFile} />)}
      {!hasOutcomes && hasLive && liveEntries.map(([id, l]) => <LiveLaneRow key={id} id={id} lane={l} logLines={api.laneLogs[id]} />)}
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

export function RunPanel({ api, onOpenLog }: RunPanelProps) {
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
  const { machine, inbox } = api.state
  const currentKey = machine.stages[machine.currentIndex]?.key
  // A pending gate's stage takes priority over "follow current stage" (but not over an explicit
  // user chip click) — the user should land on the stage they need to review, not wherever the
  // machine happens to be pointed.
  const gateStageKey = (inbox.find((e) => e.kind === 'gate') as GateEvent | undefined)?.stageKey
  const effectiveKey = selectedStageKey ?? gateStageKey ?? currentKey
  return (
    <div className="run2-panel">
      <RunHead api={api} selectedStageKey={effectiveKey} onSelectStage={setSelectedStageKey} />
      {onOpenLog && (
        <button type="button" className="txt-btn run2-open-logcon" onClick={onOpenLog}>看实时日志</button>
      )}
      <CurrentStageLane api={api} />
      <StageOutput
        api={api}
        selectedStageKey={effectiveKey}
        gateStageKey={gateStageKey}
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
