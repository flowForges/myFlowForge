import { useState } from 'react'
// Reuses the wfo-tab / wfo-proj / wfo-model / wfo-sec(-h) / wfo-goal classes — and their exact
// wrapper markup — straight from the launch-config region of WorkflowOverlay.tsx — port only, no
// import of that component (it is slated for deletion once run2's chat-inline cards replace it,
// see P1 plan). launchGateCard.css holds only the handful of rules with no wfo-* equivalent
// (the "原始需求" seed label and the frozen record's decided-at timestamp).
import './workflowOverlay.css'
import './launchGateCard.css'

// Task P1-2: LaunchGateCard — in-chat launch gate for a run2 workflow. 活态(此文件的主渲染分支)
// shows ①seed(只读) ②workflow tabs ③per-project checkbox+model chip ④supplement textarea+确认/取消;
// 凝固态(`frozen` set) renders a static read-only record of what was decided, no buttons — this is
// what the card looks like for the rest of the chat history after the user confirms/the run starts.
export interface LaunchGateConfig {
  seed: string
  workflows: { id: string; name: string; stageCount: number }[]
  selectedWorkflowId: string
  projects: { name: string; selected: boolean; provider: string; model: string }[]
  supplement: string
}

export interface LaunchGateFrozen {
  workflowName: string
  projects: string[]
  supplement: string
  decidedAt: number
}

export interface LaunchGateCardProps {
  config: LaunchGateConfig
  frozen?: LaunchGateFrozen
  onConfirm: (c: LaunchGateConfig) => void
  onCancel: () => void
}

// Small static catalog for the per-project model chip's click-to-cycle behavior — mirrors
// WorkflowOverlay's MODELS table (reference lines 84-90) but keeps provider/model as separate
// fields (matching LaunchGateConfig's shape) rather than a single combined label.
const MODEL_CATALOG: { provider: string; model: string; label: string; color: string }[] = [
  { provider: 'claude', model: 'claude-opus-4-8', label: 'Claude · opus-4.8', color: 'oklch(70% .15 35)' },
  { provider: 'claude', model: 'claude-sonnet-4-6', label: 'Claude · sonnet-4.6', color: 'oklch(72% .13 235)' },
  { provider: 'claude', model: 'claude-haiku-4-5', label: 'Claude · haiku-4.5', color: 'oklch(74% .12 200)' },
  { provider: 'codex', model: 'gpt-5-codex', label: 'Codex · gpt-5-codex', color: 'oklch(78% .03 250)' },
  { provider: 'gemini', model: 'gemini-2.5-pro', label: 'Gemini · gemini-2.5-pro', color: 'oklch(72% .15 275)' },
]

function findModel(provider: string, model: string) {
  return MODEL_CATALOG.find((m) => m.provider === provider && m.model === model)
}
function modelLabel(provider: string, model: string): string {
  return findModel(provider, model)?.label ?? `${provider} · ${model}`
}
function modelColor(provider: string, model: string): string {
  return findModel(provider, model)?.color ?? 'var(--muted)'
}
// Cycles to the next catalog entry (MVP model picker — same simplification WorkflowOverlay made;
// a full popover is out of scope here). Falls back to the first entry if provider/model isn't in
// the catalog (an unrecognized combo passed in via config).
function nextModel(provider: string, model: string): { provider: string; model: string } {
  const idx = MODEL_CATALOG.findIndex((m) => m.provider === provider && m.model === model)
  const next = MODEL_CATALOG[(idx + 1 + MODEL_CATALOG.length) % MODEL_CATALOG.length]
  return { provider: next.provider, model: next.model }
}

function fmtDecidedAt(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

// Verbatim check-glyph from WorkflowOverlay's IC.check (reference line 70) — kept as a tiny local
// copy rather than importing IC (a private const of that component).
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'

export function LaunchGateCard({ config, frozen, onConfirm, onCancel }: LaunchGateCardProps) {
  // Pure presentational: mirror the incoming config into local state so checkboxes/model chip/
  // supplement are editable in this card without the caller re-rendering it on every keystroke.
  // onConfirm reports back the (possibly edited) mirror; config.seed/workflows pass through as-is.
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(config.selectedWorkflowId)
  const [projects, setProjects] = useState(config.projects)
  const [supplement, setSupplement] = useState(config.supplement)

  if (frozen) {
    return (
      <div className="msg-req k-confirm done" data-req="launch-gate">
        <div className="req-head">
          <span className="req-kind">工作流已启动</span>
        </div>
        <div className="req-body">
          <div className="wfo-sec-h">原始需求</div>
          <div className="req-sub">{config.seed}</div>
          <div className="req-title">{frozen.workflowName}</div>
          <div className="req-sub">涉及项目：{frozen.projects.length ? frozen.projects.join('、') : '（无）'}</div>
          {frozen.supplement ? <div className="req-sub">补充：{frozen.supplement}</div> : null}
          <div className="req-sub lg-decided-at">{fmtDecidedAt(frozen.decidedAt)}</div>
        </div>
      </div>
    )
  }

  const toggleProject = (name: string) => {
    setProjects((prev) => prev.map((p) => (p.name === name ? { ...p, selected: !p.selected } : p)))
  }
  const cycleProjectModel = (name: string) => {
    setProjects((prev) => prev.map((p) => (p.name === name ? { ...p, ...nextModel(p.provider, p.model) } : p)))
  }
  const confirm = () => {
    onConfirm({ seed: config.seed, workflows: config.workflows, selectedWorkflowId, projects, supplement })
  }

  const selectedCount = projects.filter((p) => p.selected).length

  return (
    <div className="msg-req k-confirm" data-req="launch-gate">
      <div className="req-head">
        <span className="req-kind">开启工作流</span>
      </div>
      <div className="req-body">
        <div className="wfo-sec-h">原始需求</div>
        <div className="req-sub">{config.seed}</div>

        <div className="wfo-tabs">
          {config.workflows.map((w) => (
            <button
              key={w.id}
              type="button"
              className={`wfo-tab${w.id === selectedWorkflowId ? ' on' : ''}`}
              onClick={() => setSelectedWorkflowId(w.id)}
            >
              {w.name}
              <span className="n">{w.stageCount}</span>
            </button>
          ))}
        </div>

        <div className="wfo-sec">
          <div className="wfo-sec-h">
            涉及代码项目
            <span className="c">已选 {selectedCount} / {projects.length}</span>
          </div>
          {projects.map((p) => (
            <div key={p.name} className={`wfo-proj${p.selected ? ' on' : ''}`}>
              <span className="wfo-ckhit" onClick={() => toggleProject(p.name)}>
                <span className="wfo-ck" dangerouslySetInnerHTML={{ __html: CHECK_SVG }} />
                <span className="pn">
                  <b>{p.name}</b>
                  <span>{p.provider}</span>
                </span>
              </span>
              {p.selected ? (
                <span className="wfo-model sm" onClick={() => cycleProjectModel(p.name)}>
                  <span className="dot" style={{ background: modelColor(p.provider, p.model) }} />
                  <span className="mv">{modelLabel(p.provider, p.model)}</span>
                </span>
              ) : null}
            </div>
          ))}
        </div>

        <div className="wfo-goal">
          <textarea
            rows={2}
            placeholder="补充说明…（可选）"
            value={supplement}
            onChange={(e) => setSupplement(e.target.value)}
          />
        </div>

        <div className="req-actions">
          <button className="req-ok" onClick={confirm}>确认</button>
          <button className="req-no" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  )
}
