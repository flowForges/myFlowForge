import type { Workspace, Workflow } from '../config/schema'
import type { StartRunOpts } from '../orchestrator/orchestrator'
import type { RunState } from '@shared/types'
import { workspaceToStartRunOpts } from '../workspace/workspaceRun'
import { resolveStages } from '../workspace/resolveStages'
import { planStages } from '../workspace/planSummary'

export interface ProposeDeps {
  getRun: () => RunState | null
  readWorkspace: (p: string) => Workspace | null
  readWorkflows: () => Workflow[]
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
  const pending = new Map<string, (d: PlanDecision) => void>()
  const fn = (wsPath: string, approach: string, task?: string): Promise<ProposeResult> => {
    const ws = deps.readWorkspace(wsPath)
    if (!ws) { deps.emitNote(wsPath, '该工作区不存在,无法发起工作流。'); return Promise.resolve({ approved: false }) }
    const stages = resolveStages(ws, deps.readWorkflows())
    if (stages.length === 0) { deps.emitNote(wsPath, '该工作区无可执行的工作流配置。'); return Promise.resolve({ approved: false }) }
    const filled = { ...ws, stages }
    const opts = workspaceToStartRunOpts(filled, task)
    const id = `pl-${Date.now()}-${++seq}`
    deps.emitPlanRequest(wsPath, { id, approach, stages: planStages(opts), task })
    return new Promise<ProposeResult>(resolve => {
      pending.set(id, (d) => {
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
      })
    })
  }
  fn.resolve = (id: string, d: PlanDecision) => { const r = pending.get(id); if (r) { pending.delete(id); r(d) } }
  fn.has = (id: string) => pending.has(id)
  return fn
}
