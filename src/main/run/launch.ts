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
import { stageName, workflowDisplayName, stageBasePrompt, DEFAULT_STAGE_PER_PROJECT_AGENT, DEFAULT_STAGE_PRODUCES_DOC } from '../config/schema'
import { indexCustomStages } from '../../shared/customStages'
import { pickWorkspaceWorkflow, resolveWorkflowStages } from '../workspace/resolveStages'
import { planFromStages } from './planFromStages'
import { reviewLenses } from './reviewFanout'
import { collectRunHooks } from './hooks'
import type { RunPlan, StageProjectAgent } from './machine'
import type { StageSpec, DevelopProject } from './runTypes'
import { createTempBranch, discardTempBranch, currentBranch, type TempBranchCreated } from './tempBranch'

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
  // producesDoc = this stage hands off a single markdown deliverable (需求评估/技术方案设计). The gate uses
  // it to decide whether to offer the 单代理⇄按项目 fan-out toggle — a doc stage produces ONE deliverable,
  // so per-project fan-out doesn't apply; only non-code, non-doc stages (写单测/代码CR) get the toggle.
  producesDoc: boolean
  // lensCount = how many CR视角 this stage fans into when NOT per-project (代码CR defaults to 多镜头, 4
  // lenses). >0 ⇒ its "off" (root) state is 多镜头, NOT 单代理 — the gate labels the toggle 多镜头⇄按项目
  // and the mode tag 多镜头·N accordingly, instead of the misleading 单代理. 0/undefined for every other stage.
  lensCount?: number
  desc: string
  prompt: string
  // 阶段级项目代理:工作区里为本阶段逐项目配好的编码代理(「按项目 CR」用与「代码开发」不同的 provider)。
  // 启动门拿它当各项目行的初值;没配过就没有这个字段。
  projectAgents?: StageProjectAgent[]
}

export interface LaunchInfo {
  workflows: { id: string; name: string; stages: LaunchStage[] }[]
  projects: { name: string; cwd: string; provider?: string; model?: string }[]
  // Workflow-scope hooks (ws.plugins + run-end stepPlugins, see collectRunHooks) so the launch gate can
  // list them with on/off toggles — same "既然可选" treatment as stages. `after` is the weave point
  // ('__start' / a stage key / '__wf') so the gate can show WHEN each hook fires.
  hooks: { id: string; name: string; after: string }[]
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
          producesDoc: s.producesDoc ?? DEFAULT_STAGE_PRODUCES_DOC[s.key] ?? false,
          lensCount: reviewLenses(s.review)?.length ?? 0,
          desc: STAGE_DESC[s.key] ?? '',
          prompt,
          ...(s.projectAgents?.length ? { projectAgents: s.projectAgents } : {}),
        }
      }),
    })),
    projects: ws.projects.map((p) => {
      const name = p.name || p.repoId
      return { name, cwd: join(ws.path, name), provider: p.provider || undefined, model: p.model || undefined }
    }),
    hooks: collectRunHooks(ws.plugins, ws.stepPlugins).map((h) => ({ id: h.id, name: h.name, after: h.after })),
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
    review: s.review, // ②多镜头CR: honor the review stage's fan-out config (per-lens reviewers)
  }))
  // ③stage hooks: thread the workspace's woven hooks (ws.plugins) + run-end (__wf) step hooks.
  const plan = planFromStages(opts.runId, stageSpecs, collectRunHooks(ws.plugins, ws.stepPlugins))

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
  projects: { name: string; provider: string; model: string; permissionMode?: PermissionMode; brief?: string }[]
  // Free-text supplementary instructions the user typed into the gate, alongside...
  supplement: string
  // ...`seed`: the user's latest raw chat message — the run's "ground truth" anchor (mirrors the
  // existing `【需求原文（以此为准）】` pattern RunController.buildPrompt injects from `task` — see
  // controller.ts — except here it's baked directly into the root/entry stage's own prompt, per this
  // task's brief, rather than threaded as a separate `task` field to every stage).
  seed: string
  // Spec §8: the session the launch gate was opened/confirmed in — the OWNING session for this run.
  // Threaded through to Run2Manager.start (Run2StartOpts.sessionId) so run2 interaction cards only
  // show/resolve in that session (WorkspaceView.tsx), not whichever tab happens to be active. Optional
  // so existing callers/tests that build a LaunchStartConfig without it keep compiling unchanged.
  sessionId?: string
  // Per-stage choices from the launch gate's interactive flow: which stages to actually run (unchecked
  // stages are DROPPED from the plan — this is how "跳过需求评估" works, instead of hoping the agent
  // reads it out of the supplement), plus an optional provider/model override per stage (for root-scope
  // stages the gate exposes a picker; code/per-project stages keep taking their provider/model from the
  // per-project choice). Keyed by stage key. Omitted → every stage runs with its workflow-default agent
  // (old behavior), so existing callers/tests keep working unchanged.
  // `perProject`: the gate's 单代理⇄按项目 toggle for a non-code, non-doc stage (写单测/代码CR). Present ONLY
  // for toggle-eligible stages — true → force scope 'per-project' (one agent per project), false → force
  // 'root' (single). Absent (undefined) for every other stage so its own scope default is left untouched
  // (critical: sending false for develop/design would wrongly collapse their per-project fan-out to root).
  // `projects` = 本次启动为该阶段逐项目指定的编码代理(阶段级项目代理)。只对 per-project 阶段有意义,
  // 让「按项目 CR」这次用与「代码开发」不同的 agent。省略 ⇒ 沿用工作区里配好的 WsStage.projectAgents;
  // 两处都没有 ⇒ 跟项目走(旧行为)。
  stages?: { key: string; enabled: boolean; provider?: string; model?: string; perProject?: boolean; permissionMode?: PermissionMode; projects?: StageProjectAgent[] }[]
  // Per-hook on/off from the gate (see LaunchInfo.hooks). Unchecked hooks are dropped from the run.
  // Keyed by plugin id; a hook id absent here defaults to enabled. Omitted → all hooks run (old behavior).
  hooks?: { id: string; enabled: boolean }[]
  // `stages` 是不是完整名单:true ⇒ 没列进来的阶段一律丢弃(不再走「没提到 = 启用」那条后路)。
  // 对话式工作流的执行尾段用它 —— 名单来自 session,启动门里被取消的阶段本来就不在里面,不声明的话
  // 它们会在这里被工作区的全量阶段"补"回来。
  stagesExclusive?: boolean
  // 对话式工作流尾段:尾段之前已完成的对话阶段(见 RunPlan.leadStages)。透传到 plan 供进度显示按完整工作流算。
  leadStages?: { key: string; name: string; provider: string; model: string }[]
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

// The run's `deps.task` seed for the launch-gate path — the requirement (seed) + the user's supplement,
// as PLAIN content (RunController.buildPrompt wraps it in its own `【需求原文（以此为准）】` header, prepended
// to EVERY stage). Without this the gate path left deps.task unset, so only the ROOT stage (which bakes
// buildGroundTruth into its own prompt) saw the requirement — every downstream stage (技术方案设计, 开发…)
// got an empty seed and depended entirely on the upstream artifact. When a requirement stage then failed
// or was killed, the downstream stage lost the requirement completely (saw only a "完成" fallback). Empty
// → '' (the caller passes `|| undefined` so buildPrompt emits no seed block at all).
/**
 * 这次启动到底有没有「要做什么」。用户反馈(2026-08-12):什么也没聊、什么也没输入就点了启动,阶段 agent
 * 手上只有一串项目名,于是自己猜一个需求出来、执行了一堆东西。什么都没有时就该什么都不执行。
 *
 * 门槛压到最低:需求(对话总结)和补充说明**任意一个**有内容即可 —— 完全没聊过、但在门里手打一句需求
 * 就启动,这条路要留着。启动门和 workflow:enter 都用它,UI 挡不住「⚡自动」那条路,主进程那道才是硬的。
 */
export function hasRequirement(cfg: { seed?: string; supplement?: string }): boolean {
  return !!(cfg.seed?.trim() || cfg.supplement?.trim())
}

export function launchTaskSeed(cfg: { seed: string; supplement: string }): string {
  const seed = (cfg.seed ?? '').trim()
  const supplement = (cfg.supplement ?? '').trim()
  return [seed, supplement && `【补充说明】\n${supplement}`].filter(Boolean).join('\n\n')
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
  const resolvedAll = resolveWorkflowStages(wf, workflows, custIndex)
  if (resolvedAll.length === 0) throw new Error(`工作流「${workflowDisplayName(wf.name)}」没有可执行阶段`)

  // Interactive stage choices (gate): drop unchecked stages, apply per-stage provider/model overrides.
  // A stage key absent from cfg.stages defaults to enabled with no override (backward compatible — a
  // caller that passes no stages runs everything as before). Guard against disabling every stage.
  //
  // stagesExclusive 反转那条「没提到 = 启用」的后路:cfg.stages 就是完整名单,没列的一律丢弃。对话式工作流
  // 的执行尾段必须这样 —— 它的名单来自 session(启动门里被取消的阶段从一开始就不在里面),而这里是拿工作区
  // 的全量阶段重新解析的。不这样,用户取消掉的「需求评估」会在进入尾段时复活并真的跑一遍,还把 ribbon 的
  // 阶段序号顶偏一格(执行代码开发却显示「3/4 写单测」)。见 workflowEnter.tailLaunchConfig。
  const stageChoice = new Map((cfg.stages ?? []).map((s) => [s.key, s]))
  const resolved = resolvedAll.filter((s) => cfg.stagesExclusive
    ? stageChoice.get(s.key)?.enabled === true
    : stageChoice.get(s.key)?.enabled !== false)
  if (resolved.length === 0) throw new Error('至少要保留一个阶段')

  const groundTruth = buildGroundTruth(cfg.supplement, cfg.seed)
  const stageSpecs: StageSpec[] = resolved.map((s, i) => {
    // Root/entry stage = the first stage in run order (typically 需求梳理) — the gate's supplement/seed
    // become that stage's ground truth, matching the brief's "拼进 root 阶段 prompt" instruction.
    const prompt = i === 0 && groundTruth
      ? (s.prompt ? `${groundTruth}\n\n${s.prompt}` : groundTruth)
      : s.prompt
    const choice = stageChoice.get(s.key)
    // 单代理⇄按项目 toggle (写单测/代码CR): an explicit gate choice wins over the stage's default scope.
    // undefined (every non-toggle stage) leaves s.scope alone so planFromStages' stageScope default still
    // applies (develop/design → per-project). true → per-project fan-out; false → root/single.
    const scope = choice?.perProject === true ? 'per-project'
      : choice?.perProject === false ? 'root'
      : s.scope
    return {
      key: s.key,
      name: stageName(s.key, s.name),
      provider: choice?.provider || s.provider,
      model: choice?.model || s.model,
      scope,
      gate: s.gate,
      prompt,
      review: s.review, // ②多镜头CR: honor the review stage's fan-out config (per-lens reviewers)
      // P1.2/P1.3: the gate's per-stage permission choice wins; else the stage's own persisted default;
      // else undefined → fanout falls back to the run-wide permission.
      permissionMode: choice?.permissionMode ?? s.permissionMode,
      // 阶段级项目代理:启动门这次改的赢过工作区里配好的;都没有 ⇒ undefined,fanout 走项目的编码代理。
      projectAgents: choice?.projects ?? s.projectAgents,
    }
  })
  // ③stage hooks: thread the workspace's woven hooks (ws.plugins) + run-end (__wf) step hooks — minus any
  // the gate unchecked (既然阶段可选,hook 也可选). A hook id absent from cfg.hooks defaults to enabled.
  const hookChoice = new Map((cfg.hooks ?? []).map((h) => [h.id, h]))
  const hooks = collectRunHooks(ws.plugins, ws.stepPlugins).filter((h) => hookChoice.get(h.id)?.enabled !== false)
  const plan = planFromStages(`run2-${randomUUID()}`, stageSpecs, hooks)
  // 对话式工作流:把尾段之前的已完成对话阶段记到 plan,供进度/运行历史按完整工作流显示(1/4 而非 0/3)。
  if (cfg.leadStages?.length) plan.leadStages = cfg.leadStages
  return plan
}

// Companion to buildLaunchPlan: the DevelopProject[] to pass alongside its RunPlan into
// Run2Manager.start. `cfg.projects` is already the gate-selected subset (see LaunchStartConfig doc), so
// this is a plain name→cwd/provider/model mapping — NOT a filter — which is exactly what fixes the known
// gap (startWorkflow silently dropped per-project provider/model): fanout.buildWorkOrders prefers
// `p.provider || stage.provider` / `p.model || stage.model` per project, so a selected project's own
// choice here now wins over the develop stage's default agent.
export function buildLaunchProjects(cfg: LaunchStartConfig, ws: Workspace): DevelopProject[] {
  return cfg.projects.map((p) => ({ name: p.name, cwd: join(ws.path, p.name), provider: p.provider, model: p.model, permissionMode: p.permissionMode, brief: p.brief }))
}

// P4-2: at run START (before any lane executes), every participating project's worktree gets checked
// out onto the run's shared temp branch (`forge/run-<runId>`, see tempBranch.ts) off THAT project's own
// CURRENTLY CHECKED-OUT branch. This is what makes the run's code writes land on a throwaway branch
// instead of the target directly.
//
// 基准分支怎么定 (2026-08-17 bug 修法): 曾经从 ws.projects[].branch —— 建工作区那一刻存盘的字段 ——
// 取基准。用户后来在项目里 `git switch` 到别的分支，这个字段从不回写，于是「在 branch1 上开发」的用户
// 被静默地从 main 切出去、跑完又合回 main，天天冲突。现在改成实测：每个项目的基准 = currentBranch(cwd)
// 此刻真实的 HEAD，不看、也不信任何存盘字段。
//
// 前置的 detached HEAD 拒绝: currentBranch 对 detached HEAD 归一返回 ''，这里在动任何 git 之前先把
// EVERY project 都探测一遍——只要有一个 detached，直接抛错、一个分支都不建（不留半状态）。等真正建分支
// 的循环开始时，target 已经全部确定合法，不会中途因为基准缺失而失败。
//
// 用户的脏树不再是问题: createTempBranch 自己的运行前快照 commit 把它原样带过去（见 tempBranch.ts），
// 这里只把每个项目的快照 SHA 收集起来一并返回，好让调用方（run2Handlers.ts）转手交给 controller，回滚/
// 丢弃/终止时都能把这份快照还原回去。
//
// `projects` 是已经过关卡筛选的 DevelopProject[]（来自 buildLaunchProjects）。
//
// Real git — 任何 checkout 失败都从 createBranch 抛出。失败时绝不留下「部分项目已切到临时分支、部分还
// 停在原地」的半状态：尽力回滚（rollback）每一个已经建好的项目分支，再重新抛出一个可读的错误，点名是哪个
// 项目失败、为什么（以及更早那些项目的回滚是否成功）。回滚要带上该项目自己的快照 SHA —— 否则回滚会把
// 这份快照代表的、用户原本未提交的改动一并销毁。`createBranch`/`rollback`/`readCurrentBranch` 全部可注入
// （默认落到 tempBranch.ts 的真实实现），纯粹是为了让测试把真实 git 换成假的。
export async function createRunTempBranches(
  ws: Workspace,
  projects: { name: string; cwd: string }[],
  runId: string,
  createBranch: (cwd: string, base: string, runId: string) => Promise<TempBranchCreated> = createTempBranch,
  rollback: (cwd: string, target: string, runId: string, snapshotSha: string | null) => Promise<void> = discardTempBranch,
  readCurrentBranch: (cwd: string) => Promise<string> = currentBranch,
): Promise<{ targets: Record<string, string>; snapshots: Record<string, string> }> {
  // 前置全扫：任何一个项目处于 detached HEAD、或压根读不出当前分支，都在这里挡掉，一个分支都别建
  // （不留半状态）。不回落到 ws.projects[].branch —— 那个字段正是本次要修掉的错误来源。
  //
  // Task 8 审查修正：readCurrentBranch（tempBranch.ts 的 currentBranch）现在只对 detached HEAD 归一
  // 返回 ''，其它失败（项目目录不存在、不是 git 仓库、git 未装……）一律原样抛出 —— 这里必须分开接住，
  // 否则两种性质完全不同的失败会被一句「请 git switch」统一打发，而 git switch 对一个目录都不存在的
  // 项目毫无意义。抛出的信息把 git 的原始报错带出来，不替用户瞎猜成因。
  const targets: Record<string, string> = {}
  for (const project of projects) {
    let base: string
    try {
      base = await readCurrentBranch(project.cwd)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`项目「${project.name}」读取当前分支失败，无法确定运行基准：${detail}`)
    }
    if (!base) {
      throw new Error(`项目「${project.name}」当前处于 detached HEAD（未在任何分支上），请先 git switch 到一个分支再启动工作流`)
    }
    targets[project.name] = base
  }

  const snapshots: Record<string, string> = {}
  const created: { name: string; cwd: string; target: string }[] = []
  for (const project of projects) {
    const target = targets[project.name]
    try {
      const { snapshotSha } = await createBranch(project.cwd, target, runId)
      if (snapshotSha) snapshots[project.name] = snapshotSha
      created.push({ name: project.name, cwd: project.cwd, target })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const rollbackFailures: string[] = []
      for (const c of created) {
        try {
          await rollback(c.cwd, c.target, runId, snapshots[c.name] ?? null)
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
  return { targets, snapshots }
}
