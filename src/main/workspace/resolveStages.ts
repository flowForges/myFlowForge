import type { Workspace, WsWorkflow, WsStage, Workflow, ReviewConfig } from '../config/schema'
import { workflowDisplayName } from '../config/schema'
import { resolveStages as resolveLibRefs, type StageDefById } from '../../shared/customStages'

// Default CR mode when a review stage carries no explicit review config (user-confirmed default).
const DEFAULT_REVIEW_CONFIG: ReviewConfig = { mode: 'parallel', scope: 'per-project' }

// Fill the review stage's default CR config when absent; leave every other stage and any explicit
// review config untouched. Returns a new array (does not mutate the input stages).
function withReviewDefaults(stages: WsStage[]): WsStage[] {
  return stages.map(s => (s.key === 'review' && !s.review ? { ...s, review: DEFAULT_REVIEW_CONFIG } : s))
}

// Materialize a global workflow template's stages into WsStage[]: resolve any library-referenced
// (libId) template stages against the global custom-stage library, map defaultAgent/defaultModel →
// provider/model, carry over custom-stage identity/behavior flags, and fill review defaults.
// Shared by resolveStages' fallback path and resolveWorkflowStages' fallback path (DRY).
function materializeGlobalStages(g: Workflow, customStagesById: StageDefById = {}): WsStage[] {
  return withReviewDefaults(resolveLibRefs(g.stages, customStagesById).map(s => ({
    key: s.key, provider: s.defaultAgent, model: s.defaultModel,
    // Carry a custom stage's identity + behavior flags from the template onto the resolved WsStage.
    ...(s.name ? { name: s.name } : {}),
    ...(s.scope ? { scope: s.scope } : {}),
    ...(s.gate !== undefined ? { gate: s.gate } : {}),
    ...(s.review ? { review: s.review } : {}),
    ...(s.summary !== undefined ? { summary: s.summary } : {}),
    ...(s.projectAgent !== undefined ? { projectAgent: s.projectAgent } : {}),
    ...(s.producesDoc !== undefined ? { producesDoc: s.producesDoc } : {}),
    // prompt: the template's per-stage append (stagePrompts) OR the stage's own prompt (custom body).
    ...((s.prompt ?? g.stagePrompts?.[s.key]) ? { prompt: s.prompt ?? g.stagePrompts[s.key] } : {}),
  })))
}

// Stages persisted on the workspace win; for pre-SP-A workspaces (empty stages) fall back to the
// workflow definition (by workflowId), mapping defaultAgent/defaultModel → provider/model.
// In both paths the review stage gets a default CR config (parallel/per-project) when none is set.
export function resolveStages(ws: Pick<Workspace, 'stages' | 'workflowId'>, workflows: Workflow[], customStagesById: StageDefById = {}): WsStage[] {
  if (ws.stages && ws.stages.length > 0) return withReviewDefaults(ws.stages)
  const wf = workflows.find(w => w.id === ws.workflowId)
  if (!wf) return []
  return materializeGlobalStages(wf, customStagesById)
}

// 选出运行时要用的那条工作流:命中 id → 该条;无 id/对不上 → 第一条(默认);空 → null。
export function pickWorkspaceWorkflow(ws: Workspace, workflowId?: string): WsWorkflow | null {
  if (ws.workflows.length === 0) return null
  if (workflowId) return ws.workflows.find(w => w.id === workflowId) ?? ws.workflows[0]
  return ws.workflows[0]
}

// 解析一条工作流的阶段:固化阶段非空 → 补 review 默认返回;空 → 回退全局模板(沿用 resolveStages 老逻辑)。
// 回退先按 id 命中(常规:向导选模板时 WsWorkflow.id 原样抄自全局模板 id);id 对不上时按显示名二次
// 兜底 —— 覆盖「工作区那份 id 是老快照/生成值,但用户看到的名字仍是某个全局模板」的场景(如模板后来被
// 删除重建换了 id,或工作区文件是迁移/生成出来的,不是走向导原样复制的),让预览(launcher)和真正
// 启动(resolveStartPlan,同一份解析)看到一致的阶段,而不是各自静默兜成空数组。
export function resolveWorkflowStages(wf: WsWorkflow, workflows: Workflow[], customStagesById: StageDefById = {}): WsStage[] {
  if (wf.stages.length > 0) return withReviewDefaults(wf.stages)
  const g = workflows.find(w => w.id === wf.id) ?? workflows.find(w => w.name === workflowDisplayName(wf.name))
  if (!g) return []
  return materializeGlobalStages(g, customStagesById)
}

// ad-hoc:所有工作区工作流阶段按 key 去重(首条优先),供主代理用 stages 参数裁剪。
export function unionWorkflowStages(ws: Workspace, workflows: Workflow[], customStagesById: StageDefById = {}): WsStage[] {
  const seen = new Map<string, WsStage>()
  for (const wf of ws.workflows) {
    for (const s of resolveWorkflowStages(wf, workflows, customStagesById)) {
      if (!seen.has(s.key)) seen.set(s.key, s)
    }
  }
  return [...seen.values()]
}
