import * as fs from 'node:fs'
import * as path from 'node:path'
import * as CH from './channels'
import { planFromStages } from '../run/planFromStages'
import { buildLaunchInfo, resolveStartPlan, buildLaunchPlan, buildLaunchProjects, createRunTempBranches, type StartWorkflowOpts, type LaunchStartConfig } from '../run/launch'
import { listRuns, loadRun } from '../run/persist'
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
  // Reused for TWO purposes: (1) createRunTempBranches' rollback-on-create-failure (P4-2, unchanged),
  // and (2) the P4-3 finalize gate's 丢弃本次 action (see run2:launch-start below) — both are exactly
  // "checkout target, force-delete the temp branch", so one injected function covers both call sites.
  discardTempBranch?: (cwd: string, target: string, runId: string) => Promise<void>
  // P4-3: injectable so tests can stub real git out of the finalize gate's 合并并完成 action.
  // Production omits it — RunController falls back to the real tempBranch.ts mergeTempBranch.
  mergeTempBranch?: (cwd: string, target: string, runId: string) => Promise<void>
  // Finding 4 (Important — abort semantics): injectable so tests can stub real git out of the abort
  // path's park-instead-of-discard action. Production omits it — RunController falls back to the
  // real tempBranch.ts parkTempBranch.
  parkTempBranch?: (cwd: string, target: string, runId: string) => Promise<void>
  // Finding 3 (Important — data loss): injectable so tests can stub real git out of
  // createRunTempBranches' clean-tree precondition. Production omits it — createRunTempBranches falls
  // back to the real tempBranch.ts isCleanTree.
  checkClean?: (cwd: string) => Promise<boolean>
}) {
  const { manager, onInvoke, readWorkspace, readWorkflows, readCustomStages, createTempBranch, discardTempBranch, mergeTempBranch, parkTempBranch, checkClean } = deps
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
    // Finding 2 (Important — disk-resume review): a workspace can ALSO have an INTERRUPTED run sitting
    // on disk (no live controller — see Run2Manager.resumable's doc) with its participating project(s)
    // still checked out onto the run's temp branch. Nothing in the checkClean pre-pass below catches
    // this if that project's tree happens to be clean (checked out onto the temp branch IS a clean
    // state) — a new launch-start would then create a SECOND temp branch off the same base while the
    // interrupted run's temp branch/work is still parked there, silently orphaning it. Reject here too,
    // before touching git or the manager, so the user must resolve the interrupted run (继续/丢弃 in the
    // recovery banner) before starting a new one.
    if (manager.resumable(p.workspacePath)) {
      throw new Error('当前工作区有未完成的工作流，请先在恢复提示里选择「继续」或「丢弃」再启动新的')
    }
    const ws = readWorkspace(p.workspacePath)
    if (!ws) throw new Error(`工作区不存在: ${p.workspacePath}`)
    const plan = buildLaunchPlan(p, ws, readWorkflows?.() ?? [], readCustomStages?.() ?? [])
    const projects = buildLaunchProjects(p, ws)
    // P4-2: every participating project gets checked out onto the run's shared temp branch off ITS OWN
    // target branch BEFORE the controller starts running any lane — so all code writes land on
    // `plan.tempBranch`, never directly on the target. Throws (aborting the start, run never launches)
    // on any project's checkout failure — see createRunTempBranches for the rollback/error contract.
    await createRunTempBranches(ws, projects, plan.runId, createTempBranch, discardTempBranch, checkClean)
    // P4-3: same per-project target-branch lookup createRunTempBranches just used to check each
    // project out — threaded through to the controller so its run-completion finalize gate knows
    // what to merge/discard back onto (see RunControllerDeps.projectTargets doc in controller.ts).
    // createRunTempBranches already guarantees every entry in `projects` has a `ws.projects[].branch`
    // (it throws above otherwise), so this lookup is total — never silently drops a project.
    const projectTargets: Record<string, string> = {}
    for (const project of projects) {
      const target = ws.projects.find((wp) => wp.name === project.name)?.branch
      if (target) projectTargets[project.name] = target
    }
    return manager.start({ workspacePath: p.workspacePath, runId: plan.runId, plan, projects, sessionId: p.sessionId, projectTargets, mergeTempBranch, discardTempBranch, parkTempBranch })
  })

  // P-C2/T3 (disk-resume): checked by the renderer when a workspace opens — is there an interrupted
  // (non-terminal) run2 state saved on disk with nothing currently driving it? See
  // Run2Manager.resumable()'s doc for the exact gating (null for: none saved, already terminal, or a
  // controller already live for this workspace).
  onInvoke(CH.run2Resumable, (_e, p: { workspacePath: string }) => manager.resumable(p.workspacePath))

  // P-C2/T3: 继续 — rebuilds the same kind of deps run2:launch-start builds (workspace's projects +
  // their target branches + the injected git ops) and hands them to Run2Manager.resumeFromDisk, which
  // rebuilds the controller from the on-disk snapshot and resumes it from the first non-done stage.
  // Deliberately does NOT call createRunTempBranches — the resumed run reuses `plan.tempBranch`
  // already stamped into the on-disk RunPlan (see resumeFromDisk's doc), never creates a new one.
  // sessionId/task are recovered from the saved state itself inside resumeFromDisk (Finding 2) — this
  // handler doesn't need to know either.
  //
  // Project-SUBSET (P-C2/T3 review Finding 1, CRITICAL — fixed): the `projects`/`projectTargets` built
  // below from `buildLaunchInfo` are ONLY a legacy fallback now — Run2Manager.resumeFromDisk prefers
  // the on-disk snapshot's OWN persisted `projects` (the exact gate-selected subset the original run
  // was launched with, saved by saveControllerState — see persist.ts's SavedControllerState.projects
  // doc) whenever it's present, and only falls back to this handler's "every project on the
  // workspace" reconstruction for a saved state written before that field existed. Getting this wrong
  // previously meant a still-pending per-project stage would resume against a project the original
  // run never selected (never checked out onto the run's temp branch), and a finalize-gate
  // merge/discard would then run real git directly against that project's REAL branch.
  onInvoke(CH.run2ResumeFromDisk, (_e, p: { workspacePath: string }) => {
    if (!readWorkspace) throw new Error('registerRun2: readWorkspace dep missing (required for run2:resume-from-disk)')
    const ws = readWorkspace(p.workspacePath)
    if (!ws) throw new Error(`工作区不存在: ${p.workspacePath}`)
    const info = buildLaunchInfo(ws, readWorkflows?.() ?? [], readCustomStages?.() ?? [])
    const projects: DevelopProject[] = info.projects.map((pr) => ({ name: pr.name, cwd: pr.cwd, provider: pr.provider, model: pr.model }))
    const projectTargets: Record<string, string> = {}
    for (const project of projects) {
      const target = ws.projects.find((wp) => wp.name === project.name)?.branch
      if (target) projectTargets[project.name] = target
    }
    return manager.resumeFromDisk(p.workspacePath, { projects, projectTargets, mergeTempBranch, discardTempBranch, parkTempBranch })
  })

  // P-C2/T3: 丢弃 — clears the saved state so resumable() stops offering this interrupted run again.
  onInvoke(CH.run2DiscardResumable, (_e, p: { workspacePath: string }) => manager.discardResumable(p.workspacePath))

  // Spec §12.7 (run-history): list every past/interrupted run for this workspace (newest first) —
  // pure disk read via persist.ts, no manager/live-controller involvement (mirrors
  // discardResumableRun's disk-only nature, unlike resumable()/resumeFromDisk() which gate on live
  // controller state).
  onInvoke(CH.run2ListRuns, (_e, p: { workspacePath: string }) => listRuns(p.workspacePath))
  // Spec §12.7: load one historical run's full saved state, for the renderer's read-only replay
  // panel (RunHistoryPanel → runHistoryAdapter → RunExecPanel's staticState/readOnly mode).
  onInvoke(CH.run2LoadRun, (_e, p: { workspacePath: string; runId: string }) => loadRun(p.workspacePath, p.runId))

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
