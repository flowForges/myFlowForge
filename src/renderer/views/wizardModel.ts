import type { CreateWorkspaceOpts, CreateWorkspaceStage, ReviewConfig, StageCustomFields, Workspace, WsStage } from '@shared/types'
import { REVIEW_LENSES } from '@shared/types'
import type { Plugin } from '@shared/plugin'

// provider+model packed into one <select> value so a model picker maps back to both.
export const packModel = (provider: string, model: string) => provider + '::' + model
export const unpackModel = (v: string): { provider: string; model: string } => {
  const i = v.indexOf('::')
  return i < 0 ? { provider: '', model: v } : { provider: v.slice(0, i), model: v.slice(i + 2) }
}

// custom?: this is a user-defined (non-builtin) stage; carries its template name + behavior flags so it
// runs correctly and its chip renders with the right label. Built-in stages leave these undefined.
export interface WizardStage extends StageCustomFields { on: boolean; provider: string; model: string; review?: ReviewConfig; prompt?: string; custom?: boolean }
export interface WizardProject { repoId: string; name: string; sel: boolean; branch: string; model: string; provider?: string; locked?: boolean; existing?: boolean }
// One tab of the wizard: a named workflow with its own stage config + the display order those stages
// were seeded in (STAGE_KEYS at the call site, or a persisted workflow's own key order ∪ STAGE_KEYS).
export interface WizardWorkflow { id: string; name: string; stages: Record<string, WizardStage>; stageOrder: string[] }
export interface WizardState {
  path: string
  name: string
  nameEdited: boolean
  purpose: string               // 建区目的(可选):seeds the workspace memory `## 建区目的` section
  workflows: WizardWorkflow[]   // one or more workflow tabs being configured
  activeWorkflowId: string      // which workflow tab is currently focused in the wizard UI
  projects: WizardProject[]
  plugins: Plugin[]      // wf-scope hooks: after = stage key or '__start'
  stepPlugins: Plugin[]  // step-scope hooks: after = '__basic' | '__proj' | '__wf'
}

export const emptyWorkflow = (id: string, name: string, stages: Record<string, WizardStage>, stageOrder: string[]): WizardWorkflow => ({ id, name, stages, stageOrder })

export function deriveWsName(path: string, nameEdited: boolean, name: string): string {
  if (nameEdited && name.trim()) return name.trim()
  const seg = path.trim().replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? ''
  return seg
}

// Map one workflow's enabled stages (in its stageOrder) to the wire shape. Extracted so both
// buildCreateOpts (one call per workflow tab) and any future caller share the exact same mapping.
function stagesOf(wf: WizardWorkflow): CreateWorkspaceStage[] {
  return wf.stageOrder
    .filter(k => wf.stages[k]?.on)
    .map(k => {
      const s = wf.stages[k]
      return {
        key: k,
        provider: s.provider,
        model: s.model,
        // ②多镜头CR: an untouched review stage defaults to 并行多视角 all four lenses (matches
        // resolveStages.ts's DEFAULT_REVIEW_CONFIG + StageConfigEditor), so wizard-created workspaces
        // get multi-lens CR by default instead of silently opting out with a per-project config.
        ...(k === 'review' ? { review: s.review ?? { mode: 'parallel' as const, reviewers: [...REVIEW_LENSES] } } : (s.review ? { review: s.review } : {})),
        ...(s.prompt && s.prompt.trim() ? { prompt: s.prompt.trim() } : {}),
        // Carry a custom stage's identity + behavior flags through to the run (built-ins leave these unset).
        ...(s.name ? { name: s.name } : {}),
        ...(s.scope ? { scope: s.scope } : {}),
        ...(s.gate !== undefined ? { gate: s.gate } : {}),
        ...(s.summary !== undefined ? { summary: s.summary } : {}),
        ...(s.projectAgent !== undefined ? { projectAgent: s.projectAgent } : {}),
        ...(s.producesDoc !== undefined ? { producesDoc: s.producesDoc } : {}),
      }
    })
}

export function buildCreateOpts(state: WizardState): CreateWorkspaceOpts {
  const projects = state.projects
    .filter(p => p.sel)
    .map(p => ({ repoId: p.repoId, branch: p.branch, provider: p.provider, model: p.model }))
  return {
    name: deriveWsName(state.path, state.nameEdited, state.name),
    path: state.path.trim(),
    workflows: state.workflows.map(wf => ({ id: wf.id, name: wf.name, stages: stagesOf(wf) })),
    projects,
    plugins: state.plugins,
    stepPlugins: state.stepPlugins,
    ...(state.purpose.trim() ? { purpose: state.purpose.trim() } : {})
  }
}

// The settings Git-project shape (declared inline to avoid a renderer-state import cycle).
interface KnownProject { id: string; name: string; repoUrl: string; defaultBranch: string }

// Light up one persisted workflow's stages on top of the all-off seeded stage map: `baseStages` is the
// caller's all-off seed (so off-stages still have a usable provider/model when toggled on).
function stagesFor(wfStages: WsStage[], baseStages: Record<string, WizardStage>, builtin: Set<string>): Record<string, WizardStage> {
  const stages: Record<string, WizardStage> = {}
  for (const k of Object.keys(baseStages)) stages[k] = { ...baseStages[k], on: false }
  for (const s of wfStages) stages[s.key] = {
    on: true, provider: s.provider, model: s.model, review: s.review,
    ...(s.prompt ? { prompt: s.prompt } : {}),
    // Preserve a custom stage's identity + behavior flags across an edit (built-ins leave these unset).
    ...(builtin.has(s.key) ? {} : { custom: true }),
    ...(s.name ? { name: s.name } : {}),
    ...(s.scope ? { scope: s.scope } : {}),
    ...(s.gate !== undefined ? { gate: s.gate } : {}),
    ...(s.summary !== undefined ? { summary: s.summary } : {}),
    ...(s.projectAgent !== undefined ? { projectAgent: s.projectAgent } : {}),
    ...(s.producesDoc !== undefined ? { producesDoc: s.producesDoc } : {}),
  }
  return stages
}

// A workflow's display order = its own persisted stage-key order, followed by any remaining
// STAGE_KEYS (from baseStages) not already covered — so newly-added built-in stages still show up.
function stageOrderFor(wfStages: WsStage[], baseKeys: string[]): string[] {
  const own = wfStages.map(s => s.key)
  const seen = new Set(own)
  return [...own, ...baseKeys.filter(k => !seen.has(k))]
}

// Build the wizard state for EDITING a persisted workspace: one WizardWorkflow tab per ws.workflows
// entry (light up its stages, mark its projects selected+existing — unchecking one removes it, the
// backend deletes its worktree — and leave other known projects available to add). `baseStages` is the
// all-off seeded stage map from the caller (so off-stages still have a usable provider/model when
// toggled on). `defaultProjectModel` is the packed provider::model seed for not-yet-selected projects.
export function buildEditState(
  ws: Workspace,
  knownProjects: KnownProject[],
  baseStages: Record<string, WizardStage>,
  defaultProjectModel: string
): WizardState {
  const BUILTIN = new Set(Object.keys(baseStages))
  const baseKeys = Object.keys(baseStages)
  const workflows: WizardWorkflow[] = ws.workflows.map(wf => emptyWorkflow(
    wf.id, wf.name,
    stagesFor(wf.stages, baseStages, BUILTIN),
    stageOrderFor(wf.stages, baseKeys)
  ))

  const wsById = new Map(ws.projects.map(p => [p.repoId, p]))
  const projects: WizardProject[] = knownProjects.map(kp => {
    const w = wsById.get(kp.id)
    return w
      ? { repoId: kp.id, name: kp.name, sel: true, existing: true, branch: w.branch, model: packModel(w.provider, w.model), provider: w.provider }
      : { repoId: kp.id, name: kp.name, sel: false, branch: '', model: defaultProjectModel }
  })
  for (const w of ws.projects) {
    if (!knownProjects.some(kp => kp.id === w.repoId)) {
      projects.push({ repoId: w.repoId, name: w.name, sel: true, existing: true, branch: w.branch, model: packModel(w.provider, w.model), provider: w.provider })
    }
  }

  return {
    path: ws.path, name: ws.name, nameEdited: true,
    purpose: ws.purpose ?? '',
    workflows, activeWorkflowId: ws.workflows[0]?.id ?? '',
    projects,
    plugins: (ws.plugins ?? []).map(p => ({ ...p })),
    stepPlugins: (ws.stepPlugins ?? []).map(p => ({ ...p }))
  }
}
