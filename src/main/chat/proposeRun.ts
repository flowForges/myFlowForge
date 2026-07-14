import type { Workspace, Workflow } from '../config/schema'
import { ensureWorkspaceWorkflows } from '../config/schema'
import type { StartRunOpts } from '../orchestrator/orchestrator'
import type { RunState } from '@shared/types'
import { workspaceToStartRunOpts } from '../workspace/workspaceRun'
import { pickWorkspaceWorkflow, resolveWorkflowStages, unionWorkflowStages } from '../workspace/resolveStages'
import { planStages, planHooks, type PlanStageInfo, type PlanHookInfo } from '../workspace/planSummary'
import { indexCustomStages, type CustomStageDef } from '../../shared/customStages'

export interface ProposeDeps {
  getRun: () => RunState | null
  readWorkspace: (p: string) => Workspace | null
  readWorkflows: () => Workflow[]
  // Global custom-stage library defs, so a template's libId references materialize the current shared
  // definition. Optional — absent → no library refs to resolve (built-in / inline stages unaffected).
  readCustomStages?: () => CustomStageDef[]
  writeWorkspace: (ws: Workspace) => void
  startRun: (o: StartRunOpts) => void
  emitPlanRequest: (wsPath: string, req: { id: string; approach: string; stages: PlanStageInfo[]; hooks: PlanHookInfo[]; allProjects: string[]; task?: string; workflowId?: string; workflowName?: string; workflowOptions?: { id: string; name: string }[] }) => void
  emitNote: (wsPath: string, text: string) => void
  // #1: after an approved chat-triggered run starts, flip the triggering session to workflow mode
  // (setSessionMode bridges to the active session via the 2A sessionStore) and tell the renderer.
  setSessionMode: (wsPath: string, mode: 'chat' | 'workflow', runId?: string) => void
  emitModeChanged: (wsPath: string, mode: 'chat' | 'workflow', runId?: string) => void
}
export type PlanDecision = {
  decision: 'allow' | 'deny' | 'modify'
  value?: string
  // On 'allow': the user's edits from the approval card — run only these stages, scope each
  // per-project stage to these projects, and run only these hooks (by id). Absent → run exactly
  // what the agent proposed. `hooks` absent (old client) → keep all hooks; [] → drop all hooks.
  selection?: { stages: string[]; stageProjects: Record<string, string[]>; hooks?: string[] }
}
export type ProposeResult = { approved: boolean; feedback?: string }

let seq = 0
export function makeProposeRun(deps: ProposeDeps) {
  const pending = new Map<string, { resolve: (d: PlanDecision) => void; wsPath: string; standalone: boolean }>()
  // `standalone`: this propose is UI-initiated (e.g. the approval card's workflow-switch dropdown re-proposes
  // via chat:repropose-workflow), NOT owned by an agent chat turn. Turn cleanup (cancelForWorkspace) must
  // NOT dismiss it — it lives until the user decides (allow/deny). Without this, a switch's fresh card would
  // be created after the triggering turn's preProposes snapshot and get denied when that turn ends (race).
  const fn = (wsPath: string, approach: string, task?: string, select?: { workflowId?: string; stages?: string[]; projects?: string[]; stageProjects?: Record<string, string[]>; standalone?: boolean; providerOverride?: { provider: string; model?: string }; sessionId?: string; brief?: string }): Promise<ProposeResult> => {
    const raw = deps.readWorkspace(wsPath)
    if (!raw) { deps.emitNote(wsPath, '该工作区不存在,无法发起工作流。'); return Promise.resolve({ approved: false }) }
    // Defensive: production readWorkspace (config/store.ts) already normalizes workflows on every
    // read, but callers (tests, older fixtures pre-dating the `workflows` field) may hand us a legacy
    // ws with an absent (not just empty) `workflows` array. ensureWorkspaceWorkflows is pure +
    // idempotent, so re-applying it here — after coercing a missing array to [] — is free.
    const ws = ensureWorkspaceWorkflows({ ...raw, workflows: raw.workflows ?? [] })
    const custom = indexCustomStages(deps.readCustomStages?.() ?? [])
    // 命中命名工作流 → 只跑该条 stages;否则(ad-hoc,主代理自选)→ 所有工作流阶段 union,让 select.stages 裁剪。
    const wf = select?.workflowId ? pickWorkspaceWorkflow(ws, select.workflowId) : null
    const stages = wf
      ? resolveWorkflowStages(wf, deps.readWorkflows(), custom)
      : unionWorkflowStages(ws, deps.readWorkflows(), custom)
    if (stages.length === 0) { deps.emitNote(wsPath, '该工作区无可执行的工作流配置。'); return Promise.resolve({ approved: false }) }
    const filled = { ...ws, stages }
    let opts = workspaceToStartRunOpts(filled, task, wf ? { id: wf.id, name: wf.name } : undefined)
    // #3: remember which chat session owns this run so the renderer scopes the run + its gate cards to
    // that session's tab (and only badges other tabs) instead of stealing whatever tab is in front.
    if (select?.sessionId) opts = { ...opts, sessionId: select.sessionId }
    // P4: 主代理整理的需求简报,随 run 注入每个 stage 子代理 prompt(一份共享)。
    if (select?.brief) opts = { ...opts, brief: select.brief }
    // #1 run-level provider override: the chat turn that proposed this run carries the main agent the
    // user currently has selected. Apply it to EVERY stage (and every per-project develop agent, which
    // resolves provider from developProjects[].provider) so switching the chat agent — e.g. claude→codex
    // when claude runs out of quota — actually runs the workflow on that agent. This never touches
    // workspace.json; it's scoped to this single run. Model is forced alongside provider so a stale
    // claude model can't ride on codex and 400.
    if (select?.providerOverride?.provider) {
      const provider = select.providerOverride.provider
      const model = select.providerOverride.model ?? ''
      opts = {
        ...opts,
        stages: opts.stages.map(s => ({ ...s, provider, model })),
        developProjects: opts.developProjects.map(p => ({ ...p, provider, model })),
      }
    }
    // Selective execution (token-saving): the proposing agent may narrow THIS run. The workspace's full
    // workflow config is untouched; an empty/unknown pick falls back to the full set so a bad selection
    // can never produce a no-op run.
    //  - `stages`        → run only these stages (by key).
    //  - `projects`      → default project subset applied to EVERY per-project stage (by name).
    //  - `stageProjects` → per-stage override, e.g. { design: [all 5], develop: [2] } — lets 分析 cover
    //                      all projects while 开发 touches only some. Overrides `projects` for that stage.
    // developProjects stays the FULL set of provisioned worktrees; the orchestrator restricts each
    // per-project stage to its spec.projects.
    if (select?.stages?.length) {
      const want = new Set(select.stages)
      const picked = opts.stages.filter(s => want.has(s.key))
      if (picked.length) opts = { ...opts, stages: picked }
    }
    const byStage = select?.stageProjects ?? {}
    const globalP = select?.projects?.length ? select.projects : undefined
    if (globalP || Object.keys(byStage).length) {
      opts = { ...opts, stages: opts.stages.map(s => {
        const p = byStage[s.key] ?? globalP
        return p && p.length ? { ...s, projects: p } : s
      }) }
    }
    // 「允许 LLM 自行决策」开:跳过工作流选择门,直接用主代理提议(已按 select 裁剪)的 opts 启动。
    // 只免"要不要弹门选工作流/阶段/hook/项目"这一层;子代理改代码仍受权限盾牌约束(下沉)。
    if (ws.autoDecide) {
      const live = deps.getRun()
      if (live && live.status === 'run') { deps.emitNote(wsPath, '已有运行进行中,稍后再试。'); return Promise.resolve({ approved: false }) }
      deps.startRun(opts)
      const runId = deps.getRun()?.id
      deps.setSessionMode(wsPath, 'workflow', runId)
      deps.emitNote(wsPath, '已开启 LLM 自动决策 · 直接编排为多代理工作流')
      deps.emitModeChanged(wsPath, 'workflow', runId)
      return Promise.resolve({ approved: true })
    }
    const id = `pl-${Date.now()}-${++seq}`
    // Full set of workflows this workspace has configured, so the approval card can offer a switch
    // dropdown (Task 12) — independent of which one (if any) was actually matched for this proposal.
    const workflowOptions = ws.workflows.map(w => ({ id: w.id, name: w.name }))
    deps.emitPlanRequest(wsPath, { id, approach, stages: planStages(opts), hooks: planHooks(opts), allProjects: opts.developProjects.map(p => p.name), task, workflowId: wf?.id, workflowName: wf?.name, workflowOptions })
    return new Promise<ProposeResult>(resolve => {
      pending.set(id, { wsPath, standalone: select?.standalone === true, resolve: (d) => {
        if (d.decision === 'modify') return resolve({ approved: false, feedback: d.value })
        if (d.decision === 'deny') return resolve({ approved: false })
        const live = deps.getRun()
        if (live && live.status === 'run') { deps.emitNote(wsPath, '已有运行进行中,稍后再试。'); return resolve({ approved: false }) }
        // Apply the user's approval-card edits: run only the chosen stages, and scope each per-project
        // stage to the chosen projects (skipping a stage / deselecting irrelevant projects saves tokens).
        let runOpts = opts
        const sel = d.selection
        if (sel) {
          if (sel.stages?.length) {
            const want = new Set(sel.stages)
            const picked = runOpts.stages.filter(s => want.has(s.key))
            if (picked.length) runOpts = { ...runOpts, stages: picked }
          }
          const byStage = sel.stageProjects ?? {}
          if (Object.keys(byStage).length) {
            runOpts = { ...runOpts, stages: runOpts.stages.map(s => {
              const p = byStage[s.key]
              return p && p.length ? { ...s, projects: p } : s
            }) }
          }
          // Hook selection: run only the hooks the user kept ticked. Absent → keep all (old client);
          // empty array → drop every hook this run. Filters both woven plugins and __wf stepPlugins.
          if (sel.hooks) {
            const wantH = new Set(sel.hooks)
            runOpts = { ...runOpts, plugins: (runOpts.plugins ?? []).filter(p => wantH.has(p.id)), stepPlugins: (runOpts.stepPlugins ?? []).filter(p => wantH.has(p.id)) }
          }
        }
        deps.startRun(runOpts)
        // #1: this chat turn was task-shaped (the LLM self-activated forge_propose_plan and the
        // user approved). Promote the triggering session to workflow mode + surface the auto-orchestration.
        const runId = deps.getRun()?.id
        deps.setSessionMode(wsPath, 'workflow', runId)
        deps.emitNote(wsPath, '识别到任务型指令 · 已自动编排为多代理工作流')
        deps.emitModeChanged(wsPath, 'workflow', runId)
        resolve({ approved: true })
      } })
    })
  }
  fn.resolve = (id: string, d: PlanDecision) => { const e = pending.get(id); if (e) { pending.delete(id); e.resolve(d) } }
  fn.has = (id: string) => pending.has(id)
  // A propose blocks the chat turn's MCP tool call awaiting the user's decision. If the turn ends
  // (error / codex 180s tool timeout / cancel) BEFORE a decision, the resolver would leak here forever
  // and the card would linger with no live resolver. Called from runTurn's finally: deny every propose
  // still pending for this workspace (chat turns are serialized per workspace, so any pending propose
  // belongs to the ending turn) and return their ids so the caller can broadcast plan-resolved to clear
  // the card.
  fn.pendingIds = (wsPath: string): string[] =>
    [...pending.entries()].filter(([, e]) => e.wsPath === wsPath).map(([id]) => id)
  fn.cancelForWorkspace = (wsPath: string, exclude?: ReadonlySet<string>): string[] => {
    // Skip excluded (prior turns') AND standalone (UI-initiated, turn-independent) proposes — the latter
    // must survive an unrelated turn ending, or the workflow-switch card would vanish before the user acts.
    const ids = fn.pendingIds(wsPath).filter(id => !exclude?.has(id) && !pending.get(id)?.standalone)
    for (const id of ids) { const e = pending.get(id); if (e) { pending.delete(id); e.resolve({ decision: 'deny' }) } }
    return ids
  }
  return fn
}
