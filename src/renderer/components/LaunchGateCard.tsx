import { Fragment, useEffect, useRef, useState } from 'react'
import type { ProviderInfo } from '@shared/types'
import type { ProjectBaseInfo } from '../../main/ipc/run2Handlers'
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
  workflows: { id: string; name: string; stageCount: number; stages: { key: string; name: string; gate: boolean; code: boolean; producesDoc?: boolean; lensCount?: number; provider: string; model: string; projectAgents?: { name: string; provider: string; model: string }[] }[] }[]
  selectedWorkflowId: string
  projects: { name: string; selected: boolean; provider: string; model: string }[]
  supplement: string
  // Workflow-scope hooks (workspace-wide, from LaunchInfo.hooks) shown with on/off toggles.
  hooks?: { id: string; name: string; after: string }[]
  // Interactive results the card fills on confirm (like `projects` carries edited selection): which
  // stages/hooks to run + per-stage provider/model overrides. WorkspaceView maps these into the run's
  // LaunchStartConfig.stages/hooks. Absent on rehydrated/old configs → run everything (backward compat).
  stageChoices?: { key: string; enabled: boolean; provider: string; model: string; perProject?: boolean; projects?: { name: string; provider: string; model: string }[] }[]
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
  // Task 8: each workspace project's REAL currently-checked-out branch + uncommitted-change count —
  // the exact same measurement (currentBranch) createRunTempBranches uses to pick the run's base, so
  // this card never shows a branch different from the one the run will actually start from (that would
  // just be the original 2026-08-17 bug wearing a different hat). Rendered once in a dedicated 运行基准
  // section (see below) — NOT as a per-row suffix, since a project's row here is a per-STAGE lane
  // (rendered once per stage) and a suffix there would repeat the same line N times.
  baseInfo?: () => Promise<ProjectBaseInfo[]>
}

function findProvider(providers: ProviderInfo[], providerId: string): ProviderInfo | undefined {
  return providers.find((p) => p.id === providerId)
}
// Model-only label for the model chip: the provider chip already sits right next to it showing the
// provider name, so repeating it here (the old `${provider} · ${model}`) just duplicated text and — once
// truncated to the chip's max-width — showed "Claude Code · …" while hiding the ACTUAL model. Show the
// bare model (or a "选模型" prompt when unset).
function modelLabel(providers: ProviderInfo[], provider: string, model: string): string {
  if (!model) return '选模型'
  const p = findProvider(providers, provider)
  const m = p?.models.find((mm) => mm.id === model)
  return m?.label ?? model
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
// Terminal glyph for a lane's icon box (工作区 / 项目 card) — mirrors the execution panel's lane cards.
const TERM_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
// Puzzle glyph for an inline hook node on the pipeline (same path as HookNode's right-panel node) — so
// a hook reads as the SAME thing in the launch preview and in the running execution timeline.
const PUZZLE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.6 2.6 0 0 1 0 5.2H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.6 2.6 0 0 1 5.2 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z"/></svg>'

export function LaunchGateCard({ config, frozen, error, pending, seedLoading, providers = [], onConfirm, onCancel, baseInfo }: LaunchGateCardProps) {
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
  // A non-code, non-doc stage (写单测/代码CR) can be toggled between 单代理(root) and 按项目(per-project) at
  // launch. Doc stages (需求评估/技术方案设计) produce a single deliverable and code stages are already
  // per-project, so neither gets the toggle.
  const stageAllowsPerProject = (s: { code: boolean; producesDoc?: boolean }) => !s.code && !s.producesDoc
  const initStageState = (wfId: string) =>
    Object.fromEntries(stagesOf(wfId).map((s) => [s.key, { enabled: true, provider: s.provider, model: s.model, perProject: false }]))
  const [stageState, setStageState] = useState<Record<string, { enabled: boolean; provider: string; model: string; perProject: boolean }>>(() => initStageState(config.selectedWorkflowId))
  useEffect(() => { setStageState(initStageState(selectedWorkflowId)) }, [selectedWorkflowId]) // eslint-disable-line react-hooks/exhaustive-deps
  // 阶段级项目代理:`stageKey → 项目名 → provider/model`。让「按项目 CR」能挑一个跟「代码开发」不同的 agent。
  // 在这之前每个按项目阶段渲染的都是同一份全局项目数据,改一边另一边跟着变(用户报的「provider 是同步的」)。
  //
  // 只有 develop(写码阶段)例外:它的项目行仍然直接编辑全局项目 —— 项目的编码代理就是「开发用什么」的
  // 唯一真源,run/尾段/执行面板都读它,不能让开发在这儿分叉出第二份。其余按项目阶段一律走这里的覆盖,
  // 初值取工作区里配好的 projectAgents,没配就显示项目自己的编码代理(不写进 state ⇒ 不产生覆盖)。
  const initStageProjects = (wfId: string): Record<string, Record<string, { provider: string; model: string }>> =>
    Object.fromEntries(stagesOf(wfId)
      .filter((s) => !s.code && s.projectAgents?.length)
      .map((s) => [s.key, Object.fromEntries(s.projectAgents!.map((a) => [a.name, { provider: a.provider, model: a.model }]))]))
  const [stageProjects, setStageProjects] = useState<Record<string, Record<string, { provider: string; model: string }>>>(() => initStageProjects(config.selectedWorkflowId))
  useEffect(() => { setStageProjects(initStageProjects(selectedWorkflowId)) }, [selectedWorkflowId]) // eslint-disable-line react-hooks/exhaustive-deps
  // 该阶段该项目当前显示的编码代理:阶段覆盖 → 项目自己的。develop 恒等于项目自己的(见上)。
  const laneAgent = (stageKey: string, p: { name: string; provider: string; model: string }) =>
    stageProjects[stageKey]?.[p.name] ?? { provider: p.provider, model: p.model }
  // 既然阶段可选,hook 也可选(workspace 级 hooks,不随工作流切换)。默认全开。
  const [hookState, setHookState] = useState<Record<string, boolean>>(() => Object.fromEntries((config.hooks ?? []).map((h) => [h.id, true])))
  // Improvement ⑦: which project's model popup (.wfo-mpop) is open, if any — replaces the old
  // click-to-cycle behavior. `null` = closed.
  const [modelPopupFor, setModelPopupFor] = useState<string | null>(null)
  // Which project's provider (编码代理) popup is open, if any — mirrors modelPopupFor. Only one of the
  // two popups is open at a time (opening one closes the other).
  const [providerPopupFor, setProviderPopupFor] = useState<string | null>(null)
  // #3: whether the "统一编码代理" bulk picker is open. Switches EVERY provider selector (all non-code
  // stages + all projects) to one provider in a single click, instead of editing ~7 chips by hand.
  const [bulkPopupOpen, setBulkPopupOpen] = useState(false)
  const [customModelDraft, setCustomModelDraft] = useState('')
  // Task 8: 运行基准 — each project's real HEAD + dirty-line count, meant to be fetched exactly once
  // (a snapshot of "what would happen if you confirmed right now", same spirit as the rest of this
  // card's config — never polled). null = not loaded yet (section hidden). Declared with the other
  // hooks (before any `frozen` early return) so hook order stays stable.
  //
  // Task 8 fix round 1 (I3): the ORIGINAL version here depended on `baseInfo` alone and re-ran on
  // every prop change — but WorkspaceView.tsx builds a fresh `() => window.forge.run2.baseInfo(wsPath)`
  // arrow inline in JSX on every render (it's the chat host, re-rendering per streaming delta), so this
  // effect fired on nearly every render: an IPC round trip spawning `git rev-parse` + `git status
  // --porcelain` per project, discarded and refetched over and over. Worse, this section never even
  // renders once `frozen` (or the auto-launch `pending` placeholder) is showing — see the early
  // `return`s below — so every already-launched card left sitting in the chat transcript kept paying
  // this cost for the rest of the session for a section it would never draw. A ref-backed latch fixes
  // both: `fetchedBaseRef` makes the actual fetch run at most once per mount regardless of how many
  // times the effect body re-executes, and the guard skips it entirely once `frozen`/`pending` are known
  // (checked INSIDE the effect body, not by conditionally calling the hook — hooks can't be conditional).
  const [base, setBase] = useState<ProjectBaseInfo[] | null>(null)
  // Task 8 fix round 2 (cheap fix): a REJECTED baseInfo() call — the IPC round trip itself throwing,
  // not any individual project's `error` field (see run2Handlers.ts's ProjectBaseInfo.error) — used to
  // get folded into `setBase([])`, which the zero-row guard below then rendered as "nothing to show",
  // identical to a workspace with genuinely zero selected projects. That's silent: the measurement
  // failed outright and the launch gate gave no indication and no launch block, only a section that
  // just isn't there. Tracked separately so the render below can tell "measured: zero rows" apart from
  // "couldn't measure at all".
  const [baseFetchFailed, setBaseFetchFailed] = useState(false)
  const fetchedBaseRef = useRef(false)
  useEffect(() => {
    // Mirrors the two early `return`s below EXACTLY (`if (frozen)` / `if (pending && !error)`) — those
    // are the only states in which the 运行基准 section never renders, so those are the only states in
    // which fetching for it would be wasted work.
    if (!baseInfo || frozen || (pending && !error) || fetchedBaseRef.current) return
    fetchedBaseRef.current = true
    let cancelled = false
    baseInfo().then((b) => { if (!cancelled) setBase(b) }).catch(() => { if (!cancelled) setBaseFetchFailed(true) })
    return () => { cancelled = true }
  }, [baseInfo, frozen, pending, error])
  const cardRef = useRef<HTMLDivElement | null>(null)

  // Close whichever popup is open on any click outside it (or outside the chip that opened it) —
  // mirrors the usual popover UX; the confirm/cancel buttons below are also "outside" so this doesn't
  // block them.
  useEffect(() => {
    if (!modelPopupFor && !providerPopupFor && !bulkPopupOpen) return
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (cardRef.current?.contains(target) && (target as Element).closest?.('.wfo-model, .wfo-mpop, .lg-bulk-chip')) return
      setModelPopupFor(null)
      setProviderPopupFor(null)
      setBulkPopupOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [modelPopupFor, providerPopupFor, bulkPopupOpen])

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
  // 阶段级项目代理的写入口(非 develop 的按项目阶段)。同 chooseProjectProvider,换 provider 必须同时换成
  // 新 provider 的默认模型 —— 留着旧 model id 会造出「codex 拿 claude 模型」这种跑不起来的组合。
  const setStageProject = (stageKey: string, name: string, patch: { provider: string; model: string }) =>
    setStageProjects((prev) => ({ ...prev, [stageKey]: { ...(prev[stageKey] ?? {}), [name]: patch } }))
  const chooseStageProjectProvider = (stageKey: string, name: string, providerId: string) => {
    setStageProject(stageKey, name, { provider: providerId, model: providers.find((p) => p.id === providerId)?.models[0]?.id ?? '' })
    setProviderPopupFor(null)
  }
  const chooseStageProjectModel = (stageKey: string, p: { name: string; provider: string; model: string }, modelId: string) => {
    setStageProject(stageKey, p.name, { provider: laneAgent(stageKey, p).provider, model: modelId })
    setModelPopupFor(null)
  }
  const installedProviders = providers.filter((p) => p.installed)
  // #3: switch every provider selector to one provider at once. Applies to ALL projects AND ALL stages.
  // 修图1(2026-07-30):原本 `if (s.code) continue` 跳过代码类阶段(以为它们只从项目选择器取 provider)——
  // 但一个被存成 per-project 的阶段(如某些工作区里的「技术方案设计」)也是 code 类,会被跳过、留在模板默认
  // (claude),导致「统一编码代理→codex」对它无效。既然本函数也把所有项目设成同一 provider,一并设置每个
  // 阶段的 provider 无害且正确(per-project 阶段的 lane 仍走 `p.provider || stage.provider`,两者都成了 codex)。
  const applyProviderToAll = (providerId: string) => {
    const dm = providers.find((p) => p.id === providerId)?.models[0]?.id ?? ''
    setProjects((prev) => prev.map((p) => ({ ...p, provider: providerId, model: dm })))
    // 「全部设为」= 推倒重来:阶段级项目代理的覆盖一并清掉,否则它们会盖在上面,让这个「一键全部」名不副实。
    setStageProjects({})
    setStageState((prev) => {
      const next = { ...prev }
      for (const s of stagesOf(selectedWorkflowId)) {
        next[s.key] = { ...(next[s.key] ?? stageDefault(s.key)), provider: providerId, model: dm }
      }
      return next
    })
    setBulkPopupOpen(false)
  }
  // Stage popups share the same modelPopupFor/providerPopupFor state as projects — keyed with a
  // `stage:` prefix so a stage key can never collide with a project name.
  const stageKeyOf = (stageKey: string) => `stage:${stageKey}`
  const stageDefault = (key: string) => { const s = stagesOf(selectedWorkflowId).find((x) => x.key === key); return { enabled: true, provider: s?.provider ?? '', model: s?.model ?? '', perProject: false } }
  const toggleStage = (key: string) => setStageState((prev) => { const cur = prev[key] ?? stageDefault(key); return { ...prev, [key]: { ...cur, enabled: !cur.enabled } } })
  const setStagePerProject = (key: string, perProject: boolean) => setStageState((prev) => { const cur = prev[key] ?? stageDefault(key); return { ...prev, [key]: { ...cur, perProject } } })
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
      // 阶段级项目代理:只在这个阶段真被改过(或工作区里本来就配了)时才带,空着就让主进程回落到工作区那份。
      const agents = Object.entries(stageProjects[s.key] ?? {}).map(([name, a]) => ({ name, provider: a.provider, model: a.model }))
      const base = { key: s.key, enabled: st.enabled, provider: st.provider, model: st.model, ...(agents.length ? { projects: agents } : {}) }
      // Only send perProject for toggle-eligible stages — sending it for develop/design would force their
      // scope and collapse the per-project fan-out they get by default (buildLaunchPlan honors it verbatim).
      return stageAllowsPerProject(s) ? { ...base, perProject: st.perProject } : base
    })
    const hookChoices = (config.hooks ?? []).map((h) => ({ id: h.id, enabled: hookState[h.id] !== false }))
    onConfirm({ seed, workflows: config.workflows, selectedWorkflowId, projects, supplement, hooks: config.hooks, stageChoices, hookChoices })
  }
  // Task 8: uncommitted changes are no longer an exception that needs a warn-then-confirm dance —
  // they ride along into the run's pre-run snapshot commit (tempBranch.ts's createTempBranch) same as
  // committed code, so 确认 (doConfirm, wired directly below) launches straight away. What DOES still
  // block: detached HEAD (see confirmBlocked below), because there's no branch to check the temp
  // branch out from.

  const allHooks = config.hooks ?? []
  const hooksFor = (afterKey: string) => allHooks.filter((h) => h.after === afterKey)
  const selectedCount = projects.filter((p) => p.selected).length
  const selectedStages = config.workflows.find((w) => w.id === selectedWorkflowId)?.stages ?? []
  // Hooks whose weave point isn't a stage in THIS workflow tab (nor __start/__wf) — e.g. after a stage
  // the picked workflow doesn't include. They'd vanish if only rendered inline, so they get a trailing
  // row (with an explicit 阶段「x」后 label since their position no longer conveys the timing).
  const stageKeySet = new Set(selectedStages.map((s) => s.key))
  const orphanHooks = allHooks.filter((h) => h.after !== '__start' && h.after !== '__wf' && !stageKeySet.has(h.after))
  const enabledStageCount = selectedStages.filter((s) => stageState[s.key]?.enabled ?? true).length
  // Whether a stage fans out per project: an inherently-code stage (代码开发) OR a toggle-eligible stage
  // the user switched to 按项目. Its lanes are the selected projects; a single-agent stage has one 工作区 lane.
  const isPerProjectStage = (s: { key: string; code: boolean; producesDoc?: boolean }, st: { perProject: boolean }) =>
    s.code || (stageAllowsPerProject(s) && st.perProject)
  // Guard confirm when an enabled per-project stage has no project selected — it would have zero lanes.
  const anyPerProjectEnabled = selectedStages.some((s) => { const st = stageState[s.key] ?? stageDefault(s.key); return st.enabled && isPerProjectStage(s, st) })
  const noProjectSelected = anyPerProjectEnabled && selectedCount === 0
  const noStageEnabled = selectedStages.length > 0 && enabledStageCount === 0
  // 什么都没说就不许启动:阶段 agent 手上只有一串项目名时会自己猜一个需求出来跑一堆东西(用户实测)。
  // 门槛压到最低——需求或补充说明任一有内容即可,所以「完全没聊过、直接在这儿手打一句」照样能启动。
  // 这里只是给人看的提示;真正拦住「⚡自动」那条路的是主进程 workflow:enter 里的同名守卫。
  const noRequirement = !seed.trim() && !supplement.trim()
  // Task 8: a selected project sitting on detached HEAD has no branch for createRunTempBranches to
  // check the temp branch out from (see launch.ts's createRunTempBranches) — block 启动 here too,
  // rather than letting the user hit a server-side rejection after already committing to launch.
  // Task 8 fix round 1 (cheap fix): a project run2:base-info couldn't read at all (`b.error` — missing
  // directory, not a repo, git absent…) is a DIFFERENT failure from detached HEAD, and must be checked
  // separately — otherwise it silently falls into the `!b.branch` detached-HEAD check below and gets
  // the wrong reason text ("有项目处于 detached HEAD" for a directory that isn't even there).
  const detachedSelected = (base ?? []).some((b) => !b.branch && !b.error && projects.some((p) => p.name === b.name && p.selected))
  const unreadableSelected = (base ?? []).some((b) => b.error && projects.some((p) => p.name === b.name && p.selected))
  // Task 8 fix round 2 (cheap fix): the IPC call ITSELF failing (baseFetchFailed) is stronger than any
  // single project's `b.error` — it means we know NOTHING about ANY project's branch, not just one.
  // Same treatment as detached HEAD / a single unreadable project: block launch rather than let the
  // user hit an unverified state, but only once `baseInfo` was actually offered (never blocks a caller
  // that doesn't wire this prop at all).
  const confirmBlocked = noStageEnabled || noProjectSelected || noRequirement || detachedSelected || unreadableSelected || baseFetchFailed
  const confirmBlockReason = noStageEnabled ? '至少保留一个阶段'
    : noProjectSelected ? '至少选择一个代码项目'
    : noRequirement ? '先说说这次要做什么（上面的需求框里写一句，或写在补充说明里）'
    : baseFetchFailed ? '读不出运行基准，请重试或联系开发者'
    : detachedSelected ? '有项目处于 detached HEAD'
    : unreadableSelected ? '有项目读不出当前分支'
    : undefined

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

  // An inline hook node on the pipeline (puzzle node on the rail + name + on/off toggle). `showWhen`
  // spells out the timing for orphan rows whose position no longer implies it. Placed between the
  // stages it weaves after, so the launch preview reads top-to-bottom exactly as the run will execute.
  const hookRow = (h: { id: string; name: string; after: string }, showWhen: boolean) => {
    const on = hookState[h.id] !== false
    return (
      <div key={`hook-${h.id}`} className={`lg-hook${on ? ' on' : ''}`}>
        <button type="button" className="lg-hook-node" onClick={() => toggleHook(h.id)} title="点击启用/停用该 hook">
          <span className="lg-hook-ic" dangerouslySetInnerHTML={{ __html: PUZZLE_SVG }} />
        </button>
        <span className="lg-hook-nm">
          <b>{h.name}</b>
          <span>插件 · HOOK{showWhen ? ` · ${hookWhen(h.after)}` : ''}</span>
        </span>
        <button type="button" className={`lg-hook-tog${on ? ' on' : ''}`} onClick={() => toggleHook(h.id)}>{on ? '已启用' : '已停用'}</button>
      </div>
    )
  }

  return (
    <div className="msg-req k-confirm" data-req="launch-gate" ref={cardRef}>
      <div className="req-head">
        <span className="req-kind">开启工作流</span>
      </div>
      <div className="req-body">
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

        {installedProviders.length > 0 ? (
          <div className="lg-bulk">
            <span className="lg-bulk-label">统一编码代理</span>
            <span className="wfo-model sm lg-bulk-chip" style={{ position: 'relative' }} onClick={() => { setModelPopupFor(null); setProviderPopupFor(null); setBulkPopupOpen((v) => !v) }}>
              <span className="mv">全部设为…</span>
              <span className="lg-bulk-caret">▾</span>
              {bulkPopupOpen ? (
                <div className="wfo-mpop" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
                  <div className="mh">把所有阶段/项目切成同一个代理</div>
                  {installedProviders.map((pv) => (
                    <button key={pv.id} type="button" onClick={() => applyProviderToAll(pv.id)}>
                      {pv.displayName}
                      <span className="ck" dangerouslySetInnerHTML={{ __html: CHECK_SVG }} />
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
          </div>
        ) : null}

        {selectedStages.length > 0 ? (
          <div className="wfo-sec lg-pipe">
            <div className="wfo-sec-h">工作流阶段<span className="c">已选 {enabledStageCount} / {selectedStages.length}</span></div>
            {hooksFor('__start').map((h) => hookRow(h, false))}
            {selectedStages.map((s, i) => {
              const st = stageState[s.key] ?? stageDefault(s.key)
              const per = isPerProjectStage(s, st)
              // 代码CR defaults to 多镜头 (lensCount 视角并行 at the workspace root), NOT a single agent — so
              // its "off" state must read 多镜头, not the misleading 单代理. Every other toggle-eligible stage
              // (写单测…) is a genuine single root agent when off.
              const lensN = s.lensCount ?? 0
              const offLabel = lensN > 0 ? '多镜头' : '单代理'
              const modeLabel = !st.enabled ? '已停用' : per ? `按项目 · ${selectedCount}` : lensN > 0 ? `多镜头 · ${lensN}` : '单代理'
              return (
                <Fragment key={s.key}>
                <div className={`lg-stg${st.enabled ? ' on' : ''}${per ? ' per' : ''}`} data-stage={s.key}>
                  <div className="lg-stg-head">
                    <button type="button" className="lg-stg-idx" onClick={() => toggleStage(s.key)} title="点击启用/停用该阶段">{i + 1}</button>
                    <span className="lg-stg-name" onClick={() => toggleStage(s.key)}>{s.name}</span>
                    {s.gate ? <span className="lg-stg-gate">门</span> : null}
                    <span className="lg-stg-right">
                      {st.enabled && stageAllowsPerProject(s) ? (
                        <span className="lg-scope-tog" onClick={(e) => e.stopPropagation()}>
                          <button type="button" className={!st.perProject ? 'on' : ''} onClick={() => setStagePerProject(s.key, false)}>{offLabel}</button>
                          <button type="button" className={st.perProject ? 'on' : ''} onClick={() => setStagePerProject(s.key, true)}>按项目</button>
                        </span>
                      ) : null}
                      <span className="lg-stg-mode">{modeLabel}</span>
                    </span>
                  </div>
                  {st.enabled ? (
                    <div className="lg-stg-lanes">
                      {per ? (
                        projects.length === 0 ? (
                          <div className="lg-lane-empty">本工作区没有代码项目</div>
                        ) : (
                          projects.map((p) => (
                            <div key={p.name} className={`lg-lane${p.selected ? '' : ' off'}`} data-proj={p.name}>
                              <span className="lg-lane-ck" onClick={() => toggleProject(p.name)}>
                                <span className="wfo-ck" dangerouslySetInnerHTML={{ __html: CHECK_SVG }} />
                              </span>
                              <span className="lg-lane-ic" dangerouslySetInnerHTML={{ __html: TERM_SVG }} />
                              <span className="lg-lane-nm"><b>{p.name}</b><span>{laneAgent(s.key, p).provider || 'claude'}</span></span>
                              {p.selected ? (s.code
                                // 写码阶段(代码开发):项目的编码代理就是它用的 agent,这里直接编辑项目本身。
                                ? renderChips(`proj:${s.key}:${p.name}`, p.provider, p.model, (id) => chooseProjectProvider(p.name, id), (id) => chooseProjectModel(p.name, id))
                                // 其余按项目阶段(按项目 CR / 写单测):改的是这个阶段自己的覆盖,不动项目。
                                : renderChips(`proj:${s.key}:${p.name}`, laneAgent(s.key, p).provider, laneAgent(s.key, p).model,
                                    (id) => chooseStageProjectProvider(s.key, p.name, id), (id) => chooseStageProjectModel(s.key, p, id))
                              ) : null}
                            </div>
                          ))
                        )
                      ) : (
                        <div className="lg-lane" data-lane="root">
                          <span className="lg-lane-ic" dangerouslySetInnerHTML={{ __html: TERM_SVG }} />
                          <span className="lg-lane-nm"><b>工作区</b><span>{lensN > 0 ? `${s.name} · 多镜头 ${lensN} 视角` : s.name}</span></span>
                          {renderChips(stageKeyOf(s.key), st.provider, st.model, (id) => chooseStageProvider(s.key, id), (id) => chooseStageModel(s.key, id))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
                {hooksFor(s.key).map((h) => hookRow(h, false))}
                </Fragment>
              )
            })}
            {hooksFor('__wf').map((h) => hookRow(h, false))}
            {orphanHooks.map((h) => hookRow(h, true))}
          </div>
        ) : null}

        {/* Task 8: 运行基准 — spec 的 mockup 画的是每个项目行下面挂一句副文本，但这里的项目行是按阶段
            重复渲染的 lane（同一个项目在「代码开发」「写单测」……每个按项目阶段各出现一次），逐 lane 挂
            副文本会把同一句话重复 N 遍。改成一个独立区块，集中列出每个「已选中」项目一次，信息等价、
            不重复。branch 为空串 = detached HEAD（currentBranch 的哨兵），标红且不可启动。
            Task 8 fix round 1 (cheap fix)：`base`（数组）在拿到 `[]` 时也是 truthy——零项目的工作区,
            或用户把 baseInfo 覆盖到的项目全部取消勾选,原来会露出一个光秃秃的「运行基准」标题、下面一行
            都没有。改成先算出真正会渲染的行,标题跟着这份行数据一起有无判断,不再单独看 `base` 是否非 null。
            `b.error` 是另一种失败(目录不存在/不是仓库/git 缺失……)，跟 detached HEAD 分开显示——两者
            都渲染成 `.bad`(标红)但文案不同，别把"读不出来"说成"detached HEAD"(见 run2Handlers.ts 的
            ProjectBaseInfo.error 注释)。
            Task 8 fix round 2 (cheap fix)：`baseFetchFailed` 是 IPC 调用本身失败(不是某个项目自己的
            `error`)——之前这种情况落进 `setBase([])`，跟"零项目/全部取消勾选"混成同一种"没有行可显示"，
            于是这里整块消失、用户毫无提示，直到点确认才在别处炸。现在单独判断、单独给一行红字提示,并且
            (见上面 confirmBlocked)一并挡住启动。 */}
        {baseFetchFailed ? (
          <>
            <div className="wfo-sec-h" style={{ marginTop: 12 }}>运行基准</div>
            <div className="lg-base">
              <div className="lg-base-row bad">
                <b>—</b>
                <span>读不出运行基准（IPC 调用失败），无法确认各项目的起始分支，请重试</span>
              </div>
            </div>
          </>
        ) : (() => {
          if (!base) return null
          const baseRows = base.filter((b) => projects.some((p) => p.name === b.name && p.selected))
          if (baseRows.length === 0) return null
          return (
            <>
              <div className="wfo-sec-h" style={{ marginTop: 12 }}>运行基准</div>
              <div className="lg-base">
                {baseRows.map((b) => (
                  <div key={b.name} className={`lg-base-row${b.branch && !b.error ? '' : ' bad'}`}>
                    <b>{b.name}</b>
                    {b.error
                      ? <span>读不出当前分支（{b.error}）</span>
                      : b.branch
                      // Task 8 fix round 3 (I1):未提交改动那句必须说清它们的去向。合并基线(bb41798)那版
                      // 写的是「会自动 git stash 保存…结束后恢复」,Task 8 把它换成了一个光秃秃的计数,
                      // 而 Task 2 同时把语义改成了「提交成一次运行前快照」—— 走合并那条收尾路径时,这 N 项
                      // 改动会跟着并进 b.branch 成为永久历史,那是唯一没有撤销键的一条路。整个渲染层此前
                      // 没有一处字符串提到过「快照」或这些改动会怎样。
                      ? <span>基准 {b.branch} · {b.dirtyCount > 0 ? `含 ${b.dirtyCount} 项未提交改动（会提交成「运行前快照」带进运行分支；选择合并收尾时一并并入 ${b.branch}）` : '工作树干净'}</span>
                      : <span>未在任何分支上，无法启动（请先 git switch 到一个分支）</span>}
                  </div>
                ))}
              </div>
            </>
          )
        })()}

        <div className="wfo-sec-h" style={{ marginTop: 14 }}>原始需求{seedLoading ? '' : '（AI 总结，可编辑）'}</div>
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

        <div className="wfo-sec-h" style={{ marginTop: 12 }}>补充说明（可选）</div>
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
          <button className="req-no" onClick={onCancel}>取消</button>
          <button className="req-ok" onClick={doConfirm} disabled={confirmBlocked} title={confirmBlockReason}>确认</button>
        </div>
      </div>
    </div>
  )
}
