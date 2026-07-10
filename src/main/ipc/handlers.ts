import { ipcMain, dialog, app, shell } from 'electron'
import { CH } from './channels'
import { EventBus } from '../orchestrator/eventBus'
import { Orchestrator, gateApprovedKey } from '../orchestrator/orchestrator'
import { readSettings, writeSettings, readProjects, writeProjects, readWorkflows, writeWorkflows, readHookLibrary, writeHookLibrary, upsertProject, setProjectDefaultBranch, registerWorkspace, unregisterWorkspace, readWorkspace, writeWorkspace, readAgentsConfig, writeAgentsConfig, readWorkspaceRegistry, setWorkspaceLifecycle, setStageModel } from '../config/store'
import { expandTilde } from '../config/paths'
import { buildWorkflow } from '../config/buildWorkflow'
import { cachedDetectProviders, invalidateDetectCache } from '../agents/detectCache'
import { rebuildProviderRegistry } from '../agents/registry'
import { refreshProviderModels, setProviderModels } from '../agents/refreshModels'
import { buildAgentEnv } from '../agents/env'
import { statSync, mkdirSync, writeFileSync, existsSync, readFileSync, createWriteStream } from 'node:fs'
import { basename, join } from 'node:path'
import { editWorkspace } from '../workspace/workspaceService'
import { runWorkspaceSetup, SetupCancelledError } from '../workspace/workspaceSetup'
import { workspaceToStartRunOpts } from '../workspace/workspaceRun'
import { resolveStages } from '../workspace/resolveStages'
import { isArchivedWorkspace } from '../workspace/archivedGuard'
import { listWorkspaces } from '../workspace/workspaceList'
import { readHomeStats } from '../workspace/homeStats'
import { sendTurn, history } from '../chat/chatService'
import { ChatQueue } from '../chat/chatQueue'
import { appendMessage } from '../chat/chatStore'
import { readSessions, newSession, switchSession, closeSession, renameSession, setSessionMode, setSessionPermission, continueFrom } from '../chat/sessionStore'
import { agentSessionsForId } from '../chat/agentSessions'
import type { CreateWorkspaceOpts, ResolvePayload, ChatSendPayload, ChatEvent, Attachment, ChangesEvent, ChatMessage, EngineEvent } from '@shared/types'
import type { AgentProvider } from '../agents/types'
import type { StartRunOpts } from '../orchestrator/orchestrator'
import type { Settings, CustomAgent } from '../config/schema'
import { watch as chokidarWatch } from 'chokidar'
import { readChanges, readChangesMulti, readBranch } from '../git/changes'
import { perfSpan } from '../perf/perfSpans'
import { execFile } from 'node:child_process'
import { detectOpeners, resolveOpener, withoutOpener, openersCacheFile } from '../openers/detect'
import { readMacAppIcon } from '../openers/appIcon'
import { buildOpenCommand } from '../openers/buildOpenCommand'
import { writeJsonAtomic } from '../util/atomicWrite'
import { providerCommands } from '../commands/providerCommands'
import type { DetectedOpener } from '../../shared/openers'
import { readDiff, readFile } from '../git/diff'
import { readTree } from '../fs/fileTree'
import { searchContent } from '../fs/contentSearch'
import { WorktreeWatcher } from '../watcher/worktreeWatcher'
import { NarratorService } from '../narrator/narratorService'
import { readLastRun, RunStore } from '../orchestrator/runStore'
import { planResume } from '../orchestrator/resumeRun'
import { archiveWorkspaceLifecycle, restoreWorkspaceLifecycle } from '../workspace/archiveOps'
import { deleteWorkspace, removeWorkspaceFromList, discardPartialCreation } from '../workspace/deleteOps'
import { summarizeWorkspace } from '../workspace/summarizeWorkspace'
import { makeProposeRun } from '../chat/proposeRun'
import { isWorkflowIntent, isResumeIntent } from '../chat/workflowIntent'
import { makeProposeGuard } from '../chat/proposeGuard'
import { readPetPack, readPetImage } from '../pet/petPack'
import { writePetImageFromDataUrl } from '../pet/petImageStore'
import { createUpdateChecker } from '../update/updateChecker'
import { fetchLatestRelease } from '../update/githubSource'
import { pickInstaller } from '../update/installer'
import { makeProxyFetch } from '../update/proxyFetch'
import { writeFile, stat as fsStat, rename as fsRename, unlink as fsUnlink } from 'node:fs/promises'
import { startBridge } from '../mcp/forgeBridge'
import { ensureWorkspaceSkill } from '../skills/installSkill'
import { scanWorkspaceContext } from '../agents/contextMeta'
import { scanGlobalContext } from '../agents/globalContext'
import { readInstalledSkills } from '../skills/installedSkills'
import { getAppLog, clearAppLog, formatAppLog } from '../log/appLog'
import { resolveAppIconOptions } from '../appIcon'
import { installPlugin, uninstallPlugin, setPluginEnabled } from '../plugins/pluginStore'
import { listCatalog, installOfficial } from '../plugins/officialCatalog'
import { getPluginScheduler } from '../plugins/pluginSchedulerRef'
import { scanAll, readSession } from '../sessionImport/sources/index'
import { sessionImportCoverage } from '../sessionImport/coverage'
import { groupByCwd } from '../sessionImport/group'
import { readIndex, upsertSessions } from '../sessionImport/importStore'
import { importWorkspace } from '../sessionImport/importWorkspace'
import { probeGitRepo } from '../sessionImport/gitProbe'
import { collectGitCandidates } from '../sessionImport/importResult'
import { readScanCache, writeScanCache } from '../sessionImport/scanCache'
import type { DiscoveredSession } from '@shared/types'

export function registerIpc(broadcast: (channel: string, payload: unknown) => void, providers: Record<string, AgentProvider>, onSettings?: (s: Settings) => void, onEngineEvent?: (e: EngineEvent) => void) {
  const bus = new EventBus()
  bus.subscribe(e => broadcast(CH.engineEvent, e))
  // External sink (main process wires OS notifications here — it owns the window for focus/routing).
  if (onEngineEvent) bus.subscribe(onEngineEvent)
  const narrator = new NarratorService({
    providers,
    env: () => buildAgentEnv({ proxy: readSettings().termProxy }),
    emit: (e) => broadcast(CH.chatEvent, e),
    proxy: () => readSettings().termProxy
  })
  bus.subscribe(e => narrator.onEngineEvent(e))

  // Keep workspace.json status truthful: when a run reaches terminal status,
  // write it back once so reloads reflect reality. (Home only *shows* a badge while
  // a run is live — see HomeView — so a persisted ok/err is data, not a visible 失败.)
  const statusWritten = new Set<string>()
  bus.subscribe(e => {
    if (e.type !== 'run:update') return
    const r = e.run
    if (r.status !== 'ok' && r.status !== 'err') return
    if (statusWritten.has(r.id)) return
    statusWritten.add(r.id)
    const ws = readWorkspace(r.workspacePath)
    if (ws && ws.status !== r.status) writeWorkspace({ ...ws, status: r.status })
    // Return the triggering session to chat mode now the run is over (mirrors engineCancel). Without
    // this, a session that ran a workflow to completion stays mode:'workflow' forever — showing a
    // persistent "running-like" dot in the sidebar long after the run finished. Match by runId so the
    // right session is reset even if the user has since switched the active session.
    const owner = readSessions(r.workspacePath).sessions.find(s => s.runId === r.id && s.mode === 'workflow')
    if (owner) {
      setSessionMode(r.workspacePath, owner.id, 'chat')
      broadcast(CH.chatEvent, { workspacePath: r.workspacePath, sessionId: owner.id, type: 'mode-changed', mode: 'chat' })
    }
  })

  // Startup heal: runs live only in the (in-memory) orchestrator, so on a fresh launch nothing is
  // running — any session still stuck in mode:'workflow' (from a completed run before the reset fix, or
  // an app crash mid-run) is stale. Reset them to chat so their sidebar dot doesn't imply a live agent.
  for (const w of readWorkspaceRegistry()) {
    for (const s of readSessions(w.path).sessions) {
      if (s.mode === 'workflow') setSessionMode(w.path, s.id, 'chat')
    }
  }

  const mcpEntry = join(__dirname, 'forgeMcp.js')
  const orch = new Orchestrator({ bus, providers, proxy: () => readSettings().termProxy, mcpEntry })
  // AbortController for the in-flight workspace creation (one at a time), so 取消 can kill its git pulls.
  let setupAbort: AbortController | null = null

  const UPDATE_REPO = 'xzghua/myFlowForge'
  const updateChecker = createUpdateChecker({
    repo: UPDATE_REPO,
    currentVersion: () => app.getVersion(),
    fetchLatest: (r) => fetchLatestRelease(r, { fetch: makeProxyFetch(readSettings().termProxy) as (url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<any> }>, arch: process.arch }),
    emit: broadcast,
    setTimeout: (fn, ms) => { setTimeout(fn, ms) },
    setInterval: (fn, ms) => { setInterval(fn, ms) },
  })
  updateChecker.start()

  ipcMain.handle(CH.updateGet, () => ({ currentVersion: app.getVersion(), info: updateChecker.current() }))
  ipcMain.handle(CH.updateCheck, () => { void updateChecker.check(true) })
  ipcMain.handle(CH.updateStart, async () => {
    const info = updateChecker.current()
    if (!info) return
    const installer = pickInstaller({
      fetch: (url, init) => makeProxyFetch(readSettings().termProxy)(url, init as any) as any,
      openPath: shell.openPath,
      showItemInFolder: shell.showItemInFolder,
      join,
      tmpDir: app.getPath('temp'),
      // Stream to a .part file (no 340MB in-memory buffer) + resume from a partial download.
      partSize: async (p) => { try { return (await fsStat(p)).size } catch { return 0 } },
      openWriter: (p, append) => {
        const s = createWriteStream(p, { flags: append ? 'a' : 'w' })
        return {
          write: (chunk) => new Promise<void>((res, rej) => s.write(chunk, (err) => err ? rej(err) : res())),
          close: () => new Promise<void>((res) => s.end(() => res())),
        }
      },
      finalize: (from, to) => fsRename(from, to),
      discard: (p) => fsUnlink(p).catch(() => {}),
    })
    try {
      await installer.run(info, (p) => broadcast(CH.updateProgress, p))
      broadcast(CH.updateDone, {})
    } catch (e) {
      broadcast(CH.updateError, { message: e instanceof Error ? e.message : String(e) })
    }
  })

  ipcMain.handle(CH.configGetSettings, () => readSettings())
  ipcMain.handle(CH.configSetSettings, (_e, settings) => {
    writeSettings(settings)
    const s = readSettings()
    broadcast(CH.settingsChanged, s)
    onSettings?.(s)
    return s
  })
  ipcMain.handle(CH.appIconOptions, () => resolveAppIconOptions({
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
  }))
  ipcMain.handle(CH.configListProjects, () => readProjects().projects)
  ipcMain.handle(CH.configAddProject, (_e, input: { repoUrl: string; branch: string }) => upsertProject(input))
  ipcMain.handle(CH.configDeleteProject, (_e, id: string) => {
    writeProjects({ projects: readProjects().projects.filter(p => p.id !== id) })
    return readProjects().projects
  })
  ipcMain.handle(CH.configUpdateProjectBranch, (_e, input: { id: string; branch: string }) => setProjectDefaultBranch(input.id, input.branch))
  ipcMain.handle(CH.configListWorkflows, () => readWorkflows().workflows)
  ipcMain.handle(CH.configAddWorkflow, (_e, input: { name: string; stages: string[] }) => {
    const list = readWorkflows().workflows
    const wf = buildWorkflow(input.name, input.stages, list.map(w => w.id))
    writeWorkflows({ workflows: [...list, wf] })
    return readWorkflows().workflows
  })
  ipcMain.handle(CH.configDeleteWorkflow, (_e, id: string) => {
    writeWorkflows({ workflows: readWorkflows().workflows.filter(w => w.id !== id) })
    return readWorkflows().workflows
  })
  ipcMain.handle(CH.configUpdateWorkflow, (_e, input: { id: string; plugins?: import('../config/schema').Plugin[]; stagePrompts?: Record<string, string> }) => {
    const list = readWorkflows().workflows
    writeWorkflows({ workflows: list.map(w => w.id === input.id ? {
      ...w,
      ...(input.plugins !== undefined ? { plugins: input.plugins } : {}),
      ...(input.stagePrompts !== undefined ? { stagePrompts: input.stagePrompts } : {}),
    } : w) })
    return readWorkflows().workflows
  })
  // --- Reusable hook library (slot-agnostic; snapshot-copied into workspaces at create time) ---
  ipcMain.handle(CH.hookLibraryList, () => readHookLibrary().hooks)
  ipcMain.handle(CH.hookLibrarySave, (_e, hook: import('../config/schema').LibraryHook) => {
    const list = readHookLibrary().hooks
    const next = list.some(h => h.id === hook.id) ? list.map(h => h.id === hook.id ? hook : h) : [...list, hook]
    writeHookLibrary({ hooks: next })
    return readHookLibrary().hooks
  })
  ipcMain.handle(CH.hookLibraryDelete, (_e, id: string) => {
    writeHookLibrary({ hooks: readHookLibrary().hooks.filter(h => h.id !== id) })
    return readHookLibrary().hooks
  })
  ipcMain.handle(CH.hookLibrarySetAll, (_e, hooks: import('../config/schema').LibraryHook[]) => {
    writeHookLibrary({ hooks })
    return readHookLibrary().hooks
  })
  // Cached: concurrent callers share one probe, results live 60s. `force` (重新检测) re-probes AND
  // honors the result (trustPersisted:false) so it can clear a genuinely-gone CLI; a normal detect keeps
  // last-known-good agents sticky so a slow cold-start probe never makes them vanish.
  ipcMain.handle(CH.agentsDetect, (_e, opts?: { force?: boolean }) =>
    cachedDetectProviders(providers, buildAgentEnv({ proxy: readSettings().termProxy }), { force: opts?.force === true, trustPersisted: opts?.force !== true }))
  // Registry just changed (bin override / custom agent add-remove) — bypass the cache but stay sticky
  // (trustPersisted) so a transient probe failure during the rebuild doesn't wipe known-good agents.
  const redetect = () => cachedDetectProviders(providers, buildAgentEnv({ proxy: readSettings().termProxy }), { force: true, trustPersisted: true })
  ipcMain.handle(CH.agentsGetConfig, () => readAgentsConfig())
  ipcMain.handle(CH.agentsSetBin, (_e, a: { id: string; bin: string }) => {
    const cfg = readAgentsConfig()
    const existing = cfg.providers.find(p => p.id === a.id)
    const providersCfg = [
      ...cfg.providers.filter(p => p.id !== a.id),
      { id: a.id, binOverride: a.bin.trim(), env: existing?.env ?? {}, modelsCache: existing?.modelsCache ?? [], modelsFetchedAt: existing?.modelsFetchedAt ?? 0 },
    ]
    writeAgentsConfig({ ...cfg, providers: providersCfg })
    rebuildProviderRegistry(providers)   // mutate in place so orchestrator/handlers see new bins
    return redetect()
  })
  ipcMain.handle(CH.agentsAddCustom, (_e, c: CustomAgent) => {
    const cfg = readAgentsConfig()
    writeAgentsConfig({ ...cfg, custom: [...cfg.custom.filter(x => x.id !== c.id), c] })
    rebuildProviderRegistry(providers)
    return redetect()
  })
  ipcMain.handle(CH.agentsRemoveCustom, (_e, id: string) => {
    const cfg = readAgentsConfig()
    writeAgentsConfig({ ...cfg, custom: cfg.custom.filter(x => x.id !== id) })
    rebuildProviderRegistry(providers)
    return redetect()
  })
  ipcMain.handle(CH.agentsRefreshModels, async (_e, providerId: string) => {
    const r = await refreshProviderModels(providerId, providers, buildAgentEnv({ proxy: readSettings().termProxy }))
    invalidateDetectCache()   // models cache changed on disk — cached ProviderInfo[] is stale
    return r
  })
  ipcMain.handle(CH.agentsSetModels, (_e, a: { id: string; models: { id: string; label: string; description?: string }[] }) => {
    const r = setProviderModels(a.id, a.models)
    invalidateDetectCache()   // ditto: edited model list must show up on the next detect
    return r
  })
  ipcMain.handle(CH.contextScan, (_e, workspacePath?: string) => {
    if (workspacePath && existsSync(workspacePath)) return scanWorkspaceContext(workspacePath, true)
    const live = orch.getRun()
    if (live?.workspacePath && existsSync(live.workspacePath)) return scanWorkspaceContext(live.workspacePath, true)
    return { skills: [], rules: [], mcps: [{ name: 'forge', path: 'mcp://forge', reason: 'Forge workflow tools', state: 'ok' }] }
  })
  ipcMain.handle(CH.contextScanGlobal, () => scanGlobalContext())
  ipcMain.handle(CH.skillsList, () => readInstalledSkills())
  ipcMain.handle(CH.commandsList, (_e, providerId: string, wsPath?: string) => providerCommands(providerId, wsPath))
  ipcMain.handle(CH.workspaceCreate, async (_e, opts: CreateWorkspaceOpts) => {
    const knownProjects = readProjects().projects
    const proxy = readSettings().termProxy
    // One creation at a time — hold its AbortController so CH.workspaceCancelSetup can kill the in-flight
    // git clone/fetch. Cleared in finally so a later create isn't cancelled by a stale controller.
    setupAbort = new AbortController()
    // Always route through the observable setup path so the create shows live pull progress. With no
    // step plugins runWorkspaceSetup just provisions + emits provision events — same result as the old
    // synchronous createWorkspace, but the UI is no longer silent during the (slow) git pulls.
    try {
      return await runWorkspaceSetup({
        opts, knownProjects, proxy, providers, signal: setupAbort.signal,
        emit: (e) => broadcast(CH.workspaceSetup, e),
      })
    } catch (e) {
      // On cancel OR failure, drop the sidebar record (registered early in runWorkspaceSetup) but KEEP
      // the on-disk .forge/workspace.json + partial worktrees, so re-picking the folder can restore the
      // config and continue. Re-throw so the renderer surfaces cancelled vs. error.
      unregisterWorkspace(expandTilde(opts.path))
      if (e instanceof SetupCancelledError) { const err = new Error('SETUP_CANCELLED'); err.name = 'SetupCancelledError'; throw err }
      throw e
    } finally {
      setupAbort = null
    }
  })
  ipcMain.handle(CH.workspaceCancelSetup, () => { setupAbort?.abort() })
  ipcMain.handle(CH.workspaceDiscardPartial, (_e, path: string) => discardPartialCreation(expandTilde(path)))
  ipcMain.handle(CH.workspaceGet, (_e, path: string) => readWorkspace(path))
  ipcMain.handle(CH.workspaceSetStageModel, (_e, a: { path: string; stageKey: string; provider: string; model: string }) => {
    setStageModel(a.path, a.stageKey, a.provider, a.model)
  })
  ipcMain.handle(CH.workspaceRun, (_e, path: string) => {
    if (isArchivedWorkspace(path)) throw new Error('工作区已归档，恢复后才能继续。')
    const ws = readWorkspace(path)
    if (!ws) return
    const live = orch.getRun()
    if (live && live.status === 'run') return
    const stages = resolveStages(ws, readWorkflows().workflows)
    if (stages.length === 0) return
    const filled = { ...ws, stages }
    if (ws.stages.length === 0) writeWorkspace(filled)   // backfill pre-SP-A workspaces permanently
    return orch.startRun(workspaceToStartRunOpts(filled))
  })
  // Quick alias rename — just the display name (registry + workspace.json), no re-provisioning.
  ipcMain.handle(CH.workspaceRename, (_e, a: { path: string; name: string }) => {
    const name = a.name.trim()
    if (!name) return
    const path = expandTilde(a.path)
    registerWorkspace(name, path)
    const ws = readWorkspace(path)
    if (ws) writeWorkspace({ ...ws, name })
    broadcast(CH.workspacesChanged, {})
  })
  ipcMain.handle(CH.workspaceEdit, async (_e, a: { path: string; opts: CreateWorkspaceOpts; runProjHooks?: boolean }) => {
    if (isArchivedWorkspace(a.path)) throw new Error('工作区已归档，恢复后才能继续。')
    const result = await editWorkspace({
      path: a.path, opts: a.opts, knownProjects: readProjects().projects, proxy: readSettings().termProxy,
      emit: (ev) => broadcast(CH.workspaceSetup, ev),
      runProjHooks: a.runProjHooks, providers,
    })
    broadcast(CH.workspacesChanged, {})
    return result
  })
  ipcMain.handle(CH.engineStartRun, (_e, opts: StartRunOpts) => {
    if (isArchivedWorkspace(opts.workspacePath)) throw new Error('工作区已归档，恢复后才能继续。')
    // The seeding task (the user's first chat message in the workspace) is surfaced as a chat
    // user message so it appears in the chat stream alongside the agents' replies.
    if (typeof opts.task === 'string' && opts.task.trim()) {
      const sid = readSessions(opts.workspacePath).activeSessionId
      const msg: ChatMessage = { id: `u-task-${Date.now()}`, who: 'user', text: opts.task, ts: new Date().toISOString().slice(11, 19) }
      appendMessage(opts.workspacePath, sid, msg)
      broadcast(CH.chatEvent, { workspacePath: opts.workspacePath, sessionId: sid, type: 'user', message: msg })
    }
    return orch.startRun(opts)
  })
  ipcMain.handle(CH.engineResolve, (_e, payload: ResolvePayload) => orch.resolve(payload))
  ipcMain.handle(CH.engineCancel, () => {
    const live = orch.getRun()
    orch.cancel()
    // After cancel the run is dead — return the triggering session to chat mode so the user isn't
    // stuck in workflow mode and can freely continue (via 继续执行) or start a new turn.
    if (live) {
      const sid = readSessions(live.workspacePath).activeSessionId
      setSessionMode(live.workspacePath, sid, 'chat')
      broadcast(CH.chatEvent, { workspacePath: live.workspacePath, sessionId: sid, type: 'mode-changed', mode: 'chat' })
    }
  })
  ipcMain.handle(CH.engineLastRun, (_e, wsPath: string) => {
    const live = orch.getRun()
    return live && live.workspacePath === wsPath ? live : readLastRun(wsPath)
  })

  const chatEmit = (e: ChatEvent) => broadcast(CH.chatEvent, e)
  const chatConfirms = new Map<string, (decision: 'allow' | 'deny') => void>()
  let chatConfirmSeq = 0

  const emitNote = (wsPath: string, sessionId: string, noteText: string) => {
    const id = `sys-${Date.now()}`
    broadcast(CH.chatEvent, { workspacePath: wsPath, sessionId, type: 'assistant-start', id, model: '系统' })
    const note: ChatMessage = { id, who: 'ai', text: noteText, model: '系统', ts: new Date().toISOString().slice(11, 19) }
    appendMessage(wsPath, sessionId, note)
    broadcast(CH.chatEvent, { workspacePath: wsPath, sessionId, type: 'done', message: note })
  }

  // 继续执行: deterministically resume a cancelled/failed run — replay the stages that finished ok
  // and re-run from the first incomplete one, WITHOUT going through the LLM propose (which is fragile:
  // forge_propose_plan blocks on approval and codex kills the turn at 180s). Prior stages' handoff
  // summaries seed the resumed stages' context, so switching model (claude↔codex) still carries over.
  const resumeWorkspace = (wsPath: string, override?: { provider?: string; model?: string }) => {
    const sid = readSessions(wsPath).activeSessionId
    const live = orch.getRun()
    const prior = live && live.workspacePath === wsPath ? live : readLastRun(wsPath)
    if (!prior || prior.status === 'run') { emitNote(wsPath, sid, '没有可继续的运行。'); return null }
    const ws = readWorkspace(wsPath)
    if (!ws) { emitNote(wsPath, sid, '该工作区不存在,无法继续。'); return null }
    const base = workspaceToStartRunOpts(ws)
    const store = new RunStore(wsPath, prior.id)
    const modelOverride = override && (override.provider || override.model) ? override : undefined
    const plan = planResume(
      prior, base.stages,
      (id) => { const v = store.getContext('handoff:' + id); return typeof v === 'string' ? v : undefined },
      modelOverride,
      (stageKey) => store.getContext(gateApprovedKey(stageKey)) === true,
    )
    if (!plan) { emitNote(wsPath, sid, '工作流已全部完成,无需继续。'); return null }
    const developProjects = modelOverride
      ? base.developProjects.map(p => ({ ...p, ...(modelOverride.provider ? { provider: modelOverride.provider } : {}), ...(modelOverride.model ? { model: modelOverride.model } : {}) }))
      : base.developProjects
    orch.startRun({ ...base, stages: plan.remainingSpecs, developProjects, resume: { completedStages: plan.completedStages, priorBriefs: plan.priorBriefs } })
      .catch(e => console.error('[resume] startRun failed', e))
    setSessionMode(wsPath, sid, 'workflow', base.runId)
    broadcast(CH.chatEvent, { workspacePath: wsPath, sessionId: sid, type: 'mode-changed', mode: 'workflow', runId: base.runId })
    const modelNote = modelOverride ? ` · 使用 ${modelOverride.model || modelOverride.provider}` : ''
    emitNote(wsPath, sid, `已从第 ${plan.completedStages.length + 1} 阶段继续执行${modelNote}`)
    return orch.getRun()
  }
  ipcMain.handle(CH.engineResume, (_e, a: { workspacePath: string; provider?: string; model?: string }) =>
    resumeWorkspace(a.workspacePath, { provider: a.provider, model: a.model }))

  // proposeRun is the choke-point for chat-triggered workflows: all three chat triggers converge
  // here — the MCP forge_propose_plan tool, the forge:run fence text, and the 「发起工作流」button
  // (which sends a chat planning message that routes through proposeRun). For chat-triggered
  // workflows, orch.startRun is invoked ONLY via proposeRun's approval resolver.
  const proposeRun = makeProposeRun({
    getRun: () => orch.getRun(),
    readWorkspace,
    readWorkflows: () => readWorkflows().workflows,
    writeWorkspace,
    startRun: (o) => { orch.startRun(o).catch(e => console.error('[propose] startRun failed', e)) },
    emitPlanRequest: (wp, req) => broadcast(CH.chatEvent, { workspacePath: wp, sessionId: readSessions(wp).activeSessionId, type: 'plan-request', ...req }),
    emitNote: (wp, text) => emitNote(wp, readSessions(wp).activeSessionId, text),
    // #1: flip the active session's mode + tell the renderer which session switched and to what run.
    setSessionMode: (wp, mode, runId) => { setSessionMode(wp, readSessions(wp).activeSessionId, mode, runId) },
    emitModeChanged: (wp, mode, runId) => broadcast(CH.chatEvent, { workspacePath: wp, sessionId: readSessions(wp).activeSessionId, type: 'mode-changed', mode, runId }),
  })
  // The forge:run fence routes through proposeRun too (approach = the fence task text).
  const onRunTrigger = (wsPath: string, task: string) => { void proposeRun(wsPath, task, task) }
  const runTurn = async (payload: ChatSendPayload) => {
    // Deterministic conversational resume: if the user asks to continue and a cancelled/failed run
    // exists, resume via the engine directly — bypassing the LLM propose path (which blocks on
    // approval and is killed by codex's 180s turn timeout, the very failure that stranded the user).
    if (isResumeIntent(payload.text)) {
      const live = orch.getRun()
      const last = live && live.workspacePath === payload.workspacePath ? live : readLastRun(payload.workspacePath)
      if (last && last.status === 'err') {
        const umsg: ChatMessage = { id: `u-${Date.now()}`, who: 'user', text: payload.text, ts: new Date().toISOString().slice(11, 19) }
        appendMessage(payload.workspacePath, payload.sessionId, umsg)
        broadcast(CH.chatEvent, { workspacePath: payload.workspacePath, sessionId: payload.sessionId, type: 'user', message: umsg })
        resumeWorkspace(payload.workspacePath)
        return umsg
      }
    }
    ensureWorkspaceSkill(payload.workspacePath)   // backfill/auto-update the skill for this workspace
    const provider = providers[payload.agent] ?? providers['claude'] ?? Object.values(providers)[0]
    const confirm = (req: { title: string; where?: string }) => new Promise<'allow' | 'deny'>((resolve) => {
      const id = `cc-${++chatConfirmSeq}`
      chatConfirms.set(id, resolve)
      broadcast(CH.chatEvent, { workspacePath: payload.workspacePath, sessionId: payload.sessionId, type: 'confirm-request', id, title: req.title, where: req.where })
    })
    const store = new RunStore(payload.workspacePath, 'chat-bridge')
    const guardBlocked = makeProposeGuard(3)
    let proposedWorkflow = false
    const bridge = await startBridge(store.runDir, {
      store, runId: 'chat', workspaceName: payload.workspacePath,
      agentName: () => 'chat', agentStage: () => 'chat',
      ask: async () => null, setContext: () => {},
      proposePlan: (approach: string, task?: string, select?: { stages?: string[]; projects?: string[] }) => {
        proposedWorkflow = true
        if (guardBlocked()) { emitNote(payload.workspacePath, payload.sessionId, '已达最大修改次数,请直接批准或取消。'); return Promise.resolve({ approved: false }) }
        return proposeRun(payload.workspacePath, approach, task, select)
      },
    }).catch(() => null)
    const env = buildAgentEnv({ proxy: readSettings().termProxy, overrides: bridge ? { FORGE_SOCKET: bridge.socketPath, FORGE_AGENT_ID: 'chat', FORGE_MCP_ENTRY: mcpEntry, FORGE_TOOLS: 'forge_propose_plan' } : undefined })
    // Snapshot proposes already pending for this workspace before the turn — those belong to earlier
    // turns (fire-and-forget auto-triggers the user hasn't acted on yet) and must survive this turn.
    const preProposes = new Set(proposeRun.pendingIds(payload.workspacePath))
    try {
      const msg = await sendTurn(payload, {
        provider,
        env,
        emit: chatEmit,
        confirm,
        onRunTrigger: (wsPath, task) => { proposedWorkflow = true; onRunTrigger(wsPath, task) },
        onSessionStart: (session) => chatQueue.registerActive(payload.workspacePath, () => session.cancel()),
      })
      // A forge_propose_plan blocks the turn awaiting the user's decision. If the turn ended (API error /
      // codex 180s tool timeout / cancel) while one was still pending, it's now orphaned — the agent that
      // asked is gone. Deny+clear it (excluding prior turns' proposes) and broadcast plan-resolved so the
      // card is cleanly removed instead of lingering/vanishing, and tell the user why nothing ran.
      const orphaned = proposeRun.cancelForWorkspace(payload.workspacePath, preProposes)
      for (const id of orphaned) {
        broadcast(CH.chatEvent, { workspacePath: payload.workspacePath, sessionId: readSessions(payload.workspacePath).activeSessionId, type: 'plan-resolved', id })
      }
      if (orphaned.length) emitNote(payload.workspacePath, payload.sessionId, '⚠️ 主代理未完成方案提交(已中断或超时),待审批方案已取消,请重试。')
      const live = orch.getRun()
      if (!proposedWorkflow && isWorkflowIntent(payload.text) && !(live && live.status === 'run')) {
        emitNote(payload.workspacePath, payload.sessionId, '已识别到明确的工作流执行指令；主代理未调用工作流工具，已自动发起工作流确认。')
        void proposeRun(payload.workspacePath, msg.text || payload.text, payload.text)
      }
      return msg
    }
    finally { await bridge?.close().catch(() => {}) }
  }
  const chatQueue = new ChatQueue(runTurn, broadcast)
  ipcMain.handle(CH.chatSend, (_e, payload: ChatSendPayload, source?: string) => {
    if (isArchivedWorkspace(payload.workspacePath)) throw new Error('工作区已归档，恢复后才能继续。')
    chatQueue.enqueue(payload, source ?? '你')
  })
  ipcMain.handle(CH.chatCancelQueued, (_e, a: { workspacePath: string; id: string }) => chatQueue.cancel(a.workspacePath, a.id))
  ipcMain.handle(CH.chatClearQueue, (_e, a: { workspacePath: string }) => chatQueue.clear(a.workspacePath))
  ipcMain.handle(CH.chatStop, (_e, a: { workspacePath: string }) => chatQueue.stop(a.workspacePath))
  ipcMain.handle(CH.sessionList, (_e, wsPath: string) => readSessions(wsPath))
  ipcMain.handle(CH.sessionNew, (_e, wsPath: string) => {
    if (isArchivedWorkspace(wsPath)) throw new Error('工作区已归档，恢复后才能继续。')
    const file = newSession(wsPath)
    broadcast(CH.sessionsChanged, { workspacePath: wsPath, file })
    return file
  })
  ipcMain.handle(CH.sessionSwitch, (_e, a: { workspacePath: string; sessionId: string }) => {
    const file = switchSession(a.workspacePath, a.sessionId)
    broadcast(CH.sessionsChanged, { workspacePath: a.workspacePath, file })
    return file
  })
  ipcMain.handle(CH.sessionClose, (_e, a: { workspacePath: string; sessionId: string }) => {
    const file = closeSession(a.workspacePath, a.sessionId)
    broadcast(CH.sessionsChanged, { workspacePath: a.workspacePath, file })
    return file
  })
  ipcMain.handle(CH.sessionRename, (_e, a: { workspacePath: string; sessionId: string; title: string }) => {
    const file = renameSession(a.workspacePath, a.sessionId, a.title)
    broadcast(CH.sessionsChanged, { workspacePath: a.workspacePath, file })
    return file
  })
  ipcMain.handle(CH.sessionSetPermission, (_e, a: { workspacePath: string; sessionId: string; mode: import('@shared/permissions').PermissionMode }) => {
    const file = setSessionPermission(a.workspacePath, a.sessionId, a.mode)
    broadcast(CH.sessionsChanged, { workspacePath: a.workspacePath, file })
    return file
  })
  ipcMain.handle(CH.sessionContinueFrom, (_e, a: { wsPath: string; source: import('@shared/types').SourceId; externalId: string; title: string; filePaths: string[] }) => {
    if (isArchivedWorkspace(a.wsPath)) throw new Error('工作区已归档，恢复后才能继续。')
    const file = continueFrom(a.wsPath, a)
    broadcast(CH.sessionsChanged, { workspacePath: a.wsPath, file })
    return file
  })
  ipcMain.handle(CH.sessionAgentIds, (_e, a: { workspacePath: string; sessionId: string }) => agentSessionsForId(a.workspacePath, a.sessionId))
  ipcMain.handle(CH.chatResolve, (_e, a: { id: string; decision: 'allow' | 'deny' | 'modify'; value?: string; workspacePath: string }) => {
    if (proposeRun.has(a.id)) {
      proposeRun.resolve(a.id, { decision: a.decision, value: a.value })
      broadcast(CH.chatEvent, { workspacePath: a.workspacePath, sessionId: readSessions(a.workspacePath).activeSessionId, type: 'plan-resolved', id: a.id })
      return
    }
    const resolve = chatConfirms.get(a.id)
    if (!resolve) return
    chatConfirms.delete(a.id)
    resolve(a.decision === 'modify' ? 'deny' : a.decision)
    broadcast(CH.chatEvent, { workspacePath: a.workspacePath, sessionId: readSessions(a.workspacePath).activeSessionId, type: 'confirm-resolved', id: a.id })
  })
  ipcMain.handle(CH.chatHistory, (_e, a: { workspacePath: string; sessionId: string }) => history(a.workspacePath, a.sessionId))
  ipcMain.handle(CH.dialogOpenFiles, async (): Promise<Attachment[]> => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    return r.filePaths.map(p => ({ name: basename(p), path: p, size: statSync(p).size }))
  })
  ipcMain.handle(CH.chatSavePaste, (_e, a: { workspacePath: string; name: string; dataBase64: string }): Attachment => {
    const dir = join(a.workspacePath, '.forge', 'attachments')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const dest = join(dir, a.name)
    const bytes = Buffer.from(a.dataBase64, 'base64')
    writeFileSync(dest, bytes)
    return { name: a.name, path: dest, size: bytes.length }
  })

  const watcher = new WorktreeWatcher((p, opts) => chokidarWatch(p, opts as object) as unknown as import('../watcher/worktreeWatcher').FsWatcherLike)
  const proxy = () => readSettings().termProxy
  const changesEmit = (e: ChangesEvent) => broadcast(CH.changesEvent, e)

  ipcMain.handle(CH.gitChanges, (_e, cwd: string) => perfSpan('git', 'readChanges', () => readChanges(cwd, proxy())))
  ipcMain.handle(CH.changesMulti, (_e, cwds: string[]) => perfSpan('git', 'changesMulti', () => readChangesMulti(cwds, proxy())))
  ipcMain.handle(CH.gitDiff, (_e, a: { cwd: string; file: string }) => readDiff(a.cwd, a.file, proxy()))
  ipcMain.handle(CH.gitFile, (_e, a: { cwd: string; file: string }) => readFile(a.cwd, a.file, proxy()))
  ipcMain.handle(CH.fsTree, async (_e, cwd: string) => perfSpan('ipc', 'fsTree', async () => readTree(cwd, await readChanges(cwd, proxy()), proxy())))
  ipcMain.handle(CH.gitBranch, (_e, cwd: string) => readBranch(cwd, proxy()))
  ipcMain.handle(CH.fileSearchContent, (_e, a: { root: string; query: string; files?: string[] }) =>
    searchContent({ root: a.root, query: a.query, files: a.files }))
  ipcMain.handle(CH.watchChanges, (_e, cwd: string) => {
    watcher.start(cwd, () => { void perfSpan('watcher', 'onChange', () => readChanges(cwd, proxy()).then(changes => changesEmit({ cwd, changes }))) })
    return readChanges(cwd, proxy())
  })
  ipcMain.handle(CH.watchStop, () => { watcher.stop() })

  // ── Plugin IPC ──────────────────────────────────────────────────────────────
  ipcMain.handle(CH.pluginsList, () =>
    getPluginScheduler()?.snapshot() ?? { plugins: [], results: {} }
  )
  ipcMain.handle(CH.pluginsInstall, (_e, dir: string) => {
    const r = installPlugin(dir)
    if (r.ok) {
      // reconcile() already runs the new plugin; no need to also call refresh()
      getPluginScheduler()?.reconcile()
    }
    return r
  })
  ipcMain.handle(CH.pluginsUninstall, (_e, id: string) => {
    uninstallPlugin(id)
    getPluginScheduler()?.reconcile()
  })
  ipcMain.handle(CH.pluginsSetEnabled, (_e, a: { id: string; enabled: boolean }) => {
    setPluginEnabled(a.id, a.enabled)
    getPluginScheduler()?.reconcile()
  })
  ipcMain.handle(CH.pluginsRefresh, (_e, id?: string) => {
    void getPluginScheduler()?.refresh(id)
  })
  ipcMain.handle(CH.pluginsGetCreds, () => readSettings().pluginCreds ?? {})
  ipcMain.handle(CH.pluginsSetCred, (_e, a: { provider: string; value: string }) => {
    const s = readSettings()
    const creds = { ...(s.pluginCreds ?? {}) }
    if (a.value.trim()) creds[a.provider] = a.value.trim()
    else delete creds[a.provider]   // empty value clears the override → back to auto-read
    writeSettings({ ...s, pluginCreds: creds })
    void getPluginScheduler()?.refresh()   // re-run plugins so the new credential takes effect
    return creds
  })
  ipcMain.handle(CH.pluginsCatalog, () => listCatalog())
  ipcMain.handle(CH.pluginsInstallExample, (_e, id: string) => {
    const r = installOfficial(id)
    if (r.ok) getPluginScheduler()?.reconcile()
    return r
  })
  // ── End Plugin IPC ──────────────────────────────────────────────────────────

  ipcMain.handle(CH.dialogPickDirectory, async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle(CH.dialogPickFile, async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  // ── Session Import IPC ──────────────────────────────────────────────────────
  ipcMain.handle(CH.sessionImportScan, () => {
    const sessions = scanAll()
    const wsPaths = readWorkspaceRegistry().map(w => w.path)
    const groups = groupByCwd(sessions, wsPaths)
    const scannedAt = Date.now()
    writeScanCache(groups, scannedAt)
    return { scannedAt, groups }
  })
  ipcMain.handle(CH.sessionImportLastScan, () => readScanCache())
  ipcMain.handle(CH.sessionImportRun, (_e, sessions: DiscoveredSession[]): import('@shared/types').ImportResult => {
    const wsPaths = new Set(readWorkspaceRegistry().map(w => w.path))
    const cwds = [...new Set(sessions.map(s => s.cwd))].filter(c => c && c !== 'unknown')
    let added = 0
    for (const cwd of cwds) if (!wsPaths.has(cwd)) { importWorkspace(cwd); added++ }
    const index = upsertSessions(sessions, Date.now())
    const existing = new Set(readProjects().projects.map(p => p.name))
    const gitRepos = collectGitCandidates(cwds, { probe: probeGitRepo, existingRepoNames: existing })
    // Refresh the left sidebar live — newly imported workspaces should appear without an app restart.
    if (added > 0) broadcast(CH.workspacesChanged, {})
    return { index, gitRepos }
  })
  ipcMain.handle(CH.sessionImportRead, (_e, s: DiscoveredSession) => readSession(s))
  ipcMain.handle(CH.sessionImportList, () => readIndex())
  ipcMain.handle(CH.sessionImportCoverage, () => sessionImportCoverage())
  // ── End Session Import IPC ──────────────────────────────────────────────────

  ipcMain.handle(CH.petPickPack, async (_e, petId: string) => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return {}
    // Persist each state image to disk under the pet's folder; return { state: relPath } (no data URLs).
    const packed = readPetPack(r.filePaths[0])
    const out: Record<string, string> = {}
    for (const [state, dataUrl] of Object.entries(packed)) {
      if (!dataUrl) continue
      const rel = writePetImageFromDataUrl(petId, state, dataUrl)
      if (rel) out[state] = rel
    }
    return out
  })

  ipcMain.handle(CH.petPickImage, async (_e, petId: string, state: string = 'idle') => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'gif', 'svg', 'webp'] }],
    })
    if (r.canceled || !r.filePaths[0]) return null
    const read = readPetImage(r.filePaths[0])
    if ('error' in read) return { error: read.error }
    // Write to ~/.myFlowForge/pet-images/<petId>/<state>.<ext> and return the relative path only.
    const rel = writePetImageFromDataUrl(petId, state, read.dataUrl)
    if (!rel) return { error: '图片写入失败' }
    return { path: rel }
  })

  // Background image: open a picker, return the chosen image as a data URL (stored inline in settings —
  // one image, self-contained, no file bookkeeping). Cap ~6MB so settings.json stays sane.
  ipcMain.handle(CH.appearancePickBgImage, async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    })
    if (r.canceled || !r.filePaths[0]) return null
    const fp = r.filePaths[0]
    const ext = fp.slice(fp.lastIndexOf('.') + 1).toLowerCase()
    const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
    const mime = MIME[ext]
    if (!mime) return { error: '不支持的图片格式,仅支持 png/jpg/webp/gif' }
    try {
      if (statSync(fp).size > 6_000_000) return { error: '图片过大,请选择 6MB 以内的图片' }
      const bytes = readFileSync(fp)
      return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
    } catch { return { error: '图片读取失败' } }
  })

  const MAX_PINNED = 5
  ipcMain.handle(CH.workspacesList, () => {
    const s = readSettings()
    const live = orch.getRun()
    const livePath = live && live.status === 'run' ? live.workspacePath : undefined
    return listWorkspaces(livePath, s.pinnedWorkspaces, s.workspaceOrder)
  })
  ipcMain.handle(CH.workspacesHomeStats, () => readHomeStats(readSettings().termProxy))
  ipcMain.handle(CH.workspacesSetPinned, (_e, a: { path: string; pinned: boolean }) => {
    const s = readSettings()
    let pinned = s.pinnedWorkspaces.filter(p => p !== a.path)
    if (a.pinned) {
      if (pinned.length >= MAX_PINNED) throw new Error(`最多只能置顶 ${MAX_PINNED} 个工作区`)
      pinned = [...pinned, a.path]
    }
    writeSettings({ ...s, pinnedWorkspaces: pinned })
    const live = orch.getRun()
    const livePath = live && live.status === 'run' ? live.workspacePath : undefined
    return listWorkspaces(livePath, pinned, s.workspaceOrder)
  })
  ipcMain.handle(CH.workspacesSetOrder, (_e, a: { order: string[] }) => {
    const s = readSettings()
    writeSettings({ ...s, workspaceOrder: a.order })
    // Keep every window's settings snapshot fresh so a later config:set-settings (which writes the
    // whole settings object) doesn't clobber the manual order with a stale value.
    broadcast(CH.settingsChanged, readSettings())
    const live = orch.getRun()
    const livePath = live && live.status === 'run' ? live.workspacePath : undefined
    return listWorkspaces(livePath, s.pinnedWorkspaces, a.order)
  })
  const wsList = () => {
    const s = readSettings()
    const live = orch.getRun()
    const livePath = live && live.status === 'run' ? live.workspacePath : undefined
    return listWorkspaces(livePath, s.pinnedWorkspaces, s.workspaceOrder)
  }
  ipcMain.handle(CH.workspaceArchive, (_e, path: string) => {
    archiveWorkspaceLifecycle(path)
    void summarizeWorkspace(path, providers, buildAgentEnv({ proxy: readSettings().termProxy })).then(desc => {
      setWorkspaceLifecycle(path, { description: desc })
      broadcast(CH.workspacesChanged, {})
    })
    broadcast(CH.workspacesChanged, {})
    return wsList()
  })
  ipcMain.handle(CH.workspaceRestore, (_e, path: string) => {
    restoreWorkspaceLifecycle(path)
    broadcast(CH.workspacesChanged, {})
    return wsList()
  })
  ipcMain.handle(CH.workspaceDelete, async (_e, path: string) => {
    const r = await deleteWorkspace(path)
    broadcast(CH.workspacesChanged, {})
    return { ...r, list: wsList() }
  })
  // 移除:仅从列表移除,保留磁盘文件(可重新添加目录恢复)。
  ipcMain.handle(CH.workspaceRemove, (_e, path: string) => {
    removeWorkspaceFromList(path)
    broadcast(CH.workspacesChanged, {})
    return wsList()
  })
  // 在 Finder / 资源管理器 / 文件管理器中打开该目录(跨平台:shell.openPath)。
  ipcMain.handle(CH.revealPath, async (_e, path: string) => {
    const err = await shell.openPath(path)   // '' on success; non-empty error string otherwise
    return err ? { ok: false as const, error: err } : { ok: true as const }
  })
  // 用系统默认浏览器打开一个 http(s) 链接(仅放行 http/https,拒绝其它协议以免被当作命令/文件执行)。
  ipcMain.handle(CH.openExternal, async (_e, url: string) => {
    try {
      const u = new URL(String(url))
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false as const, error: 'unsupported protocol' }
      await shell.openExternal(u.toString())
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── 用外部软件打开(「打开位置」下拉) ─────────────────────────────────────────
  // Extract an app's real icon → dataURL for the dropdown (best-effort; falls back to a glyph).
  // On macOS we read the bundle's own .icns first: app.getFileIcon returns a generic placeholder
  // (an identical blank icon for every app) on some macOS builds. getFileIcon stays as the fallback
  // for apps without a standalone .icns (Assets.car system apps) and for non-macOS platforms.
  const openerIcon = async (appPath: string): Promise<string | undefined> => {
    if (process.platform === 'darwin') {
      const real = await readMacAppIcon(appPath)
      if (real) return real
    }
    try { const img = await app.getFileIcon(appPath, { size: 'normal' }); return img.isEmpty() ? undefined : img.toDataURL() }
    catch { return undefined }
  }
  const runOpen = (args: string[]) => new Promise<void>((res, rej) => {
    execFile('open', args, (err) => (err ? rej(err) : res()))
  })
  let openersCache: DetectedOpener[] = []
  ipcMain.handle(CH.openersDetect, async (_e, refresh?: boolean) => {
    openersCache = await detectOpeners(openerIcon, !!refresh)
    return openersCache
  })
  ipcMain.handle(CH.openersOpen, async (_e, arg: { openerId: string; folder: string; file?: string }) => {
    let op = resolveOpener(arg.openerId, openersCache)
    // Cold cache (renderer never called detect this session) — populate once, then retry.
    if (!op) { openersCache = await detectOpeners(openerIcon, false); op = resolveOpener(arg.openerId, openersCache) }
    if (!op) return { ok: false as const, error: '未找到该软件' }
    // Lazy refresh: the app was deleted since detection — drop it from the cache + persist, and tell
    // the renderer to remove it too (removedId), instead of forcing a full rescan.
    if (!existsSync(op.appPath)) {
      openersCache = withoutOpener(openersCache, op.id)
      try { writeJsonAtomic(openersCacheFile(), { apps: openersCache }) } catch { /* best-effort */ }
      return { ok: false as const, error: `${op.name} 已不存在,已从列表移除`, removedId: op.id }
    }
    const argvs = buildOpenCommand(op.openMode, op.appPath, { folder: arg.folder, file: arg.file })
    try { for (const args of argvs) await runOpen(args); return { ok: true as const } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })
  ipcMain.handle(CH.workspacesOpenDir, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const dir = r.filePaths[0]
    if (dir) {
      const wsJson = join(dir, '.forge', 'workspace.json')
      if (existsSync(wsJson)) {
        try { const ws = JSON.parse(readFileSync(wsJson, 'utf8')); if (ws?.name) registerWorkspace(String(ws.name), dir) } catch { /* ignore malformed */ }
      }
    }
    const live = orch.getRun()
    const livePath = live && live.status === 'run' ? live.workspacePath : undefined
    return listWorkspaces(livePath, readSettings().pinnedWorkspaces)
  })

  // ── App debug log ───────────────────────────────────────────────────────────
  ipcMain.handle(CH.appLogGet, () => getAppLog())
  ipcMain.handle(CH.appLogClear, () => { clearAppLog(); return getAppLog() })
  ipcMain.handle(CH.appLogExport, async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const r = await dialog.showSaveDialog({ title: '导出调试日志', defaultPath: `myFlowForge-debug-${stamp}.log` })
    if (r.canceled || !r.filePath) return { ok: false as const, canceled: true }
    try { await writeFile(r.filePath, formatAppLog(), 'utf8'); return { ok: true as const, path: r.filePath } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })
}
