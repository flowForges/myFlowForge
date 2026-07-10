import type { Workspace, Workflow } from '../config/schema'
import type { StartRunOpts } from '../orchestrator/orchestrator'
import type { RunState } from '@shared/types'
import { workspaceToStartRunOpts } from '../workspace/workspaceRun'
import { resolveStages } from '../workspace/resolveStages'
import { planStages } from '../workspace/planSummary'
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
  emitPlanRequest: (wsPath: string, req: { id: string; approach: string; stages: { name: string; agents: number }[]; task?: string }) => void
  emitNote: (wsPath: string, text: string) => void
  // #1: after an approved chat-triggered run starts, flip the triggering session to workflow mode
  // (setSessionMode bridges to the active session via the 2A sessionStore) and tell the renderer.
  setSessionMode: (wsPath: string, mode: 'chat' | 'workflow', runId?: string) => void
  emitModeChanged: (wsPath: string, mode: 'chat' | 'workflow', runId?: string) => void
}
export type PlanDecision = { decision: 'allow' | 'deny' | 'modify'; value?: string }
export type ProposeResult = { approved: boolean; feedback?: string }

let seq = 0
export function makeProposeRun(deps: ProposeDeps) {
  const pending = new Map<string, { resolve: (d: PlanDecision) => void; wsPath: string }>()
  const fn = (wsPath: string, approach: string, task?: string, select?: { stages?: string[]; projects?: string[]; stageProjects?: Record<string, string[]> }): Promise<ProposeResult> => {
    const ws = deps.readWorkspace(wsPath)
    if (!ws) { deps.emitNote(wsPath, '该工作区不存在,无法发起工作流。'); return Promise.resolve({ approved: false }) }
    const stages = resolveStages(ws, deps.readWorkflows(), indexCustomStages(deps.readCustomStages?.() ?? []))
    if (stages.length === 0) { deps.emitNote(wsPath, '该工作区无可执行的工作流配置。'); return Promise.resolve({ approved: false }) }
    const filled = { ...ws, stages }
    let opts = workspaceToStartRunOpts(filled, task)
    // Selective execution (token-saving): the proposing agent may narrow THIS run. The workspace's full
    // workflow config is untouched (filled is still persisted below); an empty/unknown pick falls back
    // to the full set so a bad selection can never produce a no-op run.
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
    const id = `pl-${Date.now()}-${++seq}`
    deps.emitPlanRequest(wsPath, { id, approach, stages: planStages(opts), task })
    return new Promise<ProposeResult>(resolve => {
      pending.set(id, { wsPath, resolve: (d) => {
        if (d.decision === 'modify') return resolve({ approved: false, feedback: d.value })
        if (d.decision === 'deny') return resolve({ approved: false })
        const live = deps.getRun()
        if (live && live.status === 'run') { deps.emitNote(wsPath, '已有运行进行中,稍后再试。'); return resolve({ approved: false }) }
        if (ws.stages.length === 0) deps.writeWorkspace(filled)
        deps.startRun(opts)
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
    const ids = fn.pendingIds(wsPath).filter(id => !exclude?.has(id))
    for (const id of ids) { const e = pending.get(id); if (e) { pending.delete(id); e.resolve({ decision: 'deny' }) } }
    return ids
  }
  return fn
}
