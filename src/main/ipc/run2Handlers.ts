import * as CH from './channels'
import { planFromStages } from '../run/planFromStages'
import { buildLaunchInfo, resolveStartPlan, type StartWorkflowOpts } from '../run/launch'
import type { Run2Manager } from '../run/manager'
import type { StageSpec, DevelopProject } from '../orchestrator/orchestrator'
import type { GateDecision, LaneDecision } from '../run/decisions'
import type { Workspace, Workflow, CustomStage } from '../config/schema'

// Additive P3-A IPC binder: wires the run2:* invoke channels (see channels.ts) to a Run2Manager. Coexists
// with the existing engine* orchestrator handlers registered in handlers.ts's registerIpc — nothing here
// touches those. `onInvoke` is injected (rather than calling ipcMain.handle directly) so this can be unit
// tested without booting Electron; handlers.ts passes `(ch, h) => ipcMain.handle(ch, h)`.
//
// P4-A: readWorkspace/readWorkflows/readCustomStages are additive OPTIONAL deps — only needed to back
// the 2 new launcher channels (run2LaunchInfo/run2StartWorkflow). Kept optional so existing callers/tests
// that construct registerRun2 without a store (e.g. run2Handlers.test.ts) keep compiling/passing unchanged.
export function registerRun2(deps: {
  manager: Run2Manager
  onInvoke: (channel: string, handler: (event: unknown, payload: any) => unknown) => void
  readWorkspace?: (wsPath: string) => Workspace | null
  readWorkflows?: () => Workflow[]
  readCustomStages?: () => CustomStage[]
}) {
  const { manager, onInvoke, readWorkspace, readWorkflows, readCustomStages } = deps
  onInvoke(CH.run2Start, (_e, p: { workspacePath: string; runId: string; stages: StageSpec[]; projects: DevelopProject[] }) =>
    manager.start({ workspacePath: p.workspacePath, runId: p.runId, plan: planFromStages(p.runId, p.stages), projects: p.projects }))
  onInvoke(CH.run2ResolveGate, (_e, p: { workspacePath: string; eventId: string; decision: GateDecision }) => manager.resolveGate(p.workspacePath, p.eventId, p.decision))
  onInvoke(CH.run2ResolveLane, (_e, p: { workspacePath: string; eventId: string; decision: LaneDecision }) => manager.resolveLane(p.workspacePath, p.eventId, p.decision))
  onInvoke(CH.run2AddFeedback, (_e, p: { workspacePath: string; text: string }) => manager.addFeedback(p.workspacePath, p.text))
  onInvoke(CH.run2EditFeedback, (_e, p: { workspacePath: string; id: string; text: string }) => manager.editFeedback(p.workspacePath, p.id, p.text))
  onInvoke(CH.run2RemoveFeedback, (_e, p: { workspacePath: string; id: string }) => manager.removeFeedback(p.workspacePath, p.id))
  onInvoke(CH.run2Abort, (_e, p: { workspacePath: string }) => manager.abort(p.workspacePath))
  // P3-B recovery: lets a renderer that mounts (or reloads) mid-run fetch current state instead of only
  // ever receiving it via the run2Update broadcast. Additive — no existing behavior changes.
  // Falls back to the manager's retained last-run state so a *finished* run's outcomes/status are still
  // visible after the controller is removed from the active map (otherwise the panel would silently
  // revert to the launcher once a run completes) — see Run2Manager.lastStateFor.
  onInvoke(CH.run2GetState, (_e, p: { workspacePath: string }) => manager.get(p.workspacePath)?.state ?? manager.lastStateFor(p.workspacePath) ?? null)

  // P4-A launcher: list a workspace's named workflows + projects (server-resolved, so the renderer never
  // has to know ws.workflows[].stages vs the legacy empty ws.stages).
  onInvoke(CH.run2LaunchInfo, (_e, p: { workspacePath: string }) => {
    if (!readWorkspace) throw new Error('registerRun2: readWorkspace dep missing (required for run2:launch-info)')
    const ws = readWorkspace(p.workspacePath)
    if (!ws) throw new Error(`工作区不存在: ${p.workspacePath}`)
    return buildLaunchInfo(ws)
  })
  // P4-A launcher: resolve the picked workflow's stages server-side into a RunPlan, then start run2 —
  // fixes the P3-B temp button reading ws.stages (permanently [] under the multi-workflow model).
  onInvoke(CH.run2StartWorkflow, (_e, p: StartWorkflowOpts) => {
    if (!readWorkspace || !readWorkflows || !readCustomStages) throw new Error('registerRun2: missing store deps (required for run2:start-workflow)')
    const ws = readWorkspace(p.workspacePath)
    if (!ws) throw new Error(`工作区不存在: ${p.workspacePath}`)
    const { plan, projects, task, permissionMode } = resolveStartPlan(ws, readWorkflows(), readCustomStages(), p)
    return manager.start({ workspacePath: p.workspacePath, runId: p.runId, plan, projects, task, permissionMode })
  })
}
