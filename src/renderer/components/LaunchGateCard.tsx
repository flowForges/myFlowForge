import { useEffect, useRef, useState } from 'react'
import type { ProviderInfo } from '@shared/types'
// Reuses the wfo-tab / wfo-proj / wfo-model / wfo-mpop / wfo-sec(-h) / wfo-goal classes — and their
// exact wrapper markup — straight from the launch-config region of WorkflowOverlay.tsx — port only,
// no import of that component (it is slated for deletion once run2's chat-inline cards replace it,
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
  // stages: the workflow's resolved flow (需求梳理→设计→开发→测试→评审…) so switching workflow tabs shows
  // the whole pipeline, not just a project list. `code` = the stage fans out per-project/writes code;
  // `gate` = it pauses for confirmation. Empty for rehydrated (frozen) gates — they render a static record.
  workflows: { id: string; name: string; stageCount: number; stages: { key: string; name: string; gate: boolean; code: boolean }[] }[]
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
  // P1-3 follow-up fix: set when the last confirm's run2.start rejected (unknown workflow, missing
  // workspace, …) — the card stays active (not frozen) so the user can edit/retry instead of being
  // stuck behind a permanent false-positive "已启动" record.
  error?: string
  // Improvement ⑦: real, locally-discovered providers/models — the SAME source Composer.tsx uses
  // for its own model dropdown (ProviderInfo[] threaded down from App → WorkspaceView → here as a
  // prop, keeping this a pure presentational component). Drives the model-chip popup below; when a
  // project's provider isn't in this list (not installed / not yet loaded), the popup degrades to a
  // free-text "自定义模型…" input — mirroring Composer's own custom-model fallback — never a
  // hardcoded catalog.
  providers?: ProviderInfo[]
  // 「⚡ 自动」(autoDecide) launched this gate — it auto-confirms without user input. Render a compact,
  // non-interactive "自动启动中" placeholder instead of the editable gate so no confirm/cancel flashes
  // before it freezes. Ignored once `frozen` (shows the 已启动 record) or `error` (falls back to the
  // editable gate for manual retry) is set.
  pending?: boolean
  // The AI requirement summary is still being generated (WorkspaceView.onPickWorkflow). While true the
  // 原始需求 area shows a "正在总结…" placeholder instead of the editable textarea; once false, config.seed
  // holds the summary (or the raw-transcript fallback) and the textarea takes over.
  seedLoading?: boolean
  onConfirm: (c: LaunchGateConfig) => void
  onCancel: () => void
}

function findProvider(providers: ProviderInfo[], providerId: string): ProviderInfo | undefined {
  return providers.find((p) => p.id === providerId)
}
function modelLabel(providers: ProviderInfo[], provider: string, model: string): string {
  const p = findProvider(providers, provider)
  const m = p?.models.find((mm) => mm.id === model)
  const providerName = p?.displayName ?? provider
  if (!model) return `${providerName} · 选模型`
  return `${providerName} · ${m?.label ?? model}`
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

export function LaunchGateCard({ config, frozen, error, pending, seedLoading, providers = [], onConfirm, onCancel }: LaunchGateCardProps) {
  // Pure presentational: mirror the incoming config into local state so checkboxes/model chip/
  // supplement are editable in this card without the caller re-rendering it on every keystroke.
  // onConfirm reports back the (possibly edited) mirror; config.seed/workflows pass through as-is.
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(config.selectedWorkflowId)
  const [projects, setProjects] = useState(config.projects)
  const [supplement, setSupplement] = useState(config.supplement)
  // Editable requirement, pre-filled from the AI summary. Re-sync only when config.seed's STRING value
  // changes (the async summary lands: '' → summary) — a stable string won't re-fire, so user edits after
  // the summary arrives are never clobbered.
  const [seed, setSeed] = useState(config.seed)
  useEffect(() => { setSeed(config.seed) }, [config.seed])
  // Improvement ⑦: which project's model popup (.wfo-mpop) is open, if any — replaces the old
  // click-to-cycle behavior. `null` = closed.
  const [modelPopupFor, setModelPopupFor] = useState<string | null>(null)
  // Which project's provider (编码代理) popup is open, if any — mirrors modelPopupFor. Only one of the
  // two popups is open at a time (opening one closes the other).
  const [providerPopupFor, setProviderPopupFor] = useState<string | null>(null)
  const [customModelDraft, setCustomModelDraft] = useState('')
  const cardRef = useRef<HTMLDivElement | null>(null)

  // Close whichever popup is open on any click outside it (or outside the chip that opened it) —
  // mirrors the usual popover UX; the confirm/cancel buttons below are also "outside" so this doesn't
  // block them.
  useEffect(() => {
    if (!modelPopupFor && !providerPopupFor) return
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (cardRef.current?.contains(target) && (target as Element).closest?.('.wfo-model, .wfo-mpop')) return
      setModelPopupFor(null)
      setProviderPopupFor(null)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [modelPopupFor, providerPopupFor])

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

  if (pending && !error) {
    const workflowName = config.workflows.find((w) => w.id === config.selectedWorkflowId)?.name ?? config.selectedWorkflowId
    const autoProjects = config.projects.filter((p) => p.selected).map((p) => p.name)
    return (
      <div className="msg-req k-confirm" data-req="launch-gate">
        <div className="req-head">
          <span className="req-kind">⚡ 自动启动工作流</span>
        </div>
        <div className="req-body">
          <div className="wfo-sec-h">原始需求</div>
          <div className="req-sub">{config.seed}</div>
          <div className="req-title">{workflowName}</div>
          <div className="req-sub">涉及项目：{autoProjects.length ? autoProjects.join('、') : '（无）'}</div>
          <div className="req-sub lg-decided-at">正在启动…（已开启「⚡ 自动」，未弹确认门）</div>
        </div>
      </div>
    )
  }

  const toggleProject = (name: string) => {
    setProjects((prev) => prev.map((p) => (p.name === name ? { ...p, selected: !p.selected } : p)))
  }
  const toggleModelPopup = (name: string) => {
    setCustomModelDraft('')
    setProviderPopupFor(null)
    setModelPopupFor((prev) => (prev === name ? null : name))
  }
  const chooseProjectModel = (name: string, modelId: string) => {
    setProjects((prev) => prev.map((p) => (p.name === name ? { ...p, model: modelId } : p)))
    setModelPopupFor(null)
  }
  const toggleProviderPopup = (name: string) => {
    setModelPopupFor(null)
    setProviderPopupFor((prev) => (prev === name ? null : name))
  }
  // Changing a project's provider clears its model (the old model id belongs to the old provider) —
  // the model chip then shows "选模型" until the user picks one for the new provider.
  const chooseProjectProvider = (name: string, providerId: string) => {
    setProjects((prev) => prev.map((p) => (p.name === name ? { ...p, provider: providerId, model: '' } : p)))
    setProviderPopupFor(null)
  }
  const installedProviders = providers.filter((p) => p.installed)
  const confirm = () => {
    onConfirm({ seed, workflows: config.workflows, selectedWorkflowId, projects, supplement })
  }

  const selectedCount = projects.filter((p) => p.selected).length
  const selectedStages = config.workflows.find((w) => w.id === selectedWorkflowId)?.stages ?? []

  return (
    <div className="msg-req k-confirm" data-req="launch-gate" ref={cardRef}>
      <div className="req-head">
        <span className="req-kind">开启工作流</span>
      </div>
      <div className="req-body">
        <div className="wfo-sec-h">原始需求{seedLoading ? '' : '（AI 总结，可编辑）'}</div>
        {seedLoading ? (
          <div className="lg-seed-loading"><span className="lg-seed-spin" />正在根据对话总结需求…</div>
        ) : (
          <textarea
            className="lg-seed-input"
            rows={3}
            value={seed}
            placeholder="本次要做的需求（可修正 AI 的总结）…"
            onChange={(e) => setSeed(e.target.value)}
          />
        )}

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

        {selectedStages.length > 0 ? (
          <div className="wfo-sec">
            <div className="wfo-sec-h">工作流阶段<span className="c">{selectedStages.length} 步</span></div>
            <div className="lg-flow">
              {selectedStages.map((s, i) => (
                <span key={s.key} className="lg-flow-step">
                  <span className="lg-flow-name">{s.name}</span>
                  {s.code ? <span className="lg-flow-tag">写码</span> : null}
                  {s.gate ? <span className="lg-flow-tag gate">门</span> : null}
                  {i < selectedStages.length - 1 ? <span className="lg-flow-arrow">→</span> : null}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="wfo-sec">
          <div className="wfo-sec-h">
            涉及代码项目
            <span className="c">已选 {selectedCount} / {projects.length}</span>
          </div>
          {projects.map((p) => {
            const providerInfo = findProvider(providers, p.provider)
            const models = providerInfo?.models ?? []
            return (
              <div key={p.name} className={`wfo-proj${p.selected ? ' on' : ''}`}>
                <span className="wfo-ckhit" onClick={() => toggleProject(p.name)}>
                  <span className="wfo-ck" dangerouslySetInnerHTML={{ __html: CHECK_SVG }} />
                  <span className="pn">
                    <b>{p.name}</b>
                    <span>{p.provider}</span>
                  </span>
                </span>
                {p.selected ? (
                  <span className="wfo-model sm lg-provider-chip" style={{ position: 'relative' }} onClick={() => toggleProviderPopup(p.name)}>
                    <span className="mv">{providerInfo?.displayName ?? p.provider ?? '选代理'}</span>
                    {providerPopupFor === p.name ? (
                      <div className="wfo-mpop" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
                        <div className="mh">编码代理</div>
                        {installedProviders.map((pv) => (
                          <button
                            key={pv.id}
                            type="button"
                            className={pv.id === p.provider ? 'on' : ''}
                            onClick={() => chooseProjectProvider(p.name, pv.id)}
                          >
                            {pv.displayName}
                            <span className="ck" dangerouslySetInnerHTML={{ __html: CHECK_SVG }} />
                          </button>
                        ))}
                        {installedProviders.length === 0 ? (
                          <div className="wfo-mpop-empty">
                            <div className="req-sub">未发现已安装的编码代理</div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </span>
                ) : null}
                {p.selected ? (
                  <span className="wfo-model sm lg-model-chip" style={{ position: 'relative' }} onClick={() => toggleModelPopup(p.name)}>
                    <span className="dot" style={{ background: 'var(--accent)' }} />
                    <span className="mv">{modelLabel(providers, p.provider, p.model)}</span>
                    {modelPopupFor === p.name ? (
                      <div className="wfo-mpop" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
                        <div className="mh">{providerInfo?.displayName ?? p.provider} · 选择模型</div>
                        {models.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            className={m.id === p.model ? 'on' : ''}
                            onClick={() => chooseProjectModel(p.name, m.id)}
                          >
                            <span className="dot" style={{ background: 'var(--accent)' }} />
                            {m.label}
                            <span className="ck" dangerouslySetInnerHTML={{ __html: CHECK_SVG }} />
                          </button>
                        ))}
                        {models.length === 0 ? (
                          <div className="wfo-mpop-empty">
                            <div className="req-sub">未发现该编码代理的可用模型，可手动输入</div>
                            <input
                              className="wfo-mpop-input"
                              autoFocus
                              placeholder="输入模型 id"
                              value={customModelDraft}
                              onChange={(e) => setCustomModelDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && customModelDraft.trim()) {
                                  e.preventDefault()
                                  chooseProjectModel(p.name, customModelDraft.trim())
                                } else if (e.key === 'Escape') {
                                  setModelPopupFor(null)
                                }
                              }}
                            />
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>

        <div className="wfo-goal">
          <textarea
            rows={2}
            placeholder="补充说明…（可选）"
            value={supplement}
            onChange={(e) => setSupplement(e.target.value)}
          />
        </div>

        {error ? <div className="req-sub lg-error">{error}</div> : null}

        <div className="req-actions">
          <button className="req-ok" onClick={confirm}>确认</button>
          <button className="req-no" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  )
}
