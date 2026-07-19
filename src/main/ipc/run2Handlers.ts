import * as fs from 'node:fs'
import * as path from 'node:path'
import * as CH from './channels'
import { planFromStages } from '../run/planFromStages'
import { buildLaunchInfo, resolveStartPlan, buildLaunchPlan, buildLaunchProjects, createRunTempBranches, type StartWorkflowOpts, type LaunchStartConfig } from '../run/launch'
import type { Run2Manager } from '../run/manager'
import type { StageSpec, DevelopProject } from '../orchestrator/orchestrator'
import type { GateDecision, LaneDecision } from '../run/decisions'
import type { Workspace, Workflow, CustomStage } from '../config/schema'

// P5-UI Task 2: cap read size so the file viewer never loads a huge file into the renderer.
const READ_FILE_MAX_BYTES = 512 * 1024

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
  // P4-2: injectable so tests can stub real git out of run2:launch-start (production omits both —
  // createRunTempBranches falls back to the real tempBranch.ts functions on its own).
  createTempBranch?: (cwd: string, base: string, runId: string) => Promise<string>
  discardTempBranch?: (cwd: string, target: string, runId: string) => Promise<void>
}) {
  const { manager, onInvoke, readWorkspace, readWorkflows, readCustomStages, createTempBranch, discardTempBranch } = deps
  onInvoke(CH.run2Start, (_e, p: { workspacePath: string; runId: string; stages: StageSpec[]; projects: DevelopProject[] }) =>
    manager.start({ workspacePath: p.workspacePath, runId: p.runId, plan: planFromStages(p.runId, p.stages), projects: p.projects }))
  onInvoke(CH.run2ResolveGate, (_e, p: { workspacePath: string; eventId: string; decision: GateDecision }) => manager.resolveGate(p.workspacePath, p.eventId, p.decision))
  onInvoke(CH.run2ResolveLane, (_e, p: { workspacePath: string; eventId: string; decision: LaneDecision }) => manager.resolveLane(p.workspacePath, p.eventId, p.decision))
  onInvoke(CH.run2AddFeedback, (_e, p: { workspacePath: string; text: string }) => manager.addFeedback(p.workspacePath, p.text))
  onInvoke(CH.run2EditFeedback, (_e, p: { workspacePath: string; id: string; text: string }) => manager.editFeedback(p.workspacePath, p.id, p.text))
  onInvoke(CH.run2RemoveFeedback, (_e, p: { workspacePath: string; id: string }) => manager.removeFeedback(p.workspacePath, p.id))
  onInvoke(CH.run2Abort, (_e, p: { workspacePath: string }) => manager.abort(p.workspacePath))
  onInvoke(CH.run2Pause, (_e, p: { workspacePath: string }) => manager.pause(p.workspacePath))
  onInvoke(CH.run2Resume, (_e, p: { workspacePath: string }) => manager.resume(p.workspacePath))
  onInvoke(CH.run2JumpBack, (_e, p: { workspacePath: string; targetKey: string }) => manager.requestJumpBack(p.workspacePath, p.targetKey))
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
    // readWorkflows/readCustomStages are optional deps (see comment on the class field above) — when
    // present (real app wiring), they let buildLaunchInfo resolve a workflow's stages via the global
    // template fallback (see launch.ts); when absent (older/lighter test wiring), each workflow's
    // stages just resolve from its own stashed WsStage[] (empty → []), same as before this fell back.
    return buildLaunchInfo(ws, readWorkflows?.() ?? [], readCustomStages?.() ?? [])
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

  // P1-4: in-chat launch gate → run2. Unlike run2StartWorkflow (renderer picks workflowId +
  // projectNames only, provider/model always comes from the stage default), this channel carries the
  // gate's own per-project provider/model + supplement/seed — buildLaunchPlan/buildLaunchProjects
  // (launch.ts) resolve those into the RunPlan + DevelopProject[] the engine actually runs.
  //
  // readWorkflows/readCustomStages are passed through (same optional-dep pattern as run2LaunchInfo above)
  // so buildLaunchPlan can resolve the global-template fallback for a workflow whose stashed
  // ws.workflows[].stages is empty — otherwise the picker (buildLaunchInfo, which DOES resolve this
  // fallback) would preview stages that then throw "没有可执行阶段" on confirm.
  onInvoke(CH.run2LaunchStart, async (_e, p: LaunchStartConfig) => {
    if (!readWorkspace) throw new Error('registerRun2: readWorkspace dep missing (required for run2:launch-start)')
    // P4-2 review fix: Run2Manager.start() ENQUEUES (doesn't throw) a second run for a workspace that
    // already has one active — but createRunTempBranches below runs REAL `git checkout -b` on each
    // project's cwd. If two launch-gate cards both confirm for the same workspace while run #1 is live,
    // an unconditional checkout here would swap HEAD out from under run #1's lanes mid-flight (real
    // working-tree corruption). Design spec §8: a workspace runs at most one workflow at a time; a
    // second attempt is rejected with a message, not queued into a git race. So: reject BEFORE touching
    // git or the manager when this workspace already has a live run — no branch is ever created for it.
    if (manager.isActive(p.workspacePath)) {
      throw new Error('当前工作区有工作流在执行，请等它结束后再启动')
    }
    const ws = readWorkspace(p.workspacePath)
    if (!ws) throw new Error(`工作区不存在: ${p.workspacePath}`)
    const plan = buildLaunchPlan(p, ws, readWorkflows?.() ?? [], readCustomStages?.() ?? [])
    const projects = buildLaunchProjects(p, ws)
    // P4-2: every participating project gets checked out onto the run's shared temp branch off ITS OWN
    // target branch BEFORE the controller starts running any lane — so all code writes land on
    // `plan.tempBranch`, never directly on the target. Throws (aborting the start, run never launches)
    // on any project's checkout failure — see createRunTempBranches for the rollback/error contract.
    await createRunTempBranches(ws, projects, plan.runId, createTempBranch, discardTempBranch)
    return manager.start({ workspacePath: p.workspacePath, runId: plan.runId, plan, projects })
  })

  // P5-UI Task 2: on-demand read of a changed file's content, for the RunPanel file viewer.
  // `path` is normally RELATIVE to the work order's project cwd (WorkOrder.order.cwd) — filesChanged
  // entries are stored relative — so the caller passes `cwd` and we resolve against it. `cwd` is
  // optional so an already-absolute path also works. Read-only; never writes. No strict path
  // whitelist (per brief) — just traversal-escape rejection + size cap, since this only ever reads
  // paths already reported in a work order's own `filesChanged`, all under a project the user opened.
  onInvoke(CH.run2ReadFile, (_e, p: { path: string; cwd?: string }) => {
    const abs = p.cwd ? path.resolve(p.cwd, p.path) : path.resolve(p.path)
    if (p.cwd) {
      const cwdAbs = path.resolve(p.cwd)
      if (abs !== cwdAbs && !abs.startsWith(cwdAbs + path.sep)) return { error: '路径越界' }
    }
    try {
      const stat = fs.statSync(abs)
      if (!stat.isFile()) return { error: `不是文件: ${abs}` }
      if (stat.size > READ_FILE_MAX_BYTES) {
        const fd = fs.openSync(abs, 'r')
        try {
          const buf = Buffer.alloc(READ_FILE_MAX_BYTES)
          fs.readSync(fd, buf, 0, READ_FILE_MAX_BYTES, 0)
          return { content: buf.toString('utf8'), truncated: true }
        } finally { fs.closeSync(fd) }
      }
      return { content: fs.readFileSync(abs, 'utf8') }
    } catch (err) {
      return { error: String(err) }
    }
  })
}
