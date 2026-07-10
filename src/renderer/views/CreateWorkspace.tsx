import { useEffect, useMemo, useRef, useState } from 'react'
import type { CreateWorkspaceOpts, ProviderInfo, ReviewConfig, ReviewLens } from '@shared/types'
import type { Plugin, LibraryHook } from '@shared/plugin'
import type { CfgProject, CfgWorkflow } from '../state/useConfig'
import { deriveWsName, buildCreateOpts, packModel, unpackModel, buildEditState, type WizardState, type WizardStage, type WizardProject } from './wizardModel'
import { PluginEditor } from '../components/PluginEditor'
import { movePluginBefore } from '../../shared/pluginReorder'
import { StagePromptEditor } from '../components/StagePromptEditor'

// Mirror of src/main/config/schema.ts STAGE_PROMPTS (renderer cannot import main's zod module)
const STAGE_DEFAULT_PROMPT: Record<string, string> = {
  requirement: '拆解本次需求,明确目标、范围边界与验收标准;识别关键风险与待澄清的问题,并把结论整理成要点交给后续阶段。',
  design: '基于需求产出技术方案:模块划分、接口/数据结构设计、关键技术决策与替代方案,并评估技术风险与影响面。',
  develop: '按技术方案实现代码变更,遵循项目既有规范与目录约定;保持改动聚焦、可回滚,并在必要处补充说明性注释。',
  test: '为本次改动补充单元 / 回归测试,覆盖核心路径与边界条件;确保测试可独立运行且能稳定复现回归。',
  review: '审查改动 diff:正确性、安全性、规范与可维护性;区分「必须修复」与「建议项」,并明确是否可以合并。',
}

// Canonical stage order + labels/descriptions (1:1 with the prototype STAGE_LIB, adapted to this repo's stage keys).
const STAGE_KEYS = ['requirement', 'design', 'develop', 'test', 'review'] as const
type StageKey = (typeof STAGE_KEYS)[number]
const DEV_KEY: StageKey = 'develop'
const REVIEW_KEY: StageKey = 'review'
const STAGE_DEF: Record<StageKey, { name: string; desc: string }> = {
  requirement: { name: '需求评估', desc: '拆解需求 · 明确范围与验收标准' },
  design: { name: '技术方案设计', desc: '架构 / 接口设计 · 风险评估' },
  develop: { name: '代码开发', desc: '实现变更' },
  test: { name: '写单测', desc: '补充单元 / 回归测试' },
  review: { name: '代码 CR', desc: '审查 diff · 把关合并' }
}

const CK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
)
const CK_CARD = (
  <svg className="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
)
const BRANCH = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
)
const GIT = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="18" r="2.4" /><path d="M12 8.4v2.1a3.5 3.5 0 0 1-3.5 3.5H8M12 10.5a3.5 3.5 0 0 0 3.5 3.5H16" /></svg>
)
const LOCK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
)
const DEFAULT_REVIEW: ReviewConfig = { mode: 'parallel', scope: 'per-project' }
const LENS_LABELS: Record<ReviewLens, string> = {
  correctness: '正确性',
  security: '安全',
  performance: '性能',
  style: '风格',
}
const DEFAULT_LENSES: ReviewLens[] = ['correctness', 'security']

// --- Plugin (hook) editing: two scopes inside the wizard ---
// wf scope: after = stage key or '__start' (flow strip in section 3).
// step scope: after = '__basic' | '__proj' | '__wf' (hook bars at setup-step boundaries).
const PLUGIN_PRESETS = [
  { name: '当前时间',     glyph: 'clock',  prompt: '输出当前系统日期与时间(ISO 8601),作为后续阶段的时间上下文。' },
  { name: '读取我的记忆', glyph: 'memory', prompt: '读取项目记忆与我的历史偏好,整理成要点后注入后续阶段的上下文。' },
  { name: '拉取最新主干', glyph: 'git',    prompt: '在开始前执行 git fetch,并基于最新 origin/main 创建工作分支。' },
  { name: '运行 Lint',    glyph: 'check',  prompt: '对改动文件运行项目 lint / 格式化,把问题列表交给下一阶段。' },
  { name: '空白插件',     glyph: 'puzzle', prompt: '' },
]
// Step boundary labels (prototype STEP_LABEL + sh-tag boundary captions).
const STEP_LABEL: Record<string, string> = { __basic: '基本信息 之后', __proj: '涉及项目 之后', __wf: '工作流 之后' }
const STEP_BARS: { after: string; caption: string }[] = [
  { after: '__basic', caption: '基本信息 → 涉及项目' },
  { after: '__proj', caption: '涉及项目 → 工作流' },
  { after: '__wf', caption: '工作流完成后' },
]
// wf-scope afterLabel: stage key → '<name> 之后', '__start' → '流程开始前'.
const wfAfterLabel = (after: string): string => after === '__start' ? '流程开始前' : ((STAGE_DEF as Record<string, { name: string }>)[after]?.name ?? after) + ' 之后'

const INS_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
)
const PUZZLE_PZ = (
  <svg className="pz" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.6 2.6 0 0 1 0 5.2H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.6 2.6 0 0 1 5.2 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z" /></svg>
)
const XSM_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
)

// Single open-editor state shared by both scopes.
interface PlugEdit { scope: 'wf' | 'step'; after: string; editId: string | null }

interface Props {
  open: boolean
  onCancel: () => void
  onCreate: (opts: CreateWorkspaceOpts) => void
  projects: CfgProject[]
  workflows: CfgWorkflow[]
  providers: ProviderInfo[]
  onOpenProjectSettings: () => void
  onNewWorkflow: () => void
  onAddProject?: (repoUrl: string, branch: string) => Promise<CfgProject[]>
  onAddWorkflow?: (name: string, stageKeys: string[]) => Promise<CfgWorkflow[]>
  onPickPath?: () => Promise<string | null>
  // Global reusable hook library: picked-from at each insert point; onSaveHookToLibrary persists a new
  // inline-created hook back to the library when the「保存到 Hook 库」box is checked.
  hookLibrary?: LibraryHook[]
  onSaveHookToLibrary?: (hook: LibraryHook) => void
  // Restore an unfinished creation: probe a chosen folder for a leftover .forge/workspace.json, and
  // discard (清除重来) the partial on-disk state. Both keyed by the chosen path.
  onProbeWorkspace?: (path: string) => Promise<import('@shared/types').Workspace | null>
  onDiscardPartial?: (path: string) => Promise<void>
  error?: string | null
  creating?: boolean   // workspace creation is in flight (git worktree/fetch) — block re-submit
  editing?: import('@shared/types').Workspace | null
}

export function CreateWorkspace({ open, onCancel, onCreate, projects, workflows, providers, onOpenProjectSettings, onNewWorkflow, onAddProject, onAddWorkflow, onPickPath, hookLibrary = [], onSaveHookToLibrary, onProbeWorkspace, onDiscardPartial, error, creating = false, editing }: Props) {
  // installed providers drive the model menus; fall back to all providers if none report installed.
  const pickProviders = useMemo(() => {
    const inst = providers.filter(p => p.installed)
    return inst.length ? inst : providers
  }, [providers])

  const modelOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = []
    for (const p of pickProviders) for (const m of p.models) opts.push({ value: packModel(p.id, m.id), label: p.displayName + ' · ' + m.label })
    return opts
  }, [pickProviders])

  // Resolve a stage's default provider/model: prefer the stage's configured agent (if installed),
  // else the first installed provider; the default model if that provider offers it, else its first.
  const seedStage = (defaultModel: string, preferredProvider?: string): { provider: string; model: string } => {
    const prov = (preferredProvider && pickProviders.find(p => p.id === preferredProvider)) || pickProviders[0]
    if (!prov) return { provider: '', model: defaultModel }
    const has = prov.models.some(m => m.id === defaultModel)
    return { provider: prov.id, model: has ? defaultModel : (prov.models[0]?.id ?? defaultModel) }
  }

  const buildStages = (wf: CfgWorkflow | undefined): Record<string, WizardStage> => {
    const onKeys = new Set((wf?.stages ?? []).map(s => s.key))
    const dmByKey: Record<string, string> = {}
    const daByKey: Record<string, string> = {}
    for (const s of wf?.stages ?? []) { dmByKey[s.key] = s.defaultModel; daByKey[s.key] = s.defaultAgent }
    const out: Record<string, WizardStage> = {}
    for (const k of STAGE_KEYS) {
      const seeded = seedStage(dmByKey[k] ?? pickProviders[0]?.models[0]?.id ?? '', daByKey[k])
      const seedPrompt = wf?.stagePrompts?.[k]
      out[k] = { on: onKeys.has(k), provider: seeded.provider, model: seeded.model, ...(seedPrompt ? { prompt: seedPrompt } : {}) }
    }
    // Custom (non-builtin) stages from the workflow template: seed them ON with their template config
    // + behavior flags so they run. They inherit the template's provider/model/prompt/flags.
    for (const s of wf?.stages ?? []) {
      if (STAGE_KEYS.includes(s.key as StageKey)) continue
      const seeded = seedStage(s.defaultModel || (pickProviders[0]?.models[0]?.id ?? ''), s.defaultAgent)
      out[s.key] = {
        on: true, custom: true,
        provider: s.defaultAgent || seeded.provider, model: s.defaultModel || seeded.model,
        ...(s.name ? { name: s.name } : {}),
        ...(s.prompt ? { prompt: s.prompt } : {}),
        ...(s.review ? { review: s.review } : {}),
        ...(s.scope ? { scope: s.scope } : {}),
        ...(s.gate !== undefined ? { gate: s.gate } : {}),
        ...(s.summary !== undefined ? { summary: s.summary } : {}),
        ...(s.projectAgent !== undefined ? { projectAgent: s.projectAgent } : {}),
        ...(s.producesDoc !== undefined ? { producesDoc: s.producesDoc } : {}),
      }
    }
    return out
  }
  // Stage order: the selected workflow's stage order (custom stages keep position), plus any stages
  // already in the wizard state (so a '__custom'/edited flow keeps its custom stages), then built-ins.
  const stageOrderFrom = (wfId: string, stages: Record<string, WizardStage>): string[] =>
    [...new Set([...(workflows.find(w => w.id === wfId)?.stages ?? []).map(s => s.key), ...Object.keys(stages), ...STAGE_KEYS])]

  const seedProjects = (): WizardProject[] => projects.map(p => {
    const dev = seedStage(workflows[0]?.stages.find(s => s.key === DEV_KEY)?.defaultModel ?? '')
    return { repoId: p.id, name: p.name, sel: false, branch: '', model: packModel(dev.provider, dev.model) }
  })

  const freshState = (): WizardState => ({
    path: '', name: '', nameEdited: false,
    workflowId: workflows[0]?.id ?? '__custom',
    stages: buildStages(workflows[0]),
    projects: seedProjects(),
    // Seed the workflow's own plugin hooks (configured in Settings) so they show in the flow strip
    // and get persisted to the workspace — otherwise selecting a workflow silently drops its hooks.
    plugins: (workflows[0]?.plugins ?? []).map(p => ({ ...p })),
    stepPlugins: []
  })

  const [state, setState] = useState<WizardState>(freshState)
  const [branchAll, setBranchAll] = useState('')
  const [plugEdit, setPlugEdit] = useState<PlugEdit | null>(null)
  // Insert flow: clicking "+" opens a picker (choose-from-library / create-new) rather than the editor.
  const [plugPick, setPlugPick] = useState<{ scope: 'wf' | 'step'; after: string } | null>(null)
  const [draggedPlugId, setDraggedPlugId] = useState<string | null>(null)
  const [stageEdit, setStageEdit] = useState<string | null>(null)   // currently editing stage append key
  const [removalConfirm, setRemovalConfirm] = useState(false)       // gate a destructive project removal on save
  const [runHooksOnAdd, setRunHooksOnAdd] = useState(true)          // re-run __proj hooks against newly added projects
  // custom model input state: key = stage key or 'proj::repoId', value = typed text
  const [customModelInputs, setCustomModelInputs] = useState<Record<string, string>>({})
  // which selects are in custom-model mode: set of keys
  const [customModelKeys, setCustomModelKeys] = useState<Set<string>>(new Set())
  // new-project inline add (P1) inputs + names pending auto-select once the config list updates.
  const [newRepo, setNewRepo] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const pendingSelect = useRef<Set<string>>(new Set())
  // inline new-workflow designer (P2b): open flag + draft name/stage set.
  const [wfDraft, setWfDraft] = useState<{ name: string; keys: Set<string> } | null>(null)
  // Restore-an-unfinished-creation state (used far below, but declared here — before the `if (!open)`
  // early return — so hook order stays stable across open/closed renders).
  const [partial, setPartial] = useState<import('@shared/types').Workspace | null>(null)
  const [discarding, setDiscarding] = useState(false)

  // Full (re)seed ONLY when the modal opens or the edit target changes — NOT on every projects/
  // workflows change, so adding a project/workflow from inside the wizard can't wipe the user's
  // path/name/stage edits. Live config changes are merged non-destructively below.
  useEffect(() => {
    if (!open) return
    if (editing) {
      const devDefault = workflows[0]?.stages.find(s => s.key === DEV_KEY)?.defaultModel ?? ''
      const seed = seedStage(devDefault)
      setState(buildEditState(editing, projects, buildStages(undefined), packModel(seed.provider, seed.model)))
    } else {
      setState(freshState())
    }
    setBranchAll('')
    setPlugEdit(null)
    setStageEdit(null)
    setWfDraft(null)
    setNewRepo('')
    setNewBranch('')
    setCustomModelKeys(new Set())
    setCustomModelInputs({})
    // Clear any restore banner from a PRIOR open — freshState() blanks the path, so a stale `partial`
    // (probed last time) would otherwise show "检测到未完成的创建" on a wizard the user hasn't touched.
    // The banner reappears only after a real probe (pick / blur) resolves a partial.
    setPartial(null)
    setDiscarding(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing])

  // Merge the live project list into state.projects while open, preserving each row's sel/branch/model
  // and auto-selecting any project just added inline (matched by derived name via pendingSelect).
  useEffect(() => {
    if (!open || editing) return
    setState(s => {
      const prevById = new Map(s.projects.map(p => [p.repoId, p]))
      const next: WizardProject[] = projects.map(p => {
        const prev = prevById.get(p.id)
        if (prev) return { ...prev, name: p.name }
        const dev = seedStage(workflows[0]?.stages.find(st => st.key === DEV_KEY)?.defaultModel ?? '')
        return { repoId: p.id, name: p.name, sel: pendingSelect.current.has(p.name), branch: '', model: packModel(dev.provider, dev.model) }
      })
      return { ...s, projects: next }
    })
    pendingSelect.current.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, open, editing])

  // Re-checking a project clears a pending removal confirmation. MUST sit before the `if (!open)`
  // early return so the hook order never changes between open/closed renders.
  useEffect(() => {
    const hasRemoval = !!editing && state.projects.some(p => p.existing && !p.sel)
    if (removalConfirm && !hasRemoval) setRemovalConfirm(false)
  }, [removalConfirm, editing, state.projects])

  if (!open) return null

  const wsName = deriveWsName(state.path, state.nameEdited, state.name)
  const branchFor = (p: WizardProject) => p.branch || (wsName ? 'forge/' + wsName : '')

  const enabledCount = STAGE_KEYS.filter(k => state.stages[k]?.on).length
  const selectedCount = state.projects.filter(p => p.sel).length
  const chosen = state.projects.filter(p => p.sel)
  const canCreate = enabledCount > 0

  const update = (fn: (s: WizardState) => WizardState) => setState(fn)

  // --- interactions ---
  const setPath = (v: string) => update(s => ({ ...s, path: v }))
  const setName = (v: string) => update(s => ({ ...s, name: v, nameEdited: v.length > 0 }))

  // --- restore an unfinished creation ---
  // A folder that holds a leftover .forge/workspace.json is a previously-interrupted/failed creation.
  // Probing it (on pick / blur) restores that config into the wizard so the user can 继续创建, or 清除
  // 重来 to wipe the partial on-disk state and start fresh. (State declared with the other hooks above
  // the `if (!open) return null` guard — these functions just close over it.)
  const defaultProjModel = () => {
    const wf = workflows.find(w => w.id === state.workflowId) ?? workflows[0]
    const dev = seedStage(wf?.stages.find(s => s.key === DEV_KEY)?.defaultModel ?? '')
    return packModel(dev.provider, dev.model)
  }
  const probePartial = async (rawPath: string) => {
    if (editing || !onProbeWorkspace) return
    const p = rawPath.trim()
    if (!p) { setPartial(null); return }
    let ws: import('@shared/types').Workspace | null = null
    try { ws = await onProbeWorkspace(p) } catch { ws = null }
    if (ws && Array.isArray(ws.projects)) {
      setPartial(ws)
      // Restore config; unlock the projects so the user can still tweak before 继续创建.
      const restored = buildEditState(ws, projects, buildStages(workflows.find(w => w.id === state.workflowId) ?? workflows[0]), defaultProjModel())
      setState({ ...restored, path: ws.path, projects: restored.projects.map(pr => ({ ...pr, locked: false })) })
    } else {
      setPartial(null)
    }
  }
  const discardPartial = async () => {
    if (!partial || !onDiscardPartial || discarding) return
    setDiscarding(true)
    try { await onDiscardPartial(partial.path) } finally { setDiscarding(false) }
    setPartial(null)
    setState(freshState())   // 清除选择 — back to a blank wizard
  }

  // Derive the display name from a repo url/path the same way the store does (last path segment).
  const deriveRepoName = (url: string): string => {
    const s = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '')
    return (s.split(/[/:]/).pop() || '').trim()
  }
  // P1: add a project inline. Persist via onAddProject; the merge effect re-syncs state.projects and
  // auto-selects it (pendingSelect matched by derived name). Direct-select as a fallback if the prop
  // list already reflects it synchronously.
  const doAddProject = async () => {
    const repoUrl = newRepo.trim()
    const nm = deriveRepoName(repoUrl)
    if (!nm || !onAddProject) return
    pendingSelect.current.add(nm)   // covers the merge-effect path if the prop updates first
    setNewRepo(''); setNewBranch('')
    const list = await onAddProject(repoUrl, newBranch.trim() || 'main')
    const added = list?.find(p => p.name === nm)
    if (!added) return
    const dev = seedStage(workflows[0]?.stages.find(st => st.key === DEV_KEY)?.defaultModel ?? '')
    setState(s => s.projects.some(p => p.repoId === added.id)
      ? { ...s, projects: s.projects.map(p => p.repoId === added.id ? { ...p, sel: true } : p) }
      : { ...s, projects: [...s.projects, { repoId: added.id, name: added.name, sel: true, branch: '', model: packModel(dev.provider, dev.model) }] })
  }

  // P2b: create a workflow inline. Persist via onAddWorkflow, then select it immediately using the
  // returned definition (build stages from it directly — the `workflows` prop may lag one render).
  const doCreateWorkflow = async () => {
    if (!wfDraft || !onAddWorkflow) return
    const name = wfDraft.name.trim() || '自定义流程'
    const keys = STAGE_KEYS.filter(k => wfDraft.keys.has(k))   // canonical order
    if (!keys.length) return
    const before = new Set(workflows.map(w => w.id))
    const list = await onAddWorkflow(name, keys)
    const added = list?.find(w => !before.has(w.id)) ?? list?.find(w => w.name === name)
    setWfDraft(null)
    if (added) update(s => ({ ...s, workflowId: added.id, stages: buildStages(added), plugins: (added.plugins ?? []).map(p => ({ ...p })) }))
  }

  const selectWorkflow = (id: string) => {
    setWfDraft(null)   // picking a template dismisses the inline new-workflow designer
    update(s => ({
    ...s, workflowId: id,
    // '__custom' keeps the current enabled set (edit from here via add/remove) instead of force-
    // enabling all 5 — so switching between templates produces a visible change in the stage list.
    stages: id === '__custom' ? s.stages : buildStages(workflows.find(w => w.id === id)),
    // Re-seed wf-scope hooks from the chosen workflow (mirrors the stage rebuild). __custom has none.
    plugins: id === '__custom' ? [] : (workflows.find(w => w.id === id)?.plugins ?? []).map(p => ({ ...p }))
    }))
  }

  const toggleStage = (k: string) => update(s => ({ ...s, workflowId: '__custom', stages: { ...s.stages, [k]: { ...s.stages[k], on: !s.stages[k].on } } }))
  const setStageModel = (k: string, v: string) => {
    if (v === '__custom__') {
      setCustomModelKeys(prev => new Set([...prev, k]))
      setCustomModelInputs(prev => ({ ...prev, [k]: '' }))
      return
    }
    const { provider, model } = unpackModel(v)
    update(s => ({ ...s, stages: { ...s.stages, [k]: { ...s.stages[k], provider, model } } }))
  }
  const confirmStageCustomModel = (k: string) => {
    const v = (customModelInputs[k] ?? '').trim()
    if (v) {
      const cur = state.stages[k]
      const provider = cur?.provider || (pickProviders[0]?.id ?? '')
      update(s => ({ ...s, stages: { ...s.stages, [k]: { ...s.stages[k], model: v, provider } } }))
    }
    setCustomModelKeys(prev => { const n = new Set(prev); n.delete(k); return n })
  }
  const setStageAppend = (k: string, v: string) => update(s => ({ ...s, workflowId: '__custom', stages: { ...s.stages, [k]: { ...s.stages[k], prompt: v ? v : undefined } } }))
  const setReviewConfig = (review: ReviewConfig) => update(s => ({ ...s, workflowId: '__custom', stages: { ...s.stages, [REVIEW_KEY]: { ...s.stages[REVIEW_KEY], review } } }))
  const setReviewMode = (mode: 'single' | 'per-project' | 'lens') => {
    if (mode === 'single') setReviewConfig({ mode: 'single' })
    else if (mode === 'lens') setReviewConfig({ mode: 'parallel', scope: 'workspace', reviewers: DEFAULT_LENSES })
    else setReviewConfig(DEFAULT_REVIEW)
  }
  const toggleReviewLens = (lens: ReviewLens) => update(s => {
    const cur = s.stages[REVIEW_KEY]?.review
    const reviewers = Array.isArray(cur?.reviewers) ? cur.reviewers : DEFAULT_LENSES
    const next = reviewers.includes(lens) ? reviewers.filter(x => x !== lens) : [...reviewers, lens]
    return {
      ...s,
      workflowId: '__custom',
      stages: {
        ...s.stages,
        [REVIEW_KEY]: {
          ...s.stages[REVIEW_KEY],
          review: { mode: 'parallel', scope: 'workspace', reviewers: next.length ? next : [lens] },
        },
      },
    }
  })

  const toggleProject = (repoId: string) => update(s => ({ ...s, projects: s.projects.map(p => p.repoId === repoId && !p.locked ? { ...p, sel: !p.sel } : p) }))
  const setProjectBranch = (repoId: string, v: string) => update(s => ({ ...s, projects: s.projects.map(p => p.repoId === repoId ? { ...p, branch: v } : p) }))
  const setProjectModel = (repoId: string, v: string) => {
    const pk = 'proj::' + repoId
    if (v === '__custom__') {
      setCustomModelKeys(prev => new Set([...prev, pk]))
      setCustomModelInputs(prev => ({ ...prev, [pk]: '' }))
      return
    }
    update(s => ({ ...s, projects: s.projects.map(p => p.repoId === repoId ? { ...p, model: v } : p) }))
  }
  const confirmProjCustomModel = (repoId: string) => {
    const pk = 'proj::' + repoId
    const v = (customModelInputs[pk] ?? '').trim()
    if (v) {
      const proj = state.projects.find(p => p.repoId === repoId)
      const { provider } = unpackModel(proj?.model ?? '')
      const providerResolved = provider || (pickProviders[0]?.id ?? '')
      update(s => ({ ...s, projects: s.projects.map(p => p.repoId === repoId ? { ...p, model: packModel(providerResolved, v) } : p) }))
    }
    setCustomModelKeys(prev => { const n = new Set(prev); n.delete(pk); return n })
  }
  const applyBranchAll = () => { const v = branchAll.trim(); if (!v) return; update(s => ({ ...s, projects: s.projects.map(p => p.sel ? { ...p, branch: v } : p) })) }

  // --- plugin (hook) editing — both scopes share one open-editor state ---
  const plugKey = (scope: 'wf' | 'step'): 'plugins' | 'stepPlugins' => (scope === 'step' ? 'stepPlugins' : 'plugins')
  const plugsOf = (scope: 'wf' | 'step', after: string): Plugin[] => state[plugKey(scope)].filter(p => p.after === after)
  // Insert "+" now opens the picker (from-library / new); the editor opens only on「新建」or when editing.
  const openInsert = (scope: 'wf' | 'step', after: string) => { setStageEdit(null); setPlugEdit(null); setPlugPick({ scope, after }) }
  const openEdit = (scope: 'wf' | 'step', id: string) => {
    const pl = state[plugKey(scope)].find(p => p.id === id)
    if (pl) { setStageEdit(null); setPlugPick(null); setPlugEdit({ scope, after: pl.after, editId: id }) }
  }
  // Picker → 新建: close the picker and open a blank editor at the same slot.
  const startNewHook = (scope: 'wf' | 'step', after: string) => { setPlugPick(null); setPlugEdit({ scope, after, editId: null }) }
  // Picker → pick a library hook: snapshot-copy it into this slot (fresh id + this slot's `after`).
  const pickLibraryHook = (scope: 'wf' | 'step', after: string, lib: LibraryHook) => {
    const key = plugKey(scope)
    update(s => ({ ...s, [key]: [...s[key], { id: `pl-${crypto.randomUUID()}`, name: lib.name, prompt: lib.prompt, after, skills: [...lib.skills], tools: [...lib.tools] }] }))
    setPlugPick(null)
  }
  const plugLabel = (scope: 'wf' | 'step', after: string) => scope === 'step' ? (STEP_LABEL[after] ?? after) : wfAfterLabel(after)
  const deletePlug = (scope: 'wf' | 'step', id: string) => {
    const key = plugKey(scope)
    update(s => ({ ...s, [key]: s[key].filter(p => p.id !== id) }))
    setPlugEdit(e => (e?.editId === id ? null : e))
  }
  const savePlug = (result: { name: string; prompt: string; skills: string[]; tools: string[]; saveToLibrary?: boolean }) => {
    if (!plugEdit) return
    const key = plugKey(plugEdit.scope)
    update(s => {
      const arr = s[key]
      const next = plugEdit.editId
        ? arr.map(p => p.id === plugEdit.editId ? { ...p, name: result.name, prompt: result.prompt, skills: result.skills, tools: result.tools } : p)
        : [...arr, { id: `pl-${crypto.randomUUID()}`, name: result.name, prompt: result.prompt, after: plugEdit.after, skills: result.skills, tools: result.tools }]
      return { ...s, [key]: next }
    })
    // Opt-in: also persist this new hook to the reusable library (slot-agnostic → drop `after`).
    if (!plugEdit.editId && result.saveToLibrary && onSaveHookToLibrary) {
      onSaveHookToLibrary({ id: `hk-${crypto.randomUUID()}`, name: result.name, prompt: result.prompt, skills: result.skills, tools: result.tools })
    }
    setPlugEdit(null)
  }

  // wf-scope flow strip: insert button + chips for one `after` position.
  const plugChips = (scope: 'wf' | 'step', after: string) => plugsOf(scope, after).map(p => (
    <span
      key={p.id}
      className="wf-plug-chip click"
      data-ovedit={p.id}
      data-ovscope={scope}
      title="编辑 hook prompt"
      draggable
      onDragStart={() => setDraggedPlugId(p.id)}
      onDragEnd={() => setDraggedPlugId(null)}
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        e.preventDefault()
        if (draggedPlugId && draggedPlugId !== p.id) {
          const key = plugKey(scope)
          const current = state[key]
          const next = movePluginBefore(current, draggedPlugId, p.id)
          if (next !== current) update(s => ({ ...s, [key]: next }))
        }
        setDraggedPlugId(null)
      }}
      onClick={() => openEdit(scope, p.id)}
    >
      {PUZZLE_PZ}{p.name}
      <button className="x" data-ovdel={p.id} data-ovscope={scope} title="移除 hook" onClick={e => { e.stopPropagation(); deletePlug(scope, p.id) }}>{XSM_SVG}</button>
    </span>
  ))
  const insBtn = (scope: 'wf' | 'step', after: string) => (
    <button className="wf-ins" data-ovadd={after} data-ovscope={scope} aria-label={`在「${plugLabel(scope, after)}」插入 hook`} title={`在「${plugLabel(scope, after)}」插入 hook`} onClick={() => openInsert(scope, after)}>{INS_SVG}</button>
  )
  const editorFor = (scope: 'wf' | 'step', after: string) => (plugEdit && plugEdit.scope === scope && plugEdit.after === after) ? (
    <PluginEditor
      afterLabel={plugLabel(scope, after)}
      presets={plugEdit.editId ? undefined : PLUGIN_PRESETS}
      showSaveToLibrary={Boolean(onSaveHookToLibrary)}
      initial={plugEdit.editId ? state[plugKey(scope)].find(p => p.id === plugEdit.editId) : undefined}
      onSave={savePlug}
      onCancel={() => setPlugEdit(null)}
    />
  ) : null

  // Insert picker: choose an existing library hook (snapshot-copied) or start a new one.
  const pickerFor = (scope: 'wf' | 'step', after: string) => (plugPick && plugPick.scope === scope && plugPick.after === after) ? (
    <div className="hk-picker" data-hkpick={after}>
      <div className="hkp-h">{PUZZLE_PZ}在「{plugLabel(scope, after)}」插入 hook</div>
      {hookLibrary.length > 0 ? (
        <div className="hkp-lib">
          <span className="hkp-lbl">从 Hook 库选择</span>
          <div className="hkp-chips">
            {hookLibrary.map(lib => (
              <button key={lib.id} type="button" className="hkp-chip" title={lib.prompt || lib.name} onClick={() => pickLibraryHook(scope, after, lib)}>
                {PUZZLE_PZ}{lib.name}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="hkp-empty">Hook 库还是空的 —— 你可以新建一个,并在新建时勾选「保存到 Hook 库」以便复用。</div>
      )}
      <div className="hkp-foot">
        <button type="button" className="cancel" onClick={() => setPlugPick(null)}>取消</button>
        <button type="button" className="hkp-new" onClick={() => startNewHook(scope, after)}>{INS_SVG}新建 Hook</button>
      </div>
    </div>
  ) : null

  // step-scope hook bar for one boundary.
  const renderStepHook = (after: string, caption: string) => {
    const chips = plugsOf('step', after)
    return (
      <div className="cr-step-hook" id={'crHook_' + after.slice(2)} data-boundary={after} key={after}>
        <div className="sh-bar">
          <span className="hr" />
          <span className="sh-tag">{PUZZLE_PZ}{caption}</span>
          {plugChips('step', after)}
          <button className="sh-add" data-ovadd={after} data-ovscope="step" title={`在「${STEP_LABEL[after] ?? after}」插入插件 / hook`} onClick={() => openInsert('step', after)}>
            {INS_SVG}{chips.length ? '再加一个' : '插入插件 / hook'}
          </button>
          <span className="hr" />
        </div>
        {pickerFor('step', after)}
        {editorFor('step', after)}
      </div>
    )
  }

  // Existing projects the user unchecked in edit mode → they'll be removed (worktree deleted) on save.
  const removedProjects = editing ? state.projects.filter(p => p.existing && !p.sel) : []
  // Newly-added projects in edit mode + a configured __proj hook → offer to (re)run it against them.
  const addedProjects = editing ? state.projects.filter(p => p.sel && !p.existing) : []
  const hasProjHook = (state.stepPlugins ?? []).some(p => p.after === '__proj')
  const showHookToggle = !!editing && addedProjects.length > 0 && hasProjHook

  const doCreate = () => {
    if (!canCreate || creating) return
    // Removing a project deletes its pulled code on disk — confirm once before proceeding.
    if (removedProjects.length && !removalConfirm) { setRemovalConfirm(true); return }
    // commit derived name + per-project branches/develop-model so the DTO reflects the live UI.
    const committed: WizardState = {
      ...state,
      name: wsName,
      nameEdited: true,
      // unpack develop per-project model (packed provider::model) into separate provider + model fields for the DTO.
      projects: state.projects.map(p => { const { provider, model } = unpackModel(p.model); return { ...p, branch: branchFor(p), provider, model } })
    }
    const order = stageOrderFrom(committed.workflowId, committed.stages)
    onCreate({ ...buildCreateOpts(committed, order), runProjHooks: showHookToggle && runHooksOnAdd })
  }

  return (
    <div className="create-overlay on" id="createOverlay" onClick={e => { if (e.target === e.currentTarget && !creating) onCancel() }}>
      <div className="create">
        <div className="cr-head">
          <span className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="3" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></svg></span>
          <div><h3>{editing ? '编辑工作区' : '新建工作区'}</h3><div className="sub">{editing ? '路径已锁定 · 可重命名、增加项目、调整工作流' : '配置路径、工作流与涉及的项目'}</div></div>
          <button className="cr-x" id="crClose" onClick={onCancel} disabled={creating}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>
        </div>

        <div className="cr-body">
          {/* Restore banner: this folder has an unfinished creation — config restored; continue or clear. */}
          {!editing && partial && (
            <div className="cr-restore">
              <svg className="ri" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
              <div className="cr-restore-txt">
                <b>检测到未完成的创建</b>
                <span>该文件夹此前建到一半（{partial.projects?.length ?? 0} 个项目、{partial.stages?.length ?? 0} 个阶段）。已为你恢复配置，可直接「创建」继续（只补拉未完成的项目），或清除后重来。</span>
              </div>
              <button className="cr-restore-clear" onClick={() => void discardPartial()} disabled={discarding}>{discarding ? '清除中…' : '清除重来'}</button>
            </div>
          )}

          {/* 1 基本信息 */}
          <div className="cr-sec">
            <div className="cr-sec-h"><span className="n">1</span><h4>基本信息</h4></div>
            <div className="cr-row">
              <div className="cr-field">
                <label>工作区路径</label>
                <div className="inp">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                  <input className="mono" id="crPath" placeholder="~/code/" spellCheck={false} autoCapitalize="off" autoComplete="off" value={state.path} readOnly={!!editing} onChange={e => setPath(e.target.value)} onBlur={e => void probePartial(e.target.value)} />
                  {!editing && <button className="pick" id="crPick" onClick={async () => { const d = await onPickPath?.(); if (d) { setPath(d); void probePartial(d) } }}>选择…</button>}
                </div>
              </div>
            </div>
            <div className="cr-row" style={{ marginTop: 14 }}>
              <div className="cr-field">
                <label>工作区名称</label>
                <div className="inp">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></svg>
                  <input id="crName" placeholder={state.nameEdited ? '支持中文,例如:设计系统迁移' : (deriveWsName(state.path, false, '') || '支持中文,例如:设计系统迁移')} autoComplete="off" value={state.name} onChange={e => setName(e.target.value)} />
                </div>
                <div className="cr-name-tip" id="crNameTip">{editing ? '可在此重命名工作区(支持中文)。' : '留空将自动取自路径末段,创建后也可随时重命名。'}</div>
              </div>
            </div>
          </div>

          {/* step hook: 基本信息 → 涉及项目 */}
          {renderStepHook('__basic', STEP_BARS[0].caption)}

          {/* 2 涉及项目 */}
          <div className="cr-sec">
            <div className="cr-sec-h"><span className="n">2</span><h4>涉及项目</h4><span className="hint" id="crProjHint">{state.projects.length ? '已选 ' + selectedCount + ' / ' + state.projects.length : '先圈定本次需求动哪些项目 · 各设代码分支'}</span></div>
            <div className="cr-branch-all" id="crBranchAll">
              <span className="lab"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>统一分支</span>
              <input id="crBranchAllInput" placeholder="feat/my-task" spellCheck={false} autoCapitalize="off" autoComplete="off" value={branchAll} onChange={e => setBranchAll(e.target.value)} />
              <button className="apply" id="crBranchApply" onClick={applyBranchAll}>应用到选中项目</button>
            </div>
            <div className="cr-projs" id="crProjs">
              {state.projects.length === 0 ? (
                <div className="cr-proj-empty">尚未配置 Git 项目。在下方新增,或到 <a id="crGoProj" onClick={onOpenProjectSettings}>设置 · 项目设置</a> 添加。</div>
              ) : (
                state.projects.map((p, i) => (
                  <div className={'cr-proj' + (p.sel ? ' on' : ' off') + (p.existing && !p.sel ? ' removing' : '')} data-pi={i} key={p.repoId}>
                    <button className="st-chk" data-prtoggle={i} title={p.existing && p.sel ? '取消勾选将移除该项目(删除本地代码)' : undefined} onClick={() => toggleProject(p.repoId)}>{CK}</button>
                    <span className="pj-ic">{GIT}</span>
                    <div className="pj-main" onClick={() => toggleProject(p.repoId)}>
                      <div className="pj-name">{p.name}</div>
                      <div className="pj-repo">{projects.find(pp => pp.id === p.repoId)?.repoUrl ?? ''}</div>
                    </div>
                    {p.existing && (p.sel ? <span className="pj-lock">已包含</span> : <span className="pj-remove">将移除</span>)}
                    <span className="pj-branch">{BRANCH}<input data-prbranch={i} value={branchFor(p)} spellCheck={false} onChange={e => setProjectBranch(p.repoId, e.target.value)} /></span>
                  </div>
                ))
              )}
            </div>
            {onAddProject && (
              <div className="cr-newproj" id="crNewProj">
                <span className="pj-ic">{GIT}</span>
                <input data-crnewproj-repo placeholder="新增项目:git@github.com:acme/repo.git 或本地路径" spellCheck={false} autoCapitalize="off" autoComplete="off" value={newRepo} onChange={e => setNewRepo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void doAddProject() } }} />
                <span className="pj-branch">{BRANCH}<input data-crnewproj-branch placeholder="main" spellCheck={false} value={newBranch} onChange={e => setNewBranch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void doAddProject() } }} /></span>
                <button className="np-add" data-crnewproj-add disabled={!deriveRepoName(newRepo)} onClick={() => void doAddProject()}>{INS_SVG}添加</button>
              </div>
            )}
          </div>

          {/* step hook: 涉及项目 → 工作流 */}
          {renderStepHook('__proj', STEP_BARS[1].caption)}

          {/* 3 工作流程 */}
          <div className="cr-sec">
            <div className="cr-sec-h"><span className="n">3</span><h4>工作流程</h4><span className="hint">阶段可勾选增删 · 开发阶段按上方项目自动派代理</span></div>
            <div className="wf-templates" id="crWfTemplates">
              {workflows.map(w => (
                <button className={'wf-card' + (state.workflowId === w.id ? ' on' : '')} data-crtpl={w.id} key={w.id} onClick={() => selectWorkflow(w.id)}>
                  <div className="tt">{w.name}{CK_CARD}</div>
                  <div className="ds">{w.stages.length} 个阶段</div>
                </button>
              ))}
              <button className={'wf-card' + (state.workflowId === '__custom' ? ' on' : '')} data-crtpl="__custom" onClick={() => selectWorkflow('__custom')}>
                <div className="tt">自定义{CK_CARD}</div>
                <div className="ds">从全部阶段自由勾选</div>
              </button>
              <button className="wf-card add" data-crnewwf onClick={() => onAddWorkflow ? setWfDraft({ name: '', keys: new Set() }) : onNewWorkflow()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>新建流程</button>
            </div>
            {wfDraft && (
              <div className="wf-designer" id="crWfDesigner">
                <div className="wfd-h">{PUZZLE_PZ}新建工作流 · 勾选阶段</div>
                <input data-crwf-name className="wfd-name" placeholder="工作流名称,例如:快速修复流" value={wfDraft.name} onChange={e => setWfDraft(d => d ? { ...d, name: e.target.value } : d)} />
                <div className="wfd-stages">
                  {STAGE_KEYS.map(k => (
                    <button key={k} className={'stage-add-chip' + (wfDraft.keys.has(k) ? ' on' : '')} data-crwf-stage={k}
                      onClick={() => setWfDraft(d => { if (!d) return d; const keys = new Set(d.keys); if (keys.has(k)) keys.delete(k); else keys.add(k); return { ...d, keys } })}>
                      {wfDraft.keys.has(k) ? CK : INS_SVG}{STAGE_DEF[k].name}
                    </button>
                  ))}
                </div>
                <div className="wfd-foot">
                  <button className="btn-cancel" data-crwf-cancel onClick={() => setWfDraft(null)}>取消</button>
                  <button className="np-add" data-crwf-create disabled={wfDraft.keys.size === 0} onClick={() => void doCreateWorkflow()}>{CK}创建流程</button>
                </div>
              </div>
            )}
            <div className="stage-edit" id="crStageEdit">
              {/* wf-scope flow strip: insert plugin hooks between stages */}
              <div className="cr-flow-preview">
                <div className="fp-h">{PUZZLE_PZ}流程 · 插件 hook<span className="lk">点 + 在阶段间插入</span></div>
                <div className="wf-flow">
                  {insBtn('wf', '__start')}
                  {plugChips('wf', '__start')}
                  {stageOrderFrom(state.workflowId, state.stages).filter(k => state.stages[k]?.on).map((k, i) => {
                    const label = STAGE_DEF[k as StageKey]?.name ?? state.stages[k].name ?? k
                    return (
                    <span key={k} style={{ display: 'contents' }}>
                      <span
                        className={'wf-stage-chip click' + (state.stages[k].prompt ? ' edited' : '') + (state.stages[k].custom ? ' custom' : '')}
                        title={`点击编辑「${label}」提示词`}
                        onClick={() => { setPlugEdit(null); setStageEdit(k) }}
                      >
                        <span className="n">{i + 1}</span>{label}
                        {state.stages[k].prompt && <span className="dot" />}
                        <svg className="pen" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                      </span>
                      {insBtn('wf', k)}
                      {plugChips('wf', k)}
                    </span>
                    )
                  })}
                </div>
                {plugPick?.scope === 'wf' && pickerFor('wf', plugPick.after)}
                {plugEdit?.scope === 'wf' && editorFor('wf', plugEdit.after)}
                {stageEdit && (
                  <StagePromptEditor
                    key={stageEdit}
                    stageName={STAGE_DEF[stageEdit as StageKey]?.name ?? state.stages[stageEdit]?.name ?? stageEdit}
                    defaultPrompt={STAGE_DEFAULT_PROMPT[stageEdit] ?? ''}
                    initial={state.stages[stageEdit]?.prompt}
                    onSave={(append) => { setStageAppend(stageEdit, append); setStageEdit(null) }}
                    onCancel={() => setStageEdit(null)}
                  />
                )}
              </div>
              {STAGE_KEYS.filter(k => state.stages[k].on).map(k => {
                const ss = state.stages[k]
                const on = ss.on
                const def = STAGE_DEF[k]
                const review = ss.review ?? DEFAULT_REVIEW
                const reviewMode = review.mode === 'single' ? 'single' : (review.scope === 'workspace' && Array.isArray(review.reviewers) ? 'lens' : 'per-project')
                const num = on ? STAGE_KEYS.filter(x => state.stages[x].on).indexOf(k) + 1 : '·'
                const devOn = k === DEV_KEY && on
                const reviewOn = k === REVIEW_KEY && on
                return (
                  <div className="stage-line" data-stage={k} key={k}>
                    <button className="st-chk on" data-sttoggle={k} title="移除该阶段" onClick={() => toggleStage(k)}>{CK}</button>
                    <span className="st-num">{num}</span>
                    <div className="st-main"><div className="st-name">{def.name}</div><div className="st-desc">{def.desc}</div></div>
                    <div className="st-right">
                      {devOn && chosen.length ? (
                        <span className="st-badge">{chosen.length > 1 ? ('多项目并行 · ' + chosen.length + ' 代理') : '单项目 · 1 代理'}</span>
                      ) : customModelKeys.has(k) ? (
                        <input
                          autoFocus
                          data-stmodel-custom={k}
                          placeholder="输入模型 id"
                          value={customModelInputs[k] ?? ''}
                          style={{ height: 28, padding: '0 8px', borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--accent)', color: 'var(--fg)', fontSize: 12, outline: 'none' }}
                          onChange={e => setCustomModelInputs(prev => ({ ...prev, [k]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') confirmStageCustomModel(k) }}
                          onBlur={() => confirmStageCustomModel(k)}
                        />
                      ) : (
                        <select className="mini-sel" data-stmodel={k} disabled={!on} value={packModel(ss.provider, ss.model)} onChange={e => setStageModel(k, e.target.value)}>
                          {modelOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          <option value="__custom__">自定义…</option>
                        </select>
                      )}
                    </div>
                    {devOn && (
                      <div className="stage-projs">
                        <div className="sp-h">{GIT}{chosen.length ? '每个项目一个开发代理 · 模型独立' : '按项目派发开发代理'}</div>
                        {chosen.length === 0 ? (
                          <div className="sp-empty">未选择项目 — 开发阶段将由单个开发代理处理(使用右侧默认模型)。在上方「涉及项目」勾选后,每个项目会各派一个开发代理并可分别指定模型与版本。</div>
                        ) : (
                          chosen.map(p => (
                            <div className="stage-proj-row" key={p.repoId}>
                              <span className="pj-ic">{GIT}</span>
                              <span className="nm">{p.name}</span>
                              <span className="br">{BRANCH}{branchFor(p) || 'main'}</span>
                              {customModelKeys.has('proj::' + p.repoId) ? (
                                <input
                                  autoFocus
                                  data-stpm-custom={p.repoId}
                                  placeholder="输入模型 id"
                                  value={customModelInputs['proj::' + p.repoId] ?? ''}
                                  style={{ height: 28, padding: '0 8px', borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--accent)', color: 'var(--fg)', fontSize: 12, outline: 'none' }}
                                  onChange={e => setCustomModelInputs(prev => ({ ...prev, ['proj::' + p.repoId]: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') confirmProjCustomModel(p.repoId) }}
                                  onBlur={() => confirmProjCustomModel(p.repoId)}
                                />
                              ) : (
                                <select className="mini-sel" data-stpm={p.repoId} value={p.model} onChange={e => setProjectModel(p.repoId, e.target.value)}>
                                  {modelOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  <option value="__custom__">自定义…</option>
                                </select>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                    {reviewOn && (
                      <div className="stage-projs">
                        <div className="sp-h">{GIT}代码 CR 模式</div>
                        <div className="wf-templates">
                          <button className={'wf-card' + (reviewMode === 'single' ? ' on' : '')} onClick={() => setReviewMode('single')}>
                            <div className="tt">单 agent 全量{CK_CARD}</div>
                            <div className="ds">一个 reviewer 审全工作区</div>
                          </button>
                          <button className={'wf-card' + (reviewMode === 'per-project' ? ' on' : '')} onClick={() => setReviewMode('per-project')}>
                            <div className="tt">并行 · 按项目{CK_CARD}</div>
                            <div className="ds">每个项目一个 reviewer</div>
                          </button>
                          <button className={'wf-card' + (reviewMode === 'lens' ? ' on' : '')} onClick={() => setReviewMode('lens')}>
                            <div className="tt">并行 · 按视角{CK_CARD}</div>
                            <div className="ds">正确性 / 安全 / 性能 / 风格</div>
                          </button>
                        </div>
                        {reviewMode === 'lens' && (
                          <div className="wf-templates">
                            {(Object.keys(LENS_LABELS) as ReviewLens[]).map(lens => {
                              const selected = Array.isArray(review.reviewers) ? review.reviewers.includes(lens) : DEFAULT_LENSES.includes(lens)
                              return (
                                <button key={lens} className={'wf-card' + (selected ? ' on' : '')} onClick={() => toggleReviewLens(lens)}>
                                  <div className="tt">{LENS_LABELS[lens]}{CK_CARD}</div>
                                  <div className="ds">审查视角</div>
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              {STAGE_KEYS.some(k => !state.stages[k].on) && (
                <div className="stage-add" id="crStageAdd">
                  <span className="lab">添加阶段</span>
                  {STAGE_KEYS.filter(k => !state.stages[k].on).map(k => (
                    <button key={k} className="stage-add-chip" data-addstage={k} title={STAGE_DEF[k].desc} onClick={() => toggleStage(k)}>
                      {INS_SVG}{STAGE_DEF[k].name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* step hook: 工作流完成后 */}
          {renderStepHook('__wf', STEP_BARS[2].caption)}
        </div>

        {error && <div className="cr-err" id="crError" style={{ padding: '2px 22px 8px', color: 'var(--err)', fontSize: 12.5 }}>{editing ? '保存失败：' : '创建失败：'}{error}</div>}
        {showHookToggle && (
          <label className="cr-hook-toggle">
            <input type="checkbox" checked={runHooksOnAdd} onChange={e => setRunHooksOnAdd(e.target.checked)} />
            <span>新增项目拉取后,执行「项目 Hook」(__proj) 对其配置</span>
          </label>
        )}
        {removalConfirm && removedProjects.length > 0 && (
          <div className="cr-removal-warn">
            <b>将移除并删除本地代码:</b>{removedProjects.map(p => p.name).join('、')}。此操作不可恢复(仓库镜像与其它工作区不受影响)。再次点击「删除并保存」确认。
          </div>
        )}
        <div className="cr-foot">
          <span className="summary" id="crSummary">工作流 <b>{enabledCount}</b> 阶段 · 涉及 <b>{selectedCount}</b> 个项目</span>
          <span className="sp" />
          <button className="btn-cancel" id="crCancel" onClick={onCancel} disabled={creating}>取消</button>
          <button className={'btn-create' + (removalConfirm && removedProjects.length ? ' danger' : '')} id="crCreate" disabled={!canCreate || creating} onClick={doCreate}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="20 6 9 17 4 12" /></svg>{editing ? (creating ? '保存中…' : (removalConfirm && removedProjects.length ? '删除并保存' : '保存修改')) : (creating ? '创建中…' : '创建工作区')}
          </button>
        </div>
      </div>
    </div>
  )
}
