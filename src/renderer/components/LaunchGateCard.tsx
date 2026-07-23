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
  // stages: the workflow's resolved flow (需求梳理→设计→开发→测试→评审…). `code` = the stage fans out
  // per-project/writes code (its provider/model comes from the per-project pickers, not a per-stage one);
  // `gate` = it pauses for confirmation; `provider`/`model` = the stage's default agent (editable in the
  // gate for non-code stages). Empty for rehydrated (frozen) gates — they render a static record.
  workflows: { id: string; name: string; stageCount: number; stages: { key: string; name: string; gate: boolean; code: boolean; provider: string; model: string }[] }[]
  selectedWorkflowId: string
  projects: { name: string; selected: boolean; provider: string; model: string }[]
  supplement: string
  // Workflow-scope hooks (workspace-wide, from LaunchInfo.hooks) shown with on/off toggles.
  hooks?: { id: string; name: string; after: string }[]
  // Interactive results the card fills on confirm (like `projects` carries edited selection): which
  // stages/hooks to run + per-stage provider/model overrides. WorkspaceView maps these into the run's
  // LaunchStartConfig.stages/hooks. Absent on rehydrated/old configs → run everything (backward compat).
  stageChoices?: { key: string; enabled: boolean; provider: string; model: string }[]
  hookChoices?: { id: string; enabled: boolean }[]
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
  // Returns the names of the workspace's projects with uncommitted changes. When provided, the first
  // 确认 with a dirty selected project shows a "会自动 stash 保存并在结束后恢复" warning + a 仍要启动
  // button instead of launching immediately — so the user knows their changes are set aside safely.
  checkDirty?: () => Promise<string[]>
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

export function LaunchGateCard({ config, frozen, error, pending, seedLoading, providers = [], onConfirm, onCancel, checkDirty }: LaunchGateCardProps) {
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
  // #1+#3: per-stage on/off + provider/model override. Keyed by stage key; re-inits when the workflow
  // tab changes (a different workflow has a different stage set). Unchecking a stage drops it from the
  // run plan (buildLaunchPlan) — that's how 跳过某阶段 works, instead of hoping the agent reads the
  // supplement. Non-code (root) stages also get a provider/model picker (code stages take theirs from
  // the per-project pickers below).
  const stagesOf = (wfId: string) => config.workflows.find((w) => w.id === wfId)?.stages ?? []
  const initStageState = (wfId: string) =>
    Object.fromEntries(stagesOf(wfId).map((s) => [s.key, { enabled: true, provider: s.provider, model: s.model }]))
  const [stageState, setStageState] = useState<Record<string, { enabled: boolean; provider: string; model: string }>>(() => initStageState(config.selectedWorkflowId))
  useEffect(() => { setStageState(initStageState(selectedWorkflowId)) }, [selectedWorkflowId]) // eslint-disable-line react-hooks/exhaustive-deps
  // 既然阶段可选,hook 也可选(workspace 级 hooks,不随工作流切换)。默认全开。
  const [hookState, setHookState] = useState<Record<string, boolean>>(() => Object.fromEntries((config.hooks ?? []).map((h) => [h.id, true])))
  // Improvement ⑦: which project's model popup (.wfo-mpop) is open, if any — replaces the old
  // click-to-cycle behavior. `null` = closed.
  const [modelPopupFor, setModelPopupFor] = useState<string | null>(null)
  // Which project's provider (编码代理) popup is open, if any — mirrors modelPopupFor. Only one of the
  // two popups is open at a time (opening one closes the other).
  const [providerPopupFor, setProviderPopupFor] = useState<string | null>(null)
  const [customModelDraft, setCustomModelDraft] = useState('')
  // Dirty-tree warning: null = not checked yet; [] = checked, all clean; [names] = dirty selected
  // projects, first 确认 shows the warning and the button becomes 仍要启动 (a second click launches).
  // Declared with the other hooks (before any `frozen` early return) so hook order stays stable.
  const [dirtyWarn, setDirtyWarn] = useState<string[] | null>(null)
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
  // Changing a project's provider must ALSO switch the model to the new provider's default — the old
  // model id belongs to the old provider. Critically it must NOT be left '' : the run's fanout resolves
  // `p.model || stage.model`, so an empty model silently falls back to the STAGE's default model (a
  // claude model id) while the provider is now e.g. qoder → a qoder lane mislabeled/run as a claude
  // model. Default to the new provider's first discovered model (user can still refine via the chip).
  const chooseProjectProvider = (name: string, providerId: string) => {
    const defaultModel = providers.find((p) => p.id === providerId)?.models[0]?.id ?? ''
    setProjects((prev) => prev.map((p) => (p.name === name ? { ...p, provider: providerId, model: defaultModel } : p)))
    setProviderPopupFor(null)
  }
  const installedProviders = providers.filter((p) => p.installed)
  // Stage popups share the same modelPopupFor/providerPopupFor state as projects — keyed with a
  // `stage:` prefix so a stage key can never collide with a project name.
  const stageKeyOf = (stageKey: string) => `stage:${stageKey}`
  const stageDefault = (key: string) => { const s = stagesOf(selectedWorkflowId).find((x) => x.key === key); return { enabled: true, provider: s?.provider ?? '', model: s?.model ?? '' } }
  const toggleStage = (key: string) => setStageState((prev) => { const cur = prev[key] ?? stageDefault(key); return { ...prev, [key]: { ...cur, enabled: !cur.enabled } } })
  const chooseStageProvider = (key: string, providerId: string) => {
    const dm = providers.find((p) => p.id === providerId)?.models[0]?.id ?? ''
    setStageState((prev) => ({ ...prev, [key]: { ...(prev[key] ?? stageDefault(key)), provider: providerId, model: dm } }))
    setProviderPopupFor(null)
  }
  const chooseStageModel = (key: string, modelId: string) => {
    setStageState((prev) => ({ ...prev, [key]: { ...(prev[key] ?? stageDefault(key)), model: modelId } }))
    setModelPopupFor(null)
  }
  const toggleHook = (id: string) => setHookState((prev) => ({ ...prev, [id]: prev[id] === false }))
  const hookWhen = (after: string) => (after === '__start' ? '开始前' : after === '__wf' ? '全部结束后' : `阶段「${after}」后`)
  const doConfirm = () => {
    const stageChoices = stagesOf(selectedWorkflowId).map((s) => {
      const st = stageState[s.key] ?? stageDefault(s.key)
      return { key: s.key, enabled: st.enabled, provider: st.provider, model: st.model }
    })
    const hookChoices = (config.hooks ?? []).map((h) => ({ id: h.id, enabled: hookState[h.id] !== false }))
    onConfirm({ seed, workflows: config.workflows, selectedWorkflowId, projects, supplement, hooks: config.hooks, stageChoices, hookChoices })
  }
  const confirm = async () => {
    if (checkDirty && dirtyWarn === null) {
      let dirty: string[] = []
      try { dirty = await checkDirty() } catch { dirty = [] }
      const selectedDirty = dirty.filter((name) => projects.some((p) => p.selected && p.name === name))
      setDirtyWarn(selectedDirty)
      if (selectedDirty.length > 0) return   // warn first; the next 仍要启动 click launches
    }
    doConfirm()
  }

  const selectedCount = projects.filter((p) => p.selected).length
  const selectedStages = config.workflows.find((w) => w.id === selectedWorkflowId)?.stages ?? []
  const enabledStageCount = selectedStages.filter((s) => stageState[s.key]?.enabled ?? true).length

  // Shared provider + model chip pair (used by both per-project rows and per-stage rows). popupKey
  // namespaces the open-popup state so a project and a stage never fight over the same popup.
  const renderChips = (popupKey: string, provider: string, model: string, onProvider: (id: string) => void, onModel: (id: string) => void) => {
    const providerInfo = findProvider(providers, provider)
    const models = providerInfo?.models ?? []
    return (
      <>
        <span className="wfo-model sm lg-provider-chip" style={{ position: 'relative' }} onClick={() => toggleProviderPopup(popupKey)}>
          <span className="mv">{providerInfo?.displayName ?? provider ?? '选代理'}</span>
          {providerPopupFor === popupKey ? (
            <div className="wfo-mpop" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
              <div className="mh">编码代理</div>
              {installedProviders.map((pv) => (
                <button key={pv.id} type="button" className={pv.id === provider ? 'on' : ''} onClick={() => onProvider(pv.id)}>
                  {pv.displayName}
                  <span className="ck" dangerouslySetInnerHTML={{ __html: CHECK_SVG }} />
                </button>
              ))}
              {installedProviders.length === 0 ? (<div className="wfo-mpop-empty"><div className="req-sub">未发现已安装的编码代理</div></div>) : null}
            </div>
          ) : null}
        </span>
        <span className="wfo-model sm lg-model-chip" style={{ position: 'relative' }} onClick={() => toggleModelPopup(popupKey)}>
          <span className="dot" style={{ background: 'var(--accent)' }} />
          <span className="mv">{modelLabel(providers, provider, model)}</span>
          {modelPopupFor === popupKey ? (
            <div className="wfo-mpop" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
              <div className="mh">{providerInfo?.displayName ?? provider} · 选择模型</div>
              {models.map((m) => (
                <button key={m.id} type="button" className={m.id === model ? 'on' : ''} onClick={() => onModel(m.id)}>
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
                      if (e.key === 'Enter' && customModelDraft.trim()) { e.preventDefault(); onModel(customModelDraft.trim()) }
                      else if (e.key === 'Escape') { setModelPopupFor(null) }
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </span>
      </>
    )
  }

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
            <div className="wfo-sec-h">工作流阶段<span className="c">已选 {enabledStageCount} / {selectedStages.length}</span></div>
            {selectedStages.map((s) => {
              const st = stageState[s.key] ?? stageDefault(s.key)
              return (
                <div key={s.key} className={`wfo-proj${st.enabled ? ' on' : ''}`}>
                  <span className="wfo-ckhit" onClick={() => toggleStage(s.key)}>
                    <span className="wfo-ck" dangerouslySetInnerHTML={{ __html: CHECK_SVG }} />
                    <span className="pn">
                      <b>{s.name}</b>
                      <span>{s.code ? '按项目并行 · 写码' : '单代理'}{s.gate ? ' · 门' : ''}</span>
                    </span>
                  </span>
                  {st.enabled && !s.code
                    ? renderChips(stageKeyOf(s.key), st.provider, st.model, (id) => chooseStageProvider(s.key, id), (id) => chooseStageModel(s.key, id))
                    : st.enabled && s.code
                    ? <span className="wfo-model sm ro">按项目设置</span>
                    : null}
                </div>
              )
            })}
          </div>
        ) : null}

        <div className="wfo-sec">
          <div className="wfo-sec-h">
            涉及代码项目
            <span className="c">已选 {selectedCount} / {projects.length}</span>
          </div>
          {projects.map((p) => {
            return (
              <div key={p.name} className={`wfo-proj${p.selected ? ' on' : ''}`}>
                <span className="wfo-ckhit" onClick={() => toggleProject(p.name)}>
                  <span className="wfo-ck" dangerouslySetInnerHTML={{ __html: CHECK_SVG }} />
                  <span className="pn">
                    <b>{p.name}</b>
                    <span>{p.provider}</span>
                  </span>
                </span>
                {p.selected
                  ? renderChips(p.name, p.provider, p.model, (id) => chooseProjectProvider(p.name, id), (id) => chooseProjectModel(p.name, id))
                  : null}
              </div>
            )
          })}
        </div>

        {(config.hooks ?? []).length > 0 ? (
          <div className="wfo-sec">
            <div className="wfo-sec-h">
              Hook 步骤
              <span className="c">已选 {(config.hooks ?? []).filter((h) => hookState[h.id] !== false).length} / {(config.hooks ?? []).length}</span>
            </div>
            {(config.hooks ?? []).map((h) => (
              <div key={h.id} className={`wfo-proj${hookState[h.id] !== false ? ' on' : ''}`}>
                <span className="wfo-ckhit" onClick={() => toggleHook(h.id)}>
                  <span className="wfo-ck" dangerouslySetInnerHTML={{ __html: CHECK_SVG }} />
                  <span className="pn">
                    <b>{h.name}</b>
                    <span>{hookWhen(h.after)}</span>
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="wfo-goal">
          <textarea
            rows={2}
            placeholder="补充说明…（可选）"
            value={supplement}
            onChange={(e) => setSupplement(e.target.value)}
          />
        </div>

        {error ? <div className="req-sub lg-error">{error}</div> : null}

        {dirtyWarn && dirtyWarn.length > 0 ? (
          <div className="lg-dirty-warn">
            <b>{dirtyWarn.join('、')}</b> 有未提交的改动。启动后会自动 <b>git stash</b> 保存这些改动(不会删除),工作流在临时分支上执行,结束后合并回你的分支并<b>恢复</b>你的改动。确认继续?
          </div>
        ) : null}

        <div className="req-actions">
          <button className="req-ok" onClick={confirm} disabled={selectedStages.length > 0 && enabledStageCount === 0} title={selectedStages.length > 0 && enabledStageCount === 0 ? '至少保留一个阶段' : undefined}>{dirtyWarn && dirtyWarn.length > 0 ? '仍要启动' : '确认'}</button>
          <button className="req-no" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  )
}
