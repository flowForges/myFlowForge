// P4-A launcher: server-side resolution for the workflow-picker button. Pure functions (no IO) so
// they're unit-testable without booting Electron; run2Handlers.ts wires them to the store's
// readWorkspace/readWorkflows/readCustomStages + Run2Manager.start.
//
// Fixes a real bug: the P3-B temp button read `ws.stages`, which is PERMANENTLY [] for any workspace
// created/edited under the multi-workflow model — the real stages live in `ws.workflows[].stages`
// (or, if that workflow itself has none stashed, fall back to the global workflow template via
// resolveWorkflowStages). Same resolution pattern as proposeRun.ts / resumeWorkspace in handlers.ts.
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PermissionMode } from '@shared/permissions'
import type { Workspace, Workflow, CustomStage } from '../config/schema'
import { stageName, workflowDisplayName, stageBasePrompt, DEFAULT_STAGE_PER_PROJECT_AGENT } from '../config/schema'
import { indexCustomStages } from '../../shared/customStages'
import { pickWorkspaceWorkflow, resolveWorkflowStages } from '../workspace/resolveStages'
import { planFromStages } from './planFromStages'
import type { RunPlan } from './machine'
import type { StageSpec, DevelopProject } from '../orchestrator/orchestrator'
import { createTempBranch, discardTempBranch, isCleanTree } from './tempBranch'

// P5-UI Task 1: short stage blurb for the config-preview overlay, by builtin key. Custom/unknown keys
// fall back to '' (the overlay just omits the line rather than showing anything misleading).
const STAGE_DESC: Record<string, string> = {
  requirement: '梳理与确认本次需求边界',
  design: '设计技术方案与阶段计划',
  develop: '按项目并行开发',
  test: '补充与运行测试',
  review: '多视角代码评审',
}

// P5-UI Task 1: one resolved stage of a launcher-listed workflow — just enough for the picker to
// render a flow preview (stage name + provider/model + whether it gates), PLUS (Task 1 extension) the
// three fields the workflow-overlay's per-stage card needs: whether it fans out per-project/writes
// code, a short description, and the exact instruction text its agent will receive.
export interface LaunchStage {
  key: string
  name: string
  provider: string
  model: string
  gate: boolean
  code: boolean
  desc: string
  prompt: string
}

export interface LaunchInfo {
  workflows: { id: string; name: string; stages: LaunchStage[] }[]
  projects: { name: string; cwd: string; provider?: string; model?: string }[]
}

// Lists a workspace's named workflows (id + display name + resolved stages) and its projects (name +
// absolute worktree cwd + per-project develop provider/model override, if set) — everything the
// launcher picker needs to render, resolved server-side so the renderer never has to know the on-disk
// workspace shape.
//
// `workflows`/`custom` (global workflow templates + the custom-stage library) are OPTIONAL and default
// to [] — a workspace workflow with its own stashed stages (the common case) resolves fine without
// them. They're only needed to resolve the fallback path: a workflow whose `stages` is empty (pre-SP-A
// workspaces, or one that was never edited off the global template) defers to the matching global
// `Workflow` template via resolveWorkflowStages — same fallback resolveStartPlan already relies on, so
// this mirrors it instead of yielding an empty (silently unpreview-able) flow. Callers that can supply
// them (registerRun2's run2:launch-info handler has readWorkflows/readCustomStages in scope already)
// should; callers that can't (pre-existing tests, resolveStartPlan's internal buildLaunchInfo(ws) call
// for its `.projects` — workflow stages aren't used there) keep compiling/behaving unchanged.
export function buildLaunchInfo(ws: Workspace, workflows: Workflow[] = [], custom: CustomStage[] = []): LaunchInfo {
  const custIndex = indexCustomStages(custom)
  return {
    workflows: ws.workflows.map((w) => ({
      id: w.id,
      name: workflowDisplayName(w.name),
      stages: resolveWorkflowStages(w, workflows, custIndex).map((s) => {
        // Mirrors planFromStages' exact prompt composition (base + custom append) so the overlay's
        // "阶段指令" preview matches what the stage's agent will actually receive at run time.
        const base = stageBasePrompt(s.key)
        const custom = s.prompt
        const prompt = custom ? (base ? base + '\n\n' + custom : custom) : (base ?? '')
        return {
          key: s.key,
          name: stageName(s.key, s.name),
          provider: s.provider,
          model: s.model,
          gate: !!s.gate,
          code: s.projectAgent ?? DEFAULT_STAGE_PER_PROJECT_AGENT[s.key] ?? false,
          desc: STAGE_DESC[s.key] ?? '',
          prompt,
        }
      }),
    })),
    projects: ws.projects.map((p) => {
      const name = p.name || p.repoId
      return { name, cwd: join(ws.path, name), provider: p.provider || undefined, model: p.model || undefined }
    }),
  }
}

export interface StartWorkflowOpts {
  workspacePath: string
  workflowId: string
  projectNames: string[]
  task?: string
  runId: string
  permissionMode?: PermissionMode
}

// Resolves the PICKED workflow's stages (falling back to the global template when the workspace's own
// copy is empty — same as resolveWorkflowStages elsewhere) into a RunPlan, and narrows the workspace's
// projects down to the ones the caller selected. Throws a clear error if the workflow id doesn't match
// any of the workspace's named workflows, or if resolution yields zero stages (nothing to run).
export function resolveStartPlan(
  ws: Workspace,
  workflows: Workflow[],
  custom: CustomStage[],
  opts: StartWorkflowOpts,
): { plan: RunPlan; projects: DevelopProject[]; task?: string; permissionMode?: PermissionMode } {
  const wf = pickWorkspaceWorkflow(ws, opts.workflowId)
  // pickWorkspaceWorkflow silently falls back to workflows[0] when the id doesn't match (its contract
  // for the "auto-decide" caller) — the launcher needs an explicit failure instead when the caller asked
  // for a specific, non-existent workflow id.
  if (!wf || wf.id !== opts.workflowId) throw new Error(`未知工作流: ${opts.workflowId}`)

  const custIndex = indexCustomStages(custom)
  const resolved = resolveWorkflowStages(wf, workflows, custIndex)
  if (resolved.length === 0) throw new Error(`工作流「${workflowDisplayName(wf.name)}」没有可执行阶段`)

  const stageSpecs: StageSpec[] = resolved.map((s) => ({
    key: s.key,
    name: stageName(s.key, s.name),
    provider: s.provider,
    model: s.model,
    scope: s.scope,
    gate: s.gate,
    prompt: s.prompt,
  }))
  const plan = planFromStages(opts.runId, stageSpecs)

  const projects = buildLaunchInfo(ws).projects.filter((p) => opts.projectNames.includes(p.name))

  return { plan, projects, task: opts.task, permissionMode: opts.permissionMode }
}

// P1-4: the in-chat launch gate's config (replaces the floating WorkflowOverlay's start path). `projects`
// is ALREADY the caller/gate-selected subset — see field doc — so nothing here needs to filter workspace
// projects down; the "only selected projects fan out" guarantee comes from buildLaunchProjects only ever
// emitting entries for cfg.projects (never the workspace's full project list).
export interface LaunchStartConfig {
  workspacePath: string
  workflowId: string
  // Selected projects with their PER-PROJECT provider/model choice from the gate — already filtered to
  // just the ones the user checked. Threading these into the develop (code) stage's fan-out is what
  // fixes the known gap where startWorkflow dropped the per-project override and fell back to the
  // workflow's default agent/model (see buildLaunchProjects below).
  projects: { name: string; provider: string; model: string }[]
  // Free-text supplementary instructions the user typed into the gate, alongside...
  supplement: string
  // ...`seed`: the user's latest raw chat message — the run's "ground truth" anchor (mirrors the
  // existing `【需求原文（以此为准）】` pattern RunController.buildPrompt injects from `task` — see
  // controller.ts — except here it's baked directly into the root/entry stage's own prompt, per this
  // task's brief, rather than threaded as a separate `task` field to every stage).
  seed: string
}

// Ground-truth block prepended to the root stage's prompt — same anchor phrasing as
// RunController.buildPrompt's `【需求原文（以此为准）】` seed, so a stage agent that's seen that pattern
// elsewhere recognizes this as "the real ask, not a stale/paraphrased brief". `supplement` (the gate's
// free-text box) is appended as a second, clearly-separated block. Either half may be empty (e.g. a
// launch with no typed supplement) — omitted rather than emitting an empty-body heading.
function buildGroundTruth(supplement: string, seed: string): string {
  const parts: string[] = []
  if (seed && seed.trim()) parts.push(`【需求原文（以此为准）】\n${seed}`)
  if (supplement && supplement.trim()) parts.push(`【补充说明】\n${supplement}`)
  return parts.join('\n\n')
}

// Resolves the picked workflow's stages into a RunPlan for the launch gate — same workflow-lookup
// contract as resolveStartPlan (throws on an unknown workflowId), and the SAME global-template fallback
// (see resolveWorkflowStages / buildLaunchInfo above): a workflow whose stashed `ws.workflows[].stages`
// is empty resolves via the matching global `Workflow` template instead of throwing. `workflows`/`custom`
// are optional (default []) so existing 2-arg callers (tests, and the common non-empty-stages case) keep
// compiling/behaving unchanged; the IPC handler (run2Handlers.ts) passes the real store-backed values.
export function buildLaunchPlan(cfg: LaunchStartConfig, ws: Workspace, workflows: Workflow[] = [], custom: CustomStage[] = []): RunPlan {
  const wf = pickWorkspaceWorkflow(ws, cfg.workflowId)
  if (!wf || wf.id !== cfg.workflowId) throw new Error(`未知工作流: ${cfg.workflowId}`)

  const custIndex = indexCustomStages(custom)
  const resolved = resolveWorkflowStages(wf, workflows, custIndex)
  if (resolved.length === 0) throw new Error(`工作流「${workflowDisplayName(wf.name)}」没有可执行阶段`)

  const groundTruth = buildGroundTruth(cfg.supplement, cfg.seed)
  const stageSpecs: StageSpec[] = resolved.map((s, i) => {
    // Root/entry stage = the first stage in run order (typically 需求梳理) — the gate's supplement/seed
    // become that stage's ground truth, matching the brief's "拼进 root 阶段 prompt" instruction.
    const prompt = i === 0 && groundTruth
      ? (s.prompt ? `${groundTruth}\n\n${s.prompt}` : groundTruth)
      : s.prompt
    return {
      key: s.key,
      name: stageName(s.key, s.name),
      provider: s.provider,
      model: s.model,
      scope: s.scope,
      gate: s.gate,
      prompt,
    }
  })
  return planFromStages(`run2-${randomUUID()}`, stageSpecs)
}

// Companion to buildLaunchPlan: the DevelopProject[] to pass alongside its RunPlan into
// Run2Manager.start. `cfg.projects` is already the gate-selected subset (see LaunchStartConfig doc), so
// this is a plain name→cwd/provider/model mapping — NOT a filter — which is exactly what fixes the known
// gap (startWorkflow silently dropped per-project provider/model): fanout.buildWorkOrders prefers
// `p.provider || stage.provider` / `p.model || stage.model` per project, so a selected project's own
// choice here now wins over the develop stage's default agent.
export function buildLaunchProjects(cfg: LaunchStartConfig, ws: Workspace): DevelopProject[] {
  return cfg.projects.map((p) => ({ name: p.name, cwd: join(ws.path, p.name), provider: p.provider, model: p.model }))
}

// P4-2: at run START (before any lane executes), every participating project's worktree gets checked
// out onto the run's shared temp branch (`forge/run-<runId>`, see tempBranch.ts) off THAT project's own
// configured target branch (`ws.projects[].branch` — the branch already checked out in its worktree,
// same field WorkspaceView's project inspector shows as the "git 分支" tag). This is what makes the
// run's code writes land on a throwaway branch instead of the target directly.
//
// `projects` is the already gate-selected DevelopProject[] (from buildLaunchProjects) — just needs each
// one's own target branch looked up by name from `ws.projects`.
//
// Finding 3 (Important — data loss), USER DECISION reject-if-dirty: `git checkout -b temp <base>`
// succeeds even on a DIRTY tree when `base` is the branch already checked out (the normal case) — so
// pre-existing untracked files / uncommitted edits UNRELATED to this run could silently be wiped by a
// later discard's `checkout -f`/`clean -fd`, or absorbed into history by a merge's `add -A`. Guarded
// here as a PRE-PASS over EVERY participating project, run BEFORE creating any branch at all: if any
// project's tree isn't clean, throw naming all of them and create NO branches (no half-state). Only
// once every project is provably clean do we proceed — which is what makes the later `add -A`/
// `checkout -f`/`clean -fd` in tempBranch.ts safe (everything left in the tree after createBranch is
// provably this run's own writes, never a pre-existing unrelated change).
//
// Real git — a dirty tree, a missing/renamed base branch, or any other checkout failure throws from
// createBranch. On failure we do NOT leave some projects on the temp branch and others not in a
// confusing half-state: we best-effort roll back (discardTempBranch) every project whose branch we
// already created before re-throwing a single readable error naming which project failed and why (plus
// whether rollback of the earlier ones succeeded). `createBranch`/`rollback`/`checkClean` are injected
// (default to the real tempBranch.ts functions) purely so callers can stub real git out in tests.
export async function createRunTempBranches(
  ws: Workspace,
  projects: { name: string; cwd: string }[],
  runId: string,
  createBranch: (cwd: string, base: string, runId: string) => Promise<string> = createTempBranch,
  rollback: (cwd: string, target: string, runId: string) => Promise<void> = discardTempBranch,
  checkClean: (cwd: string) => Promise<boolean> = isCleanTree,
): Promise<void> {
  const dirty: string[] = []
  for (const project of projects) {
    if (!(await checkClean(project.cwd))) dirty.push(project.name)
  }
  if (dirty.length > 0) {
    throw new Error(`项目 ${dirty.join('、')} 有未提交或未跟踪的改动，请先提交或清理后再启动工作流`)
  }

  const created: { name: string; cwd: string; target: string }[] = []
  for (const project of projects) {
    const target = ws.projects.find((p) => p.name === project.name)?.branch
    if (!target) {
      throw new Error(`项目「${project.name}」缺少目标分支配置(工作区projects未设置branch),无法创建运行分支`)
    }
    try {
      await createBranch(project.cwd, target, runId)
      created.push({ name: project.name, cwd: project.cwd, target })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const rollbackFailures: string[] = []
      for (const c of created) {
        try {
          await rollback(c.cwd, c.target, runId)
        } catch (rollbackErr) {
          rollbackFailures.push(`${c.name}(${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)})`)
        }
      }
      const rollbackNote = rollbackFailures.length
        ? ` — 回滚也失败,请手动检查这些项目的分支状态: ${rollbackFailures.join(', ')}`
        : created.length
          ? ` (已回滚已建的 ${created.length} 个项目分支: ${created.map((c) => c.name).join(', ')})`
          : ''
      throw new Error(`项目「${project.name}」创建运行分支失败: ${detail}${rollbackNote}`)
    }
  }
}
