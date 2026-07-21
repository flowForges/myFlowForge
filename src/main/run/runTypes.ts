import type { ReviewConfig } from '../config/schema'
import type { Plugin } from '../../shared/plugin'
import type { StageRuntime } from '@shared/types'
import type { PermissionMode } from '@shared/permissions'

export interface AgentRef { runId: string; stageKey: string; agentId: string; name: string }

export type MessageType =
  | 'task' | 'result' | 'handoff' | 'question' | 'answer' | 'confirm' | 'input' | 'status' | 'read' | 'error'

export interface ArtifactRef { path: string; kind: string }

export interface AgentMessage {
  id: string
  runId: string
  from: AgentRef | 'orchestrator' | 'user'
  to: AgentRef | 'orchestrator' | 'broadcast'
  type: MessageType
  payload: unknown
  artifacts: ArtifactRef[]
  ts: string
}

export interface HandoffBrief {
  agentName: string
  summary: string
  artifacts: { path: string; kind: string }[]
}

// Forge tools a working stage sub-agent legitimately needs. EXCLUDES forge_propose_plan:
// the orchestrator bridge ctx doesn't implement proposePlan, and a stage agent that tries to
// propose (because the auto-discovered forge-workflow skill told it to) would error and fall
// back to a confusing forge:run fence. Restricting the toolset means stage agents never even
// see the propose tool. Tool names mirror ALL_TOOLS in mcp/forgeMcp.ts (minus forge_propose_plan).
export const STAGE_FORGE_TOOLS = 'forge_read_context,forge_write_artifact,forge_ask,forge_handoff,forge_heartbeat'

export type StageScope = 'root' | 'per-project'
// `projects` (by name) optionally scopes a PER-PROJECT stage to a subset of the run's projects — e.g.
// analyze all 5 projects but develop only 2. Absent/empty = every project. Ignored for root stages.
// gate: override the default review-gate behavior for this stage (see stageGated). reworkNote:
// set by the rework loop when the user 打回重做 — carries their revision direction into the re-run.
// summary: after per-project runs, append a 汇总 agent (design's cross-project consolidation). projectAgent:
// use each project's own provider/model (develop). producesDoc: force a markdown deliverable (design). All
// default (per built-in key) via the config helpers; custom stages set them explicitly.
export interface StageSpec { key: string; name: string; provider: string; model: string; scope?: StageScope; review?: ReviewConfig; prompt?: string; projects?: string[]; gate?: boolean; reworkNote?: string; summary?: boolean; projectAgent?: boolean; producesDoc?: boolean }

// Where a stage's agent(s) are spawned:
//  - 'root'        → one agent in the workspace root
//  - 'per-project' → one agent per project, each in its project worktree, so it loads
//                    that project's project-level skills/rules.
// `develop` MUST be per-project (it edits project code); `design` defaults to per-project
// (so it can read each project's skills/rules); the rest stay at the workspace root.
// An explicit `spec.scope` overrides the default.
const DEFAULT_STAGE_SCOPE: Record<string, StageScope> = { develop: 'per-project', design: 'per-project' }
export function stageScope(spec: StageSpec): StageScope { return spec.scope ?? DEFAULT_STAGE_SCOPE[spec.key] ?? 'root' }
export interface DevelopProject { name: string; cwd: string; provider?: string; model?: string }
export interface StartRunOpts {
  runId: string
  workspaceName: string
  workspacePath: string
  // The chat session that owns this run — surfaced on RunState so the renderer scopes the run + its
  // gate cards to that session's tab (see RunState.sessionId). Optional: direct/legacy runs omit it.
  sessionId?: string
  stages: StageSpec[]
  developProjects: DevelopProject[]
  task?: string   // seeds the first (requirement) stage's prompt; from the user's first chat message
  plugins?: Plugin[]   // workflow-scope plugins (hook micro-agents) woven between stages by `after`
  // step-scope plugins, keyed by `after`. Only `after === '__wf'` (工作流完成后) is executed here —
  // at the END of startRun, after all stages, skipped on cancel. `__basic`/`__proj` (run during
  // workspace creation) are DEFERRED to a follow-up (see runHook callsite note).
  stepPlugins?: Plugin[]
  // Resume of a cancelled/failed run: `stages` holds ONLY the remaining stages. `completedStages`
  // is replayed into the run (so the UI shows them done) and `priorBriefs` seeds this.briefs so the
  // remaining stages inherit prior context — provider-agnostic, which is what enables cross-model resume.
  resume?: { completedStages: StageRuntime[]; priorBriefs: HandoffBrief[] }
  workflowId?: string
  workflowName?: string
  // Permission shield from the initiating chat session; passed to every stage sub-agent's run() so the
  // shield governs stage agents too (not just the main chat agent). Absent → provider default ('auto').
  permissionMode?: PermissionMode
  // 主代理整理的需求级简报(背景/目标/约束/指定插件),注入每个 stage 子代理 prompt(一份共享)。
  brief?: string
  // 用户本轮触发工作流的最新原始消息。作为「需求以此为准」的地面真相注入每个 stage 子代理 prompt——
  // 当主代理把 brief/task 提炼跑偏(混入旧话题)时,阶段子代理据此纠偏。
  userMessage?: string
}
