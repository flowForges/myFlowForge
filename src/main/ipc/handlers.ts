import { ipcMain, dialog, app, shell } from 'electron'
import { CH } from './channels'
import { EventBus } from '../orchestrator/eventBus'
import { Orchestrator, gateApprovedKey } from '../orchestrator/orchestrator'
import { readSettings, writeSettings, readProjects, writeProjects, readWorkflows, writeWorkflows, readHookLibrary, writeHookLibrary, readCustomStages, upsertCustomStage, deleteCustomStage, upsertProject, setProjectDefaultBranch, registerWorkspace, unregisterWorkspace, readWorkspace, writeWorkspace, readAgentsConfig, writeAgentsConfig, readWorkspaceRegistry, setWorkspaceLifecycle, setStageModel } from '../config/store'
import { indexCustomStages } from '../../shared/customStages'
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
import { resolveSetupInteraction } from '../workspace/setupInteractions'
import { workspaceToStartRunOpts } from '../workspace/workspaceRun'
import { resolveStages, pickWorkspaceWorkflow, resolveWorkflowStages, unionWorkflowStages } from '../workspace/resolveStages'
import { isArchivedWorkspace } from '../workspace/archivedGuard'
import { memoryRead, memoryWrite, memoryClear, type MemoryArg } from './memoryHandlers'
import { workflowNameTaken } from '../../shared/workflowName'
import { listWorkspaces } from '../workspace/workspaceList'
import { readHomeStats } from '../workspace/homeStats'
import { sendTurn, history } from '../chat/chatService'
import { ChatQueue } from '../chat/chatQueue'
import { appendMessage } from '../chat/chatStore'
import { mergeLive } from '../chat/liveTurns'
import { readSessions, newSession, switchSession, closeSession, renameSession, setSessionMode, setSessionPermission, setSessionModel, continueFrom, getSession } from '../chat/sessionStore'
import { agentSessionsForId } from '../chat/agentSessions'
import { distillModelFor } from '../chat/memory/distillModel'
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
import { readLastRun, discardRuns, RunStore } from '../orchestrator/runStore'
import { Run2Manager } from '../run/manager'
import { registerRun2 } from './run2Handlers'
import { planResume } from '../orchestrator/resumeRun'
import { archiveWorkspaceLifecycle, restoreWorkspaceLifecycle } from '../workspace/archiveOps'
import { deleteWorkspace, removeWorkspaceFromList, discardPartialCreation } from '../workspace/deleteOps'
import { summarizeWorkspace } from '../workspace/summarizeWorkspace'
import { makeProposeRun } from '../chat/proposeRun'
import { makeRunDelegate, cancelWorkspaceDelegates } from '../chat/delegate'
import { isResumeIntent } from '../chat/workflowIntent'
import { readPetPack, readPetImage } from '../pet/petPack'
import { writePetImageFromDataUrl } from '../pet/petImageStore'
import { importCodexPetPack, discoverCodexPets } from '../pet/codexPetImport'
import { storeBackgroundFromPath, backgroundImageUrl, bgRelFromUrl, gcBackgrounds, resolveBackgroundAbs } from '../appearance/backgroundStore'
import { listDownloadedFonts, downloadCatalogFont, deleteDownloadedFont } from '../appearance/fontStore'
import { catalogEntry } from '../../shared/fontCatalog'
import { nsfwValidate, nsfwCatalog, nsfwPreview, nsfwInstallPet, nsfwInstallBg } from '../nsfw/nsfwService'
import { wallpaperCatalog, wallpaperPreview, wallpaperInstall } from '../wallpaper/wallpaperService'
import type { WallpaperItem } from '../../shared/wallpaper'
import { petPackCatalog, petPackPreview, petPackInstall } from '../petPack/petPackService'
import type { PetPackItem } from '../../shared/petPack'
import type { NsfwPet, NsfwBg } from '../../shared/nsfw'
import { createUpdateChecker } from '../update/updateChecker'
import { fetchLatestRelease } from '../update/githubSource'
import { pickInstaller } from '../update/installer'
import { makeProxyFetch, makeContentFetch } from '../update/proxyFetch'
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

  // Run2 (P3-A): additive headless run controller, wired alongside (not replacing) the Orchestrator above.
  const run2Manager = new Run2Manager({
    providers,
    // Robustness: process.env has no proxy — networks where the CLI can't reach the API directly
    // (proxied corp networks etc.) would silently fail every run2 agent. buildAgentEnv(termProxy)
    // matches the narrator/detect/refreshModels usages elsewhere in this file (e.g. line ~105).
    env: buildAgentEnv({ proxy: readSettings().termProxy }),
    makeStore: (w, r) => new RunStore(w, r),
    emit: {
      event: (w, e) => broadcast(CH.run2Event, { workspacePath: w, event: e }),
      update: (w, s) => broadcast(CH.run2Update, { workspacePath: w, state: s }),
      log: (w, l) => broadcast(CH.run2Log, { workspacePath: w, log: l }),
    },
    onError: (w, err) => console.error(`[run2] ${w}:`, err),
  })
  registerRun2({
    manager: run2Manager, onInvoke: (ch, h) => ipcMain.handle(ch, h),
    readWorkspace, readWorkflows: () => readWorkflows().workflows, readCustomStages: () => readCustomStages().stages,
  })

  const UPDATE_REPO = 'flowForges/myFlowForge'
  const updateChecker = createUpdateChecker({
    repo: UPDATE_REPO,
    currentVersion: () => app.getVersion(),
    // proxy-THEN-direct: the update check must survive a down/misrouted/socks proxy (settings.termProxy).
    // makeProxyFetch had no direct fallback, so any proxy hiccup → throw → 永久「检查失败」even when GitHub
    // is directly reachable. makeContentFetch tries the proxy then falls back to a direct fetch.
    fetchLatest: (r) => fetchLatestRelease(r, { fetch: makeContentFetch(readSettings().termProxy) as (url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<any> }>, arch: process.arch }),
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
      fetch: (url, init) => makeContentFetch(readSettings().termProxy)(url, init as any) as any,
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

  // #13: the user answered a setup hook's confirm/input card (SetupProgress) — unblock the hook.
  ipcMain.handle(CH.workspaceSetupResolve, (_e, a: { id: string; answer: { decision?: 'allow' | 'deny'; value?: string } }) => {
    resolveSetupInteraction(a.id, a.answer)
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
  ipcMain.handle(CH.configAddWorkflow, (_e, input: { name: string; stages: import('../config/buildWorkflow').StageSeed[] }) => {
    const list = readWorkflows().workflows
    // Enforce unique display names (the UI blocks this too; this is the safety net). Duplicate =
    // no-op returning the current list, so a bypassed UI can't silently create a confusing twin.
    if (workflowNameTaken(input.name, list.map(w => w.name))) return list
    const wf = buildWorkflow(input.name, input.stages, list.map(w => w.id))
    writeWorkflows({ workflows: [...list, wf] })
    return readWorkflows().workflows
  })
  ipcMain.handle(CH.configDeleteWorkflow, (_e, id: string) => {
    writeWorkflows({ workflows: readWorkflows().workflows.filter(w => w.id !== id) })
    return readWorkflows().workflows
  })
  ipcMain.handle(CH.configUpdateWorkflow, (_e, input: { id: string; plugins?: import('../config/schema').Plugin[]; stagePrompts?: Record<string, string>; stages?: import('../config/schema').Workflow['stages'] }) => {
    const list = readWorkflows().workflows
    writeWorkflows({ workflows: list.map(w => w.id === input.id ? {
      ...w,
      ...(input.plugins !== undefined ? { plugins: input.plugins } : {}),
      ...(input.stagePrompts !== undefined ? { stagePrompts: input.stagePrompts } : {}),
      // Full stage-list edit (#3): add/rename/delete/reorder stages + per-stage flags. writeWorkflows
      // runs it through WorkflowSchema, so at least one stage is enforced and shapes are validated.
      ...(input.stages !== undefined ? { stages: input.stages } : {}),
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
  // --- Global custom-stage library (定义一次,被多个工作流模版按 libId 引用,编辑一次处处生效) ---
  ipcMain.handle(CH.customStagesList, () => readCustomStages().stages)
  ipcMain.handle(CH.customStagesUpsert, (_e, def: Partial<import('../config/schema').CustomStage> & { name: string }) => {
    const list = upsertCustomStage(def)
    broadcast(CH.customStagesChanged, list)
    return list
  })
  ipcMain.handle(CH.customStagesDelete, (_e, id: string) => {
    const list = deleteCustomStage(id)
    broadcast(CH.customStagesChanged, list)
    return list
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
  // 「允许 LLM 自行决策」per-workspace 开关:写入 workspace.json,供 proposeRun 读取以决定是否弹门。
  ipcMain.handle(CH.wsSetAutoDecide, (_e, a: { workspacePath: string; value: boolean }) => {
    const ws = readWorkspace(a.workspacePath)
    if (ws) writeWorkspace({ ...ws, autoDecide: a.value })
  })
  ipcMain.handle(CH.workspaceSetStageModel, (_e, a: { path: string; stageKey: string; provider: string; model: string }) => {
    setStageModel(a.path, a.stageKey, a.provider, a.model)
  })
  ipcMain.handle(CH.workspaceRun, (_e, path: string) => {
    if (isArchivedWorkspace(path)) throw new Error('工作区已归档，恢复后才能继续。')
    const ws = readWorkspace(path)
    if (!ws) return
    const live = orch.getRun()
    if (live && live.status === 'run') return
    const stages = resolveStages(ws, readWorkflows().workflows, indexCustomStages(readCustomStages().stages))
    if (stages.length === 0) return
    const filled = { ...ws, stages }
    if (ws.stages.length === 0) writeWorkspace(filled)   // backfill pre-SP-A workspaces permanently
    return orch.startRun({ ...workspaceToStartRunOpts(filled), sessionId: readSessions(path).activeSessionId })
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
  ipcMain.handle(CH.engineStartRun, (_e, rawOpts: StartRunOpts) => {
    // Every stage pauses on a review gate (approve / 打回重做 / 终止) in production runs — default
    // gate:true on any stage that doesn't set it explicitly (an explicit false still opts out). This
    // is the choke point for the direct run-IPC; proposeRun/resume/create paths set gate in their
    // own mappings. Orchestrator unit tests call orch.startRun directly and keep the design-only default.
    // #3: attribute the run to the session that triggered it (falls back to the active session) so its
    // gate cards only surface in that tab.
    const opts: StartRunOpts = { ...rawOpts, sessionId: rawOpts.sessionId ?? readSessions(rawOpts.workspacePath).activeSessionId, stages: rawOpts.stages.map(s => ({ gate: true, ...s })) }
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
  // '终止退出': abandon a failed/interrupted run entirely — clear the in-memory terminal run, delete
  // its persisted state (so nothing offers to resume it), and return the owning session to chat mode.
  ipcMain.handle(CH.engineDiscard, (_e, wsPath: string) => {
    const live = orch.getRun()
    const sid = (live && live.workspacePath === wsPath && live.sessionId) || readSessions(wsPath).activeSessionId
    orch.clearRun(wsPath)
    discardRuns(wsPath)
    setSessionMode(wsPath, sid, 'chat')
    broadcast(CH.chatEvent, { workspacePath: wsPath, sessionId: sid, type: 'mode-changed', mode: 'chat' })
  })
  ipcMain.handle(CH.engineLastRun, (_e, wsPath: string) => {
    const live = orch.getRun()
    return live && live.workspacePath === wsPath ? live : readLastRun(wsPath)
  })

  const chatEmit = (e: ChatEvent) => broadcast(CH.chatEvent, e)
  const chatConfirms = new Map<string, (decision: 'allow' | 'deny') => void>()
  let chatConfirmSeq = 0
  // Chat-side ASK (question + optional options, returns a string) — the delegate bridge routes a
  // sub-agent's forge_ask here so it surfaces as a select/input ReqCard and the answer flows back.
  const chatAsks = new Map<string, (r: { decision: 'allow' | 'deny'; value?: string; choice?: number }) => void>()
  let chatAskSeq = 0
  // Owner (ws + session) + type of every OUTSTANDING chat gate, so a turn that ends WITHOUT the user
  // answering (CLI/turn timeout, error, 停止) can drain its orphaned gates — resolve the blocked promise
  // AND broadcast the matching *-resolved event. Without this the pet's 需确认/需输入 indicator (driven
  // purely by confirm-request→confirm-resolved in useChatActivity) stays stuck forever, because no
  // confirm-resolved is ever emitted for an abandoned gate. (proposeRun already drains this way; chat
  // confirm/ask never did.)
  const chatGateOwner = new Map<string, { ws: string; sessionId: string; type: 'confirm' | 'ask' }>()
  const drainChatGates = (wsPath: string, opts: { sessionId?: string; type?: 'confirm' | 'ask' } = {}) => {
    for (const [id, meta] of [...chatGateOwner]) {
      if (meta.ws !== wsPath) continue
      if (opts.sessionId && meta.sessionId !== opts.sessionId) continue
      if (opts.type && meta.type !== opts.type) continue
      chatGateOwner.delete(id)
      if (meta.type === 'confirm') {
        const r = chatConfirms.get(id)
        if (!r) continue
        chatConfirms.delete(id)
        r('deny')
        broadcast(CH.chatEvent, { workspacePath: meta.ws, sessionId: meta.sessionId, type: 'confirm-resolved', id })
      } else {
        const r = chatAsks.get(id)
        if (!r) continue
        chatAsks.delete(id)
        r({ decision: 'deny' })
        broadcast(CH.chatEvent, { workspacePath: meta.ws, sessionId: meta.sessionId, type: 'ask-resolved', id })
      }
    }
  }
  const chatAsk = (wsPath: string, sessionId: string, question: string, options?: { t: string; d: string }[], agentName?: string): Promise<string | null> =>
    new Promise((resolve) => {
      const id = `ca-${++chatAskSeq}`
      chatGateOwner.set(id, { ws: wsPath, sessionId, type: 'ask' })
      chatAsks.set(id, (r) => {
        if (r.decision === 'deny') { resolve(null); return }
        // A typed custom answer (value) always wins over a picked option — the user chose to write their
        // own instead of taking a preset. Falls back to the chosen option's label when no text was typed.
        if (r.value && r.value.trim()) { resolve(r.value.trim()); return }
        if (options && options.length) resolve(options[r.choice ?? 0]?.t ?? null)
        else resolve(r.decision === 'allow' ? (r.value ?? '') : null)
      })
      broadcast(CH.chatEvent, { workspacePath: wsPath, sessionId, type: 'ask-request', id, title: question, options, agentName })
    })

  const emitNote = (wsPath: string, sessionId: string, noteText: string) => {
    const id = `sys-${Date.now()}`
    broadcast(CH.chatEvent, { workspacePath: wsPath, sessionId, type: 'assistant-start', id, model: '系统' })
    const note: ChatMessage = { id, who: 'ai', text: noteText, model: '系统', ts: new Date().toISOString().slice(11, 19) }
    appendMessage(wsPath, sessionId, note)
    broadcast(CH.chatEvent, { workspacePath: wsPath, sessionId, type: 'done', message: note })
  }

  // Per-(workspace, session) count of in-flight fire-and-forget delegate batches. The chat turn ends
  // the moment forge_delegate returns 「已派发」, but the sub-agents keep running — this lets the
  // composer show a running/stop state across that boundary instead of looking idle. Broadcast on every
  // change so the renderer (useChat) can OR it into its running indicator.
  const delegateBusy = new Map<string, number>()
  const bumpDelegateBusy = (wsPath: string, sessionId: string, delta: number) => {
    const k = `${wsPath}::${sessionId}`
    const n = Math.max(0, (delegateBusy.get(k) ?? 0) + delta)
    if (n) delegateBusy.set(k, n); else delegateBusy.delete(k)
    broadcast(CH.chatEvent, { workspacePath: wsPath, sessionId, type: 'delegate-busy', active: n > 0 })
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
    // ws.stages is the legacy migration seed and is permanently [] for any workspace created/edited
    // under the multi-workflow model (stages live in ws.workflows[].stages now). Resolve the stages
    // from the FAILED RUN's own workflow (prior.workflowId) — same pattern proposeRun.ts uses —
    // so base.stages is actually populated and planResume doesn't bail with "已全部完成".
    const custom = indexCustomStages(readCustomStages().stages)
    // Ad-hoc runs (no named workflow) carry prior.workflowId === undefined; they must resolve the
    // UNION of all workflow stages (mirror proposeRun.ts), not silently collapse to workflows[0].
    // pickWorkspaceWorkflow(ws, undefined) returns workflows[0], so short-circuit to null first.
    const wf = prior.workflowId ? pickWorkspaceWorkflow(ws, prior.workflowId) : null
    const stages = wf
      ? resolveWorkflowStages(wf, readWorkflows().workflows, custom)
      : unionWorkflowStages(ws, readWorkflows().workflows, custom)
    const filled = { ...ws, stages }
    const base = workspaceToStartRunOpts(filled, undefined, wf ? { id: wf.id, name: wf.name } : undefined)
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
    orch.startRun({ ...base, sessionId: sid, stages: plan.remainingSpecs, developProjects, resume: { completedStages: plan.completedStages, priorBriefs: plan.priorBriefs } })
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
    readCustomStages: () => readCustomStages().stages,
    writeWorkspace,
    startRun: (o) => {
      // Sink the initiating session's permission shield into the run so stage sub-agents inherit it
      // (not just the main chat agent). Absent → provider default ('auto'), the historical behavior.
      const sid = o.sessionId ?? readSessions(o.workspacePath).activeSessionId
      const permissionMode = o.permissionMode ?? (sid ? getSession(o.workspacePath, sid)?.permissionMode : undefined)
      orch.startRun({ ...o, permissionMode }).catch(e => console.error('[propose] startRun failed', e))
    },
    emitPlanRequest: (wp, req) => broadcast(CH.chatEvent, { workspacePath: wp, sessionId: readSessions(wp).activeSessionId, type: 'plan-request', ...req }),
    emitNote: (wp, text) => emitNote(wp, readSessions(wp).activeSessionId, text),
    // #1: flip the active session's mode + tell the renderer which session switched and to what run.
    setSessionMode: (wp, mode, runId) => { setSessionMode(wp, readSessions(wp).activeSessionId, mode, runId) },
    emitModeChanged: (wp, mode, runId) => broadcast(CH.chatEvent, { workspacePath: wp, sessionId: readSessions(wp).activeSessionId, type: 'mode-changed', mode, runId }),
  })
  // Lightweight delegation (path A): the chat agent dispatches sub-agents into projects without the
  // workflow gate. Shares providers/mcpEntry with the orchestrator; runs are ephemeral (no run slot).
  const runDelegate = makeRunDelegate({ providers, proxy: () => readSettings().termProxy, mcpEntry, readWorkspace })
  // Task 12: the approval card's workflow-switch dropdown re-proposes the SAME task/approach under a
  // different (or ad-hoc, workflowId omitted) workflow. Renderer denies the old card first, then calls
  // this; proposeRun emits a fresh plan-request with the chosen workflow's stage set.
  ipcMain.handle(CH.chatReproposeWorkflow, (_e, a: { workspacePath: string; approach: string; task?: string; workflowId?: string }) => {
    // standalone: this propose is UI-initiated (not owned by an agent turn), so turn cleanup
    // (cancelForWorkspace) must not dismiss it before the user decides — see proposeRun.ts.
    void proposeRun(a.workspacePath, a.approach, a.task, { ...(a.workflowId ? { workflowId: a.workflowId } : {}), standalone: true, sessionId: readSessions(a.workspacePath).activeSessionId })
  })
  const runTurn = async (payload: ChatSendPayload) => {
    // Gate/chat continuity: a live run paused at a 阶段评审门 (需求/设计 阶段完成后的 approve/打回重做/终止 门)
    // is normally answered by clicking the card. If the user instead types their reaction into chat ("评审得
    // 不对，因为…"), reconcile it INTO that gate as 打回重做 (decision:'modify') so the run re-does that stage
    // with the user's correction — analyzeRework runs the feedback through the main agent, exactly "据门内容+
    // 用户输入重新整理，重跑，结束旧门，对话连续". Without this, the gate dangles: the message runs as an
    // ordinary turn (the agent may even pop a second propose 门), the review 门 sits orphaned until the user
    // later clicks 终止, which tears down the whole run and narrates "编排…失败" — the discontinuity users hit.
    // reworkable is true ONLY for stage review gates (see PendingAction), so it uniquely identifies them.
    {
      const live = orch.getRun()
      const gate = live && live.status === 'run' && live.workspacePath === payload.workspacePath
        ? live.pending.find(p => p.kind === 'confirm' && p.reworkable && p.id.startsWith('review-'))
        : undefined
      if (gate) {
        const umsg: ChatMessage = { id: `u-${Date.now()}`, who: 'user', text: payload.text, ts: new Date().toISOString().slice(11, 19) }
        appendMessage(payload.workspacePath, payload.sessionId, umsg)
        broadcast(CH.chatEvent, { workspacePath: payload.workspacePath, sessionId: payload.sessionId, type: 'user', message: umsg })
        orch.resolve({ id: gate.id, decision: 'modify', value: payload.text })
        emitNote(payload.workspacePath, payload.sessionId, `已把你的意见交给主代理分析——它会结合「${gate.agentName}」的现有方案判断：能直接改就出修订版，需要重读代码才会先问你要不要重探。`)
        return umsg
      }
    }
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
      chatGateOwner.set(id, { ws: payload.workspacePath, sessionId: payload.sessionId, type: 'confirm' })
      broadcast(CH.chatEvent, { workspacePath: payload.workspacePath, sessionId: payload.sessionId, type: 'confirm-request', id, title: req.title, where: req.where })
    })
    const store = new RunStore(payload.workspacePath, 'chat-bridge')
    // forge_delegate is fire-and-forget: its MCP call returns 「已派发」at once, so without this the turn
    // would resolve while the sub-agents keep running in the background — and the NEXT message would start
    // a CONCURRENT turn (a 2nd batch running alongside the 1st, their progress blocks scattered). Collect a
    // completion promise per batch dispatched THIS turn and await them before the turn resolves, so
    // ChatQueue keeps this workspace busy and a message typed mid-run queues until the batch finishes.
    const delegateBatches: Promise<void>[] = []
    const bridge = await startBridge(store.runDir, {
      store, runId: 'chat', workspaceName: payload.workspacePath,
      agentName: () => 'chat', agentStage: () => 'chat',
      ask: async () => null, setContext: () => {},
      // 神经切断:聊天不再是工作流入口("聊着聊着突然启动工作流"是用户的#1投诉)。主代理调
      // forge_propose_plan 时,不再调 proposeRun 开真门/真跑,只回一句引导去「工作流运行」启动器,
      // 并对 MCP 调用方回 approved:false(不阻塞、不误导主代理以为方案在等待批准)。
      proposePlan: () => {
        emitNote(payload.workspacePath, payload.sessionId, '工作流请到「工作流运行」模式用启动器发起（聊天不再自动开工作流）。')
        return Promise.resolve({ approved: false })
      },
      delegate: (a: { task: string; projects?: string[]; write?: boolean; brief?: string }) => {
        // Per-call: the batch's runId (from onBatchStart) so onComplete can mark the SAME progress block done.
        let batchRunId: string | null = null
        // Hold the turn open until THIS batch's onComplete fires (see delegateBatches above), so the queue
        // serializes a mid-run message behind it instead of racing a concurrent turn. onComplete is
        // guaranteed on every exit path of delegate's background IIFE, so this promise always settles.
        let settleBatch: () => void = () => {}
        delegateBatches.push(new Promise<void>((res) => { settleBatch = res }))
        // Mark this session as having in-flight background delegates (cleared in onComplete) so the
        // composer shows a running/stop state while the fire-and-forget sub-agents keep working.
        bumpDelegateBusy(payload.workspacePath, payload.sessionId, +1)
        return runDelegate({
          workspacePath: payload.workspacePath, task: a.task, projects: a.projects, write: a.write, brief: a.brief,
          provider: payload.agent, model: payload.model, permissionMode: payload.permissionMode, sessionId: payload.sessionId,
          // Register each delegate sub-agent's session for cancellation, so the chat 停止 button kills it.
          onSession: (s) => chatQueue.registerActive(payload.workspacePath, () => s.cancel()),
          // 对话区实时进度块(fire-and-forget 后主代理这轮已结束,用户不开 IDs 面板也看得见后台子代理在跑)。
          // live-only:只广播、不 appendMessage(它是瞬态 widget,会话重载后消失;持久的汇总消息随后单独到达)。
          onBatchStart: (runId, agents) => {
            batchRunId = runId
            broadcast(CH.chatEvent, { workspacePath: payload.workspacePath, sessionId: payload.sessionId, type: 'delegate-start', id: `delegate-batch:${runId}`, batch: { runId, agents: agents.map(a => ({ ...a, status: 'run' as const })), done: false, task: a.task, brief: a.brief } })
          },
          onAgentState: (runId, agentId, status, output, activity) => {
            broadcast(CH.chatEvent, { workspacePath: payload.workspacePath, sessionId: payload.sessionId, type: 'delegate-progress', id: `delegate-batch:${runId}`, agentId, status, output, activity })
          },
          // 派发前权限门(runDelegate 仅在 codex + 写类 + 盾牌未到「完全」时才调用):codex 需完全权限才能让子代理
          // 的 forge_handoff/forge_ask 正常工作。弹一次卡片让用户【本次授权】(不改持久盾牌);选「仅当前权限」则用当前
          // 盾牌权限跑,产出靠 agent_message 兜底文本回传。返回 'full'/'default' 给 runDelegate 决定这次的 sandbox。
          askPermission: async ({ projects }) => {
            const where = projects.length ? `（项目：${projects.join('、')}）` : ''
            const q = `本次委派会修改文件并需回传结果${where}。codex 需要「完全」权限才能正常回传/交互，当前盾牌不是。是否【本次】授权完全权限？（仅本次运行，不改你输入框下方的权限盾牌）`
            const options = [
              { t: '授权本次', d: '本次运行给完全权限，forge 交接/提问正常工作' },
              { t: '仅当前权限', d: '沿用当前盾牌权限（工作区写），结果以文本回传' },
            ]
            const ans = await chatAsk(payload.workspacePath, payload.sessionId, q, options, '权限确认')
            return ans === '授权本次' ? 'full' : 'default'
          },
          // Bubble a delegate sub-agent's forge_ask to the user as a chat select/input card (same ReqCard
          // the workflow gate uses); the answer resolves the sub-agent's blocked forge_ask.
          // 交互中转(方案A · 连贯呈现 + 确定回传):委派子代理的 forge_ask 在主代理对话流里以交互卡片呈现
          // (ReqCard 已标注来源「【项目】子代理」),用户答后【确定性】回传子代理继续。额外在对话流前后各留一条
          // 锚点:提问时一条「需要你确认(见卡片)」、答后一条「已把回复转回子代理」——让这次委派交互连贯留痕、记入
          // 会话历史,主代理后续任何一轮都能在上下文看到(不再脱离主代理、静默发生)。
          ask: async (question, options, agentName) => {
            const who = agentName ?? '子代理'
            emitNote(payload.workspacePath, payload.sessionId, `🔗 委派子代理【${who}】需要你确认（见下方卡片）`)
            const answer = await chatAsk(payload.workspacePath, payload.sessionId, question, options, agentName)
            emitNote(payload.workspacePath, payload.sessionId, `↳ 已把你的回复（${answer ?? '已取消'}）转回委派子代理【${who}】继续`)
            return answer
          },
          // NOTE: per-tool-call progress is deliberately NOT surfaced into the chat. Emitting a note
          // per sub-agent Read/Bash (× N sub-agents) floods and permanently pollutes the conversation
          // history. Live sub-agent progress belongs in the inspector / IDs panel (which already shows
          // each delegate sub-agent as 运行中). The chat keeps only: the main agent's 「已派发」reply,
          // any forge_ask confirmation card, and the final onComplete summary. (onProgress left unset.)
          // fire-and-forget 的产出回流点:后台委派全部完成后,把子代理汇总作为一条新 AI 消息呈现回会话。主代理
          // 这一轮通常早已结束(它拿到「已派发」确认就回复了),这里独立于轮次直接 append+广播(同 emitNote 机制)。
          onComplete: (r) => {
            // Mark the live progress block finished (flips any lingering 'run' rows to done + collapses).
            if (batchRunId) broadcast(CH.chatEvent, { workspacePath: payload.workspacePath, sessionId: payload.sessionId, type: 'delegate-done', id: `delegate-batch:${batchRunId}` })
            const did = `dg-done-${Date.now()}`
            broadcast(CH.chatEvent, { workspacePath: payload.workspacePath, sessionId: payload.sessionId, type: 'assistant-start', id: did, model: '委派子代理汇总' })
            const dmsg: ChatMessage = { id: did, who: 'ai', text: r.text || '(子代理无产出)', model: '委派子代理汇总', provider: payload.agent, ts: new Date().toISOString().slice(11, 19) }
            appendMessage(payload.workspacePath, payload.sessionId, dmsg)
            broadcast(CH.chatEvent, { workspacePath: payload.workspacePath, sessionId: payload.sessionId, type: 'done', message: dmsg })
            // Background delegates for this batch are done → clear the composer's running/stop state.
            bumpDelegateBusy(payload.workspacePath, payload.sessionId, -1)
            settleBatch()   // release the turn's wait so the next queued message can run
          },
        })
      },
    }).catch(() => null)
    // FORGE_WORKFLOWS feeds forgeChatDirective (non-claude CLIs) with this workspace's named
    // workflows so the agent can map the user's request onto a workflowId (Task 8). The claude
    // path instead gets this via ensureWorkspaceSkill's appended SKILL.md section.
    const chatWs = readWorkspace(payload.workspacePath)
    const env = buildAgentEnv({ proxy: readSettings().termProxy, overrides: bridge ? { FORGE_SOCKET: bridge.socketPath, FORGE_AGENT_ID: 'chat', FORGE_MCP_ENTRY: mcpEntry, FORGE_TOOLS: 'forge_propose_plan,forge_delegate', FORGE_WORKFLOWS: JSON.stringify((chatWs?.workflows ?? []).map(wf => ({ id: wf.id, name: wf.name, stages: wf.stages.map(s => ({ key: s.key, name: s.name })) }))) } : undefined })
    // Snapshot proposes already pending for this workspace before the turn — those belong to earlier
    // turns (fire-and-forget auto-triggers the user hasn't acted on yet) and must survive this turn.
    const preProposes = new Set(proposeRun.pendingIds(payload.workspacePath))
    try {
      const msg = await sendTurn(payload, {
        provider,
        env,
        emit: chatEmit,
        confirm,
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
      // #6/#9: the MAIN AGENT is the sole decider of whether a turn becomes a workflow. We used to
      // auto-fire proposeRun here whenever a regex (isWorkflowIntent) matched the user's TEXT but the
      // agent hadn't called forge_propose_plan — that overrode the main agent's judgment (e.g. the user
      // clicking 补充 to refine a plan in chat got a spurious, half-broken workflow confirmation) and
      // violated "一切先过主代理". That intent-guessing auto-fire stays removed.
      //
      // Chat NEVER triggers a workflow (this was the user's #1 complaint — "聊着聊着突然启动工作流").
      // forge_propose_plan's bridge callback above is neutered (redirect note + approved:false) and the
      // narrated-execution backstop that used to convert a merely-narrated "已提交方案" into a real
      // proposeRun gate has been removed entirely — the only workflow entry point now is the run2
      // launcher ("工作流运行" mode).
      return msg
    }
    finally {
      // The turn is over. If it ended while a CLI permission gate (confirm) was still open — CLI/turn
      // timeout, error, or the user moved on — drain THIS turn's confirm gates so the pet's 需确认
      // indicator (and the main-window card) don't stay stuck forever awaiting a confirm-resolved that
      // would never come. Scoped to confirm + this session so background delegate asks (which outlive
      // the turn) are untouched.
      drainChatGates(payload.workspacePath, { sessionId: payload.sessionId, type: 'confirm' })
      await bridge?.close().catch(() => {})
      // Fire-and-forget delegates outlive the main turn on their OWN bridge (the close above is the chat
      // bridge, unrelated). Keep the turn — and thus ChatQueue.busy for this workspace — alive until every
      // batch dispatched this turn completes, so a message sent mid-run QUEUES behind it instead of
      // starting a concurrent turn. In finally so it also holds when the turn ended by error/cancel after
      // dispatching. allSettled + delegate's guaranteed onComplete means this resolves, never hangs.
      if (delegateBatches.length) await Promise.allSettled(delegateBatches)
    }
  }
  const chatQueue = new ChatQueue(runTurn, broadcast)
  ipcMain.handle(CH.chatSend, (_e, payload: ChatSendPayload, source?: string) => {
    if (isArchivedWorkspace(payload.workspacePath)) throw new Error('工作区已归档，恢复后才能继续。')
    chatQueue.enqueue(payload, source ?? '你')
  })
  ipcMain.handle(CH.chatCancelQueued, (_e, a: { workspacePath: string; id: string }) => chatQueue.cancel(a.workspacePath, a.id))
  ipcMain.handle(CH.chatClearQueue, (_e, a: { workspacePath: string }) => chatQueue.clear(a.workspacePath))
  // 「停止」既停 chat 轮次,也取消该工作区所有在【后台】跑的 delegate 子代理(fire-and-forget 后它们已脱离
  // chatQueue 的 activeCancel,必须靠 delegate 自己的跨轮取消表才杀得掉,否则会留成孤儿)。
  ipcMain.handle(CH.chatStop, (_e, a: { workspacePath: string }) => {
    chatQueue.stop(a.workspacePath); cancelWorkspaceDelegates(a.workspacePath)
    // 停止 tears down the turn AND every background delegate for this ws → drain ALL their open gates
    // (confirm + ask) so no pet indicator / chat card is left stranded on a promise nobody will answer.
    drainChatGates(a.workspacePath)
  })
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
  ipcMain.handle(CH.sessionSetModel, (_e, a: { workspacePath: string; sessionId: string; agentId: string; modelId: string }) => {
    const file = setSessionModel(a.workspacePath, a.sessionId, a.agentId, a.modelId)
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
  ipcMain.handle(CH.chatResolve, (_e, a: { id: string; decision: 'allow' | 'deny' | 'modify'; value?: string; choice?: number; selection?: { stages: string[]; stageProjects: Record<string, string[]>; hooks?: string[] }; workspacePath: string }) => {
    if (proposeRun.has(a.id)) {
      proposeRun.resolve(a.id, { decision: a.decision, value: a.value, selection: a.selection })
      broadcast(CH.chatEvent, { workspacePath: a.workspacePath, sessionId: readSessions(a.workspacePath).activeSessionId, type: 'plan-resolved', id: a.id })
      return
    }
    const askResolve = chatAsks.get(a.id)
    if (askResolve) {
      chatAsks.delete(a.id)
      chatGateOwner.delete(a.id)
      askResolve({ decision: a.decision === 'modify' ? 'deny' : a.decision, value: a.value, choice: a.choice })
      broadcast(CH.chatEvent, { workspacePath: a.workspacePath, sessionId: readSessions(a.workspacePath).activeSessionId, type: 'ask-resolved', id: a.id })
      return
    }
    const resolve = chatConfirms.get(a.id)
    if (!resolve) return
    chatConfirms.delete(a.id)
    chatGateOwner.delete(a.id)
    resolve(a.decision === 'modify' ? 'deny' : a.decision)
    broadcast(CH.chatEvent, { workspacePath: a.workspacePath, sessionId: readSessions(a.workspacePath).activeSessionId, type: 'confirm-resolved', id: a.id })
  })
  // Provider-switch context summary: after the user confirms switching agent mid-session, the NEW
  // provider reads the prior conversation and produces a visible summary message (provider = toAgent,
  // so the timeline auto-inserts a provider-switch divider above it: old agent's msgs → summary).
  ipcMain.handle(CH.chatSwitchSummary, async (_e, a: { workspacePath: string; sessionId: string; toAgent: string; model: string }) => {
    const provider = providers[a.toAgent] ?? providers['claude']
    if (!provider?.chat) return
    const msgs = history(a.workspacePath, a.sessionId).filter(m => m.text?.trim())
    if (!msgs.length) return
    const env = buildAgentEnv({ proxy: readSettings().termProxy })
    const model = distillModelFor(a.toAgent) ?? a.model
    const id = `switch-sum-${Date.now()}`
    broadcast(CH.chatEvent, { workspacePath: a.workspacePath, sessionId: a.sessionId, type: 'assistant-start', id, model: '上下文总结' })
    const transcript = msgs.map(m => `${m.who === 'user' ? '用户' : '助手'}: ${m.text}`).join('\n')
    const prompt = [
      '你即将接手这段对话。先把下面的历史对话读一遍,用中文简要总结:用户目标、已确定的决策/方案、关键事实与当前进展,以便你带着上下文继续下去。',
      '历史对话:', transcript, '\n只输出总结正文,不要解释,不要提"以下是总结"之类的话。',
    ].join('\n')
    let acc = ''
    await new Promise<void>((resolve) => {
      provider.chat!({ id, prompt, model, cwd: a.workspacePath }, {
        onSession: () => {},
        onAssistantDelta: (t) => { acc += t; broadcast(CH.chatEvent, { workspacePath: a.workspacePath, sessionId: a.sessionId, type: 'assistant-delta', id, text: t }) },
        onThinkDelta: () => {},
        onDone: () => resolve(),
        onError: () => resolve(),
      }, env)
    })
    const body = acc.trim()
    const note: ChatMessage = { id, who: 'ai', text: body ? `【上下文总结 · 由 ${provider.displayName} 生成】\n${body}` : '(未能生成上下文总结,可直接继续对话)', model: '上下文总结', provider: a.toAgent, ts: new Date().toISOString() }
    appendMessage(a.workspacePath, a.sessionId, note)
    broadcast(CH.chatEvent, { workspacePath: a.workspacePath, sessionId: a.sessionId, type: 'done', message: note })
  })
  // Fold any in-flight (still-streaming) assistant message into the returned history so switching to the
  // home view / another session mid-stream and back restores the already-produced output (it isn't
  // persisted until the turn's terminal state).
  ipcMain.handle(CH.chatHistory, (_e, a: { workspacePath: string; sessionId: string }) => mergeLive(a.workspacePath, a.sessionId, history(a.workspacePath, a.sessionId)))
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
  // Read an image file's bytes → data URL for the inspector's image preview (gitFile returns text, which
  // renders binary images as garbage). Guards: known image ext, stays within cwd, size cap.
  ipcMain.handle(CH.imageFile, (_e, a: { cwd: string; file: string }): { dataUrl: string } | { error: string } => {
    try {
      const IMG_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' }
      const mime = IMG_MIME[(a.file.split('.').pop() || '').toLowerCase()]
      if (!mime) return { error: '不是支持的图片格式' }
      const abs = join(a.cwd, a.file)
      if (!abs.startsWith(a.cwd)) return { error: '路径越界' }
      if (!existsSync(abs)) return { error: '文件不存在' }
      const buf = readFileSync(abs)
      if (buf.length > 25_000_000) return { error: '图片过大(>25MB)' }
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    } catch { return { error: '读取失败' } }
  })
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
    if (r.canceled || !r.filePaths[0]) return null
    // Persist each state image to disk under the pet's folder; return { images: { state: relPath } }
    // (no data URLs) plus the folder name so the pet gets a sensible default name (authoring nicety —
    // drop a folder of state-named images and it's ready). Only idle is required; missing states fall
    // back to idle at render time.
    const dir = r.filePaths[0]
    const packed = readPetPack(dir)
    const images: Record<string, string> = {}
    for (const [state, dataUrl] of Object.entries(packed)) {
      if (!dataUrl) continue
      const rel = writePetImageFromDataUrl(petId, state, dataUrl)
      if (rel) images[state] = rel
    }
    return { name: basename(dir), images }
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

  // Codex v2 pet packs: validate + copy a pack directory into the pet store (returns a CustomPet the
  // renderer adds to customPets, mirroring petPickImage), list auto-discovered packs under ~/.codex/pets,
  // and pick-a-folder → import. Directory input only (no zip dependency).
  ipcMain.handle(CH.codexPetImport, (_e, dir: string) => importCodexPetPack(dir))
  ipcMain.handle(CH.codexPetList, () => discoverCodexPets())
  ipcMain.handle(CH.codexPetPick, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    return importCodexPetPack(r.filePaths[0])
  })

  // Background image: open a picker, store the chosen image on disk under ~/.myFlowForge/backgrounds
  // and return its forge-bg:// URL (settings.json keeps only the small URL, not multi-MB base64). No
  // tiny cap needed anymore — storeBackgroundFromPath guards against pathological files. After a
  // successful pick, GC any background file no longer referenced by settings (old image on replace).
  ipcMain.handle(CH.appearancePickBgImage, async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    })
    if (r.canceled || !r.filePaths[0]) return null
    const stored = storeBackgroundFromPath(r.filePaths[0])
    if ('error' in stored) return { error: stored.error }
    try {
      const a = readSettings().appearance
      const keep = new Set([stored.rel, bgRelFromUrl(a.bgImage), bgRelFromUrl(a.homeBgImage)].filter((x): x is string => !!x))
      gcBackgrounds(keep)
    } catch { /* GC is best-effort; a leftover file is harmless */ }
    return { url: backgroundImageUrl(stored.rel) }
  })

  // Downloadable fonts: list what's on disk (each entry carries its rewritten @font-face CSS so the
  // renderer can inject it), download a catalog font (streaming per-file progress to the caller), and
  // delete one. Downloads honour the user's configured proxy via makeProxyFetch.
  ipcMain.handle(CH.fontsListDownloaded, () => listDownloadedFonts())
  ipcMain.handle(CH.fontsDownload, async (e, id: string) => {
    const entry = catalogEntry(id)
    if (!entry) return { error: '未知字体' }
    const pf = makeProxyFetch(readSettings().termProxy)
    try {
      const font = await downloadCatalogFont(
        entry,
        (url) => pf(url),
        (done, total) => { try { e.sender.send(CH.fontsDownloadProgress, { id, done, total }) } catch { /* window may have closed */ } },
      )
      return { font }
    } catch (err) {
      return { error: err instanceof Error ? err.message : '字体下载失败' }
    }
  })
  ipcMain.handle(CH.fontsDelete, (_e, id: string) => ({ ok: deleteDownloadedFont(id) }))

  // License-gated extra content. All requests go through the user's configured proxy and carry the
  // locally-stored activation code (settings.nsfwCode); the Worker holds the real keys + image bytes.
  const nsfwFetch = () => makeContentFetch(readSettings().termProxy) // proxy-first, direct fallback
  ipcMain.handle(CH.nsfwValidate, (_e, code: string) => nsfwValidate(code, nsfwFetch()))
  ipcMain.handle(CH.nsfwCatalog, () => nsfwCatalog(readSettings().nsfwCode, nsfwFetch()))
  ipcMain.handle(CH.nsfwPreview, (_e, kind: 'pet' | 'bg', id: string) => nsfwPreview(kind, id, readSettings().nsfwCode, nsfwFetch()))
  ipcMain.handle(CH.nsfwInstallPet, (_e, petId: string, pet: NsfwPet) => nsfwInstallPet(petId, pet, readSettings().nsfwCode, nsfwFetch()))
  ipcMain.handle(CH.nsfwInstallBg, (_e, bg: NsfwBg) => nsfwInstallBg(bg, readSettings().nsfwCode, nsfwFetch()))
  // Does the local file behind a forge-bg:// URL still exist? (An installed extra bg may have been
  // GC'd; if gone, the renderer re-downloads instead of pointing at a missing file.)
  ipcMain.handle(CH.nsfwBgExists, (_e, url: string) => {
    const rel = bgRelFromUrl(url)
    const abs = rel ? resolveBackgroundAbs(rel) : null
    return { exists: !!abs && existsSync(abs) }
  })

  // Built-in wallpapers: public jsDelivr catalog + images, downloaded on demand through the user's proxy
  // and stored on disk like any uploaded background. No activation code, no Worker (so no Worker quota).
  const wallpaperFetch = () => makeContentFetch(readSettings().termProxy) // proxy-first, direct fallback (also used by pet packs)
  ipcMain.handle(CH.wallpaperCatalog, () => wallpaperCatalog(wallpaperFetch()))
  ipcMain.handle(CH.wallpaperPreview, (_e, item: WallpaperItem) => wallpaperPreview(item, wallpaperFetch()))
  ipcMain.handle(CH.wallpaperInstall, (_e, item: WallpaperItem) => wallpaperInstall(item, wallpaperFetch()))

  // Downloadable pet packs — same public jsDelivr pipeline as wallpapers, no activation code.
  ipcMain.handle(CH.petPackCatalog, () => petPackCatalog(wallpaperFetch()))
  ipcMain.handle(CH.petPackPreview, (_e, item: PetPackItem) => petPackPreview(item, wallpaperFetch()))
  ipcMain.handle(CH.petPackInstall, (_e, petId: string, item: PetPackItem) => petPackInstall(petId, item, wallpaperFetch()))

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
    // Keep every window's settings snapshot fresh so a later config:set-settings (which writes the
    // whole settings object) doesn't clobber the pins with a stale value. Mirrors workspacesSetOrder.
    broadcast(CH.settingsChanged, readSettings())
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
    cancelWorkspaceDelegates(path)   // 归档=只读封存,先停掉该工作区后台还在跑的 delegate 子代理
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
    cancelWorkspaceDelegates(path)   // 删除前先停掉后台 delegate 子代理,避免孤儿进程仍在读/写将被删的目录
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
    // Guard the TARGET path: on a fresh install a workspace is navigable before its per-project repos
    // finish cloning (or if a clone failed), so `${wsPath}/${project}` may not exist yet. Without this,
    // macOS `open` either errors with a raw English string or silently opens a near-empty folder — the
    // "新用户打不开文件" report. Give a clear localized hint instead.
    if (arg.file && !existsSync(arg.file)) {
      return { ok: false as const, error: '文件尚未就绪 —— 仓库可能还在拉取,请稍候再试' }
    }
    if (!existsSync(arg.folder)) {
      return { ok: false as const, error: '该位置尚不存在 —— 项目仓库还未拉取完成或克隆失败,请稍候或检查工作区状态' }
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

  ipcMain.handle(CH.configExportProjects, async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const r = await dialog.showSaveDialog({ title: '导出项目配置', defaultPath: `myFlowForge-projects-${stamp}.json` })
    if (r.canceled || !r.filePath) return { ok: false as const, canceled: true }
    try { await writeFile(r.filePath, JSON.stringify(readProjects(), null, 2), 'utf8'); return { ok: true as const, path: r.filePath } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
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

  // Memory management (记忆面板): read/write/clear the three tiers directly. Decoupled from the
  // memory.enabled toggle — the user can always view/edit/clear stored memory regardless of the switch.
  ipcMain.handle(CH.memoryRead, (_e, a: MemoryArg) => memoryRead(a))
  ipcMain.handle(CH.memoryWrite, (_e, a: MemoryArg) => memoryWrite(a))
  ipcMain.handle(CH.memoryClear, (_e, a: MemoryArg) => memoryClear(a))
}
