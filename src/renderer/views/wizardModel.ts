import type { CreateWorkspaceOpts, ReviewConfig, Workspace } from '@shared/types'
import type { Plugin } from '@shared/plugin'

// provider+model packed into one <select> value so a model picker maps back to both.
export const packModel = (provider: string, model: string) => provider + '::' + model
export const unpackModel = (v: string): { provider: string; model: string } => {
  const i = v.indexOf('::')
  return i < 0 ? { provider: '', model: v } : { provider: v.slice(0, i), model: v.slice(i + 2) }
}

export interface WizardStage { on: boolean; provider: string; model: string; review?: ReviewConfig; prompt?: string }
export interface WizardProject { repoId: string; name: string; sel: boolean; branch: string; model: string; provider?: string; locked?: boolean }
export interface WizardState {
  path: string
  name: string
  nameEdited: boolean
  workflowId: string
  stages: Record<string, WizardStage>   // keyed by stage key; ORDER is defined by STAGE order at the call site
  projects: WizardProject[]
  plugins: Plugin[]      // wf-scope hooks: after = stage key or '__start'
  stepPlugins: Plugin[]  // step-scope hooks: after = '__basic' | '__proj' | '__wf'
}

export function deriveWsName(path: string, nameEdited: boolean, name: string): string {
  if (nameEdited && name.trim()) return name.trim()
  const seg = path.trim().replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? ''
  return seg
}

// stageOrder lets the caller pass STAGE_KEYS so enabled stages keep workflow order.
export function buildCreateOpts(state: WizardState, stageOrder: string[] = Object.keys(state.stages)): CreateWorkspaceOpts {
  const stages = stageOrder
    .filter(k => state.stages[k]?.on)
    .map(k => ({
      key: k,
      provider: state.stages[k].provider,
      model: state.stages[k].model,
      ...(k === 'review' ? { review: state.stages[k].review ?? { mode: 'parallel' as const, scope: 'per-project' as const } } : {}),
      ...(state.stages[k].prompt && state.stages[k].prompt!.trim() ? { prompt: state.stages[k].prompt!.trim() } : {}),
    }))
  const projects = state.projects
    .filter(p => p.sel)
    .map(p => ({ repoId: p.repoId, branch: p.branch, provider: p.provider, model: p.model }))
  return {
    name: deriveWsName(state.path, state.nameEdited, state.name),
    path: state.path.trim(),
    workflowId: state.workflowId,
    stages,
    projects,
    plugins: state.plugins,
    stepPlugins: state.stepPlugins
  }
}

// The settings Git-project shape (declared inline to avoid a renderer-state import cycle).
interface KnownProject { id: string; name: string; repoUrl: string; defaultBranch: string }

// Build the wizard state for EDITING a persisted workspace: light up its stages, mark its projects
// selected+locked (cannot be removed), and leave other known projects available to add. `baseStages`
// is the all-off seeded stage map from the caller (so off-stages still have a usable provider/model
// when toggled on). `defaultProjectModel` is the packed provider::model seed for not-yet-selected projects.
export function buildEditState(
  ws: Workspace,
  knownProjects: KnownProject[],
  baseStages: Record<string, WizardStage>,
  defaultProjectModel: string
): WizardState {
  const stages: Record<string, WizardStage> = {}
  for (const k of Object.keys(baseStages)) stages[k] = { ...baseStages[k], on: false }
  for (const s of ws.stages) stages[s.key] = { on: true, provider: s.provider, model: s.model, review: s.review, ...(s.prompt ? { prompt: s.prompt } : {}) }

  const wsById = new Map(ws.projects.map(p => [p.repoId, p]))
  const projects: WizardProject[] = knownProjects.map(kp => {
    const w = wsById.get(kp.id)
    return w
      ? { repoId: kp.id, name: kp.name, sel: true, locked: true, branch: w.branch, model: packModel(w.provider, w.model), provider: w.provider }
      : { repoId: kp.id, name: kp.name, sel: false, branch: '', model: defaultProjectModel }
  })
  for (const w of ws.projects) {
    if (!knownProjects.some(kp => kp.id === w.repoId)) {
      projects.push({ repoId: w.repoId, name: w.name, sel: true, locked: true, branch: w.branch, model: packModel(w.provider, w.model), provider: w.provider })
    }
  }

  return {
    path: ws.path, name: ws.name, nameEdited: true, workflowId: '__custom', stages, projects,
    plugins: (ws.plugins ?? []).map(p => ({ ...p })),
    stepPlugins: (ws.stepPlugins ?? []).map(p => ({ ...p }))
  }
}
