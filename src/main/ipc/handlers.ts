import { CH } from './channels'
import { type InvokeCtx, type InvokeEventLike, type MethodTable } from './invokeCtx'
import { capToolOutputs, readCap } from '../chat/toolOutputCap'
import { createTerminalService, type TerminalService } from '../terminal/terminalService'
import type { HostCapabilities } from '../host/capabilities'
import { readSettings, writeSettings, readProjects, writeProjects, readWorkflows, writeWorkflows, readHookLibrary, writeHookLibrary, readCustomStages, upsertCustomStage, deleteCustomStage, upsertProject, setProjectDefaultBranch, setProjectAlias, registerWorkspace, unregisterWorkspace, readWorkspace, writeWorkspace, readAgentsConfig, writeAgentsConfig, readWorkspaceRegistry, setStageModel, isFullAccessAcked, ackFullAccess } from '../config/store'
import { providerSupportsPermissions, permissionAppliesMidRun, permissionModeLabel, DEFAULT_PERMISSION_MODE } from '@shared/permissions'
import { expandTilde } from '../config/paths'
import { buildWorkflow } from '../config/buildWorkflow'
import { cachedDetectProviders, invalidateDetectCache } from '../agents/detectCache'
import { rebuildProviderRegistry } from '../agents/registry'
import { refreshProviderModels, setProviderModels, setProviderTimezone } from '../agents/refreshModels'
import { checkExitIp } from '../net/exitIp'
import { checkCliUpdates } from '../agents/cliLatest'
import { buildAgentEnv } from '../agents/env'
import { providerTimezone } from '../agents/providerConfig'
import { statSync, mkdirSync, writeFileSync, existsSync, readFileSync, createWriteStream } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { editWorkspace } from '../workspace/workspaceService'
import { runWorkspaceSetup, SetupCancelledError } from '../workspace/workspaceSetup'
import { scanRepos } from '../workspace/scanRepos'
import { resolveSetupInteraction } from '../workspace/setupInteractions'
import { isArchivedWorkspace } from '../workspace/archivedGuard'
import { summarizeRequirement } from '../chat/requirementSummary'
import { needsConversationDoc, buildConversationDoc, CONVERSATION_DOC_REL } from '../run/conversationDoc'
import { memoryRead, memoryWrite, memoryClear, type MemoryArg } from './memoryHandlers'
import { aggregateTokenUsage } from './tokenUsageHandlers'
import { currentGrowthSignal } from '../tokens/growthSignalRef'
import { workflowNameTaken } from '../../shared/workflowName'
import { listWorkspaces } from '../workspace/workspaceList'
import { readHomeStats } from '../workspace/homeStats'
import { sendTurn, history } from '../chat/chatService'
import { ChatQueue } from '../chat/chatQueue'
import { appendMessage, readMessages } from '../chat/chatStore'
import { withLastMessageAt } from '../chat/sessionsView'
import { mergeLive } from '../chat/liveTurns'
import { readSessions, newSession, switchSession, closeSession, renameSession, setSessionMode, setSessionPermission, setSessionModel, continueFrom, getSession, setSessionWorkflow, autoNameIfDefault } from '../chat/sessionStore'
import { buildLaunchPlan, buildLaunchProjects, hasRequirement, type LaunchStartConfig } from '../run/launch'
import { buildWorkflowSession, tailLaunchConfig, stageDocRelPath, extractProjectBriefs } from '../run/workflowEnter'
import { advanceWorkflow, type WorkflowSessionState } from '../../shared/workflowSession'
import { workflowDisplayName, pickClient, pickHost } from '../config/schema'
import { agentSessionsForId } from '../chat/agentSessions'
import { botBridge, genPairing } from '../bot/botBridge'
import { pushService } from '../push/pushService'
import type { BotBridgeConfig, BotPlatform } from '../bot/botTypes'
import { distillModelFor } from '../chat/memory/distillModel'
import type { CreateWorkspaceOpts, ChatSendPayload, ChatEvent, Attachment, AskAnswers, AskQuestion, ChangesEvent, ChatGateSnapshot, ChatMessage, SessionsFile } from '@shared/types'
import type { AgentProvider, ConfirmDecision } from '../agents/types'
import type { Settings, CustomAgent } from '../config/schema'
import { watch as chokidarWatch } from 'chokidar'
import { readChanges, readChangesMulti, readBranch } from '../git/changes'
import { perfSpan } from '../perf/perfSpans'
import { execFile } from 'node:child_process'
import { detectOpeners, resolveOpener, withoutOpener, openersCacheFile, OPENERS_CACHE_VERSION } from '../openers/detect'
import { readMacAppIcon } from '../openers/appIcon'
import { buildOpenCommand, type LaunchCommand } from '../openers/buildOpenCommand'
import { writeJsonAtomic } from '../util/atomicWrite'
import { providerCommands } from '../commands/providerCommands'
import type { DetectedOpener } from '../../shared/openers'
import { readDiff, readFile } from '../git/diff'
import { readTree } from '../fs/fileTree'
import { searchContent } from '../fs/contentSearch'
import { WorktreeWatcher } from '../watcher/worktreeWatcher'
import { RunStore } from '../run/runStore'
import { Run2Manager } from '../run/manager'
import { registerRun2 } from './run2Handlers'
import { archiveWorkspaceLifecycle, restoreWorkspaceLifecycle } from '../workspace/archiveOps'
import { deleteWorkspace, removeWorkspaceFromList, discardPartialCreation } from '../workspace/deleteOps'
import { makeRunDelegate, cancelWorkspaceDelegates } from '../chat/delegate'
import { readPetPack, readPetImage } from '../pet/petPack'
import { writePetImageFromDataUrl } from '../pet/petImageStore'
import { importCodexPetPack, discoverCodexPets } from '../pet/codexPetImport'
import { importGrowthPetPack } from '../pet/growthPetImport'
import { storeBackgroundFromPath, backgroundImageUrl, bgRelFromUrl, gcBackgrounds, resolveBackgroundAbs } from '../appearance/backgroundStore'
import { makeDiskPreviewCache, previewKeepRels } from '../appearance/previewCache'
import { listDownloadedFonts, downloadCatalogFont, deleteDownloadedFont } from '../appearance/fontStore'
import { catalogEntry } from '../../shared/fontCatalog'
import { nsfwValidate, nsfwCatalog, nsfwPreview, nsfwGallery, nsfwInstallPet, nsfwInstallBg } from '../nsfw/nsfwService'
import { wallpaperCatalog, wallpaperPreview, wallpaperInstall } from '../wallpaper/wallpaperService'
import type { WallpaperItem } from '../../shared/wallpaper'
import { petPackCatalog, petPackPreview, petPackInstall, growthPackInstall } from '../petPack/petPackService'
import { codexMarketCatalog, codexMarketPreview, codexMarketInstall } from '../codexPetMarket/service'
import type { CodexMarketPet } from '@shared/codexPetMarket'
import type { PetPackItem, GrowthPackItem } from '../../shared/petPack'
import type { NsfwPet, NsfwBg } from '../../shared/nsfw'
import { createUpdateChecker } from '../update/updateChecker'
import { fetchLatestRelease } from '../update/githubSource'
import { pickInstaller } from '../update/installer'
import { makeProxyFetch, makeContentFetch } from '../update/proxyFetch'
import { stat as fsStat, rename as fsRename, unlink as fsUnlink } from 'node:fs/promises'
import { startBridge } from '../mcp/forgeBridge'
import { removeWorkspaceSkill } from '../skills/installSkill'
import { scanWorkspaceContext } from '../agents/contextMeta'
import { scanGlobalContext } from '../agents/globalContext'
import { readInstalledSkills } from '../skills/installedSkills'
import { getAppLog, clearAppLog, formatAppLog } from '../log/appLog'
import { resolveAppIconOptions } from '../appIcon'
import { installPlugin, uninstallPlugin, setPluginEnabled, readPlugins } from '../plugins/pluginStore'
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
import { resolveFileRef } from '../fs/fileRef'
import { listDir, defaultRoots } from '../fs/browse'

/**
 * 附件落盘时避开重名:`image.png` 已存在就依次试 `image-2.png`、`image-3.png`……返回真正能用的名字。
 *
 * 只在**最后一个**点处拆基名与扩展名:`log.tar.gz` → `log.tar-2.gz`(把整块当基名会得到
 * `log.tar.gz-2`,扩展名语义就丢了)。点开头的隐藏文件(`.env`)没有扩展名,整名当基名 → `.env-2`。
 */
export function uniqueAttachmentName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const dot = name.lastIndexOf('.')
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  // 上限只是防病态循环(目录里真有上万个同名文件时别在这儿转到天荒地老),正常永远走不到。
  for (let n = 2; n < 10_000; n++) {
    const cand = `${base}-${n}${ext}`
    if (!existsSync(join(dir, cand))) return cand
  }
  return `${base}-${Date.now()}${ext}`
}

export function registerIpc(broadcast: (channel: string, payload: unknown) => void, providers: Record<string, AgentProvider>, caps: HostCapabilities, onSettings?: (s: Settings) => void, terminal?: TerminalService): MethodTable {
  const table: MethodTable = {}
  /**
   * 原地替代 `ipcMain.handle`。既有 handler 写的是 `(_e, arg) => …`,这里把 InvokeCtx 包成一个
   * 只有 `sender.send` 的假 event 喂回去 —— 于是 159 个 handler 的签名一行不用改。
   *
   * 重复注册同一个 channel 直接抛:`ipcMain.handle` 遇到重复也是抛,保持一致,
   * 而且这正是搬运期最容易犯的错(复制一段忘了改 channel 常量)。
   */
  const on = (ch: string, fn: (e: InvokeEventLike, ...args: any[]) => unknown) => {
    if (table[ch]) throw new Error(`duplicate ipc channel: ${ch}`)
    table[ch] = (ctx: InvokeCtx, ...args: unknown[]) => fn({ sender: { send: ctx.emit }, client: ctx.client }, ...args)
  }
  // Startup heal: the legacy in-memory orchestrator is gone; on a fresh launch nothing is running — any
  // session still stuck in mode:'workflow' (from a completed run before the reset fix, or an app crash
  // mid-run) is stale. Reset them to chat so their sidebar dot doesn't imply a live agent.
  for (const w of readWorkspaceRegistry()) {
    for (const s of readSessions(w.path).sessions) {
      if (s.mode === 'workflow') setSessionMode(w.path, s.id, 'chat')
    }
  }

  const mcpEntry = join(__dirname, 'forgeMcp.js')
  // AbortController for the in-flight workspace creation (one at a time), so 取消 can kill its git pulls.
  let setupAbort: AbortController | null = null

  // Run2 (P3-A): additive headless run controller, wired alongside (not replacing) the Orchestrator above.
  const run2Manager = new Run2Manager({
    providers,
    // Robustness: process.env has no proxy — networks where the CLI can't reach the API directly
    // (proxied corp networks etc.) would silently fail every run2 agent. buildAgentEnv(termProxy)
    // matches the narrator/detect/refreshModels usages elsewhere in this file (e.g. line ~105).
    env: buildAgentEnv({ proxy: readSettings().agentProxy }),
    makeStore: (w, r) => new RunStore(w, r),
    // §7.4 ③硬阻塞: same forge MCP entry the legacy Orchestrator + chat/delegate.ts already use —
    // lets each run open its own live forge bridge (RunController.setupBridge) so a stage agent can
    // call forge_ask on a hard blocker instead of only reporting via the ```forge-result``` fence.
    mcpEntry,
    emit: {
      event: (w, e) => broadcast(CH.run2Event, { workspacePath: w, event: e }),
      update: (w, s) => broadcast(CH.run2Update, { workspacePath: w, state: s }),
      log: (w, l) => broadcast(CH.run2Log, { workspacePath: w, log: l }),
      // Task 1 (queue): lets the renderer show "N runs queued" for a busy workspace.
      queue: (w, info) => broadcast(CH.run2Queue, { workspacePath: w, length: info.length }),
    },
    onError: (w, err) => console.error(`[run2] ${w}:`, err),
    // When a run finishes, drain any chat turns the user queued while it ran. Deferred closure — chatQueue
    // is declared below (line ~570) but this only fires at run-completion time, long after it's inited.
    onRunDone: (w) => chatQueue.runDone(w),
  })
  const run2 = registerRun2({
    manager: run2Manager, onInvoke: (ch, h) => on(ch, h as never),
    readWorkspace, readWorkflows: () => readWorkflows().workflows, readCustomStages: () => readCustomStages().stages,
  })

  const UPDATE_REPO = 'flowForges/myFlowForge'
  const updateChecker = createUpdateChecker({
    repo: UPDATE_REPO,
    currentVersion: () => caps.version(),
    // proxy-THEN-direct: the update check must survive a down/misrouted/socks proxy (settings.agentProxy).
    // makeProxyFetch had no direct fallback, so any proxy hiccup → throw → 永久「检查失败」even when GitHub
    // is directly reachable. makeContentFetch tries the proxy then falls back to a direct fetch.
    fetchLatest: (r) => fetchLatestRelease(r, { fetch: makeContentFetch(readSettings().agentProxy) as (url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<any> }>, platform: process.platform, arch: process.arch }),
    emit: broadcast,
    setTimeout: (fn, ms) => { setTimeout(fn, ms) },
    setInterval: (fn, ms) => { setInterval(fn, ms) },
  })
  updateChecker.start()

  on(CH.updateGet, () => ({ currentVersion: caps.version(), info: updateChecker.current() }))
  on(CH.updateCheck, () => { void updateChecker.check(true) })
  on(CH.updateStart, async () => {
    const info = updateChecker.current()
    if (!info) return
    const installer = pickInstaller({
      fetch: (url, init) => makeContentFetch(readSettings().agentProxy)(url, init as any) as any,
      openPath: caps.openPath,
      showItemInFolder: caps.revealInFileManager,
      join,
      tmpDir: caps.tempDir(),
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
  on(CH.workspaceSetupResolve, (_e, a: { id: string; answer: { decision?: 'allow' | 'deny'; value?: string } }) => {
    resolveSetupInteraction(a.id, a.answer)
  })
  on(CH.configGetSettings, () => readSettings())
  on(CH.configSetSettings, (_e, settings) => {
    writeSettings(settings)
    const s = readSettings()
    broadcast(CH.settingsChanged, s)
    onSettings?.(s)
    return s
  })

  // ── 设置的两个半边(第二期 C)。路由器用它们组合出上面那对:
  //    跟设备的永远本机答,跟机器的跟着当前 host 走。
  on(CH.configGetHostSettings, () => pickHost(readSettings()))
  // Q7:后写的赢 + 广播 + 说清是谁改的。只有「不是本机改的」才发 —— 自己改自己的不用告诉自己。
  const noteSettingsWriter = (e: { client?: { id: string; label: string } } | undefined) => {
    if (e?.client && e.client.id !== 'local') broadcast(CH.settingsChangedBy, { by: e.client.label })
  }
  on(CH.configSetHostSettings, (_e, patch: Partial<Settings>) => {
    // 只写这一半。★不能整份写回去 —— 远程客户端手里那份「跟设备」的字段是**它自己**的
    // (它的主题、它的壁纸),整份写会把这台机器的客户端设置覆盖成远程那台设备的。
    const next = { ...readSettings(), ...pickHost(patch as Settings) }
    writeSettings(next)
    const s = readSettings()
    broadcast(CH.settingsChanged, s)
    noteSettingsWriter(_e)
    onSettings?.(s)
    return pickHost(s)
  })
  on(CH.configGetClientSettings, () => pickClient(readSettings()))
  on(CH.configSetClientSettings, (_e, patch: Partial<Settings>) => {
    const next = { ...readSettings(), ...pickClient(patch as Settings) }
    writeSettings(next)
    const s = readSettings()
    broadcast(CH.settingsChanged, s)
    onSettings?.(s)
    return pickClient(s)
  })
  on(CH.appIconOptions, () => resolveAppIconOptions({
    resourcesPath: process.resourcesPath,
    appPath: caps.appPath() ?? '',
    isPackaged: caps.isPackaged(),
  }))
  on(CH.configListProjects, () => readProjects().projects)
  on(CH.configAddProject, (_e, input: { repoUrl: string; branch: string; alias?: string }) => upsertProject(input))
  on(CH.configDeleteProject, (_e, id: string) => {
    writeProjects({ projects: readProjects().projects.filter(p => p.id !== id) })
    return readProjects().projects
  })
  on(CH.configUpdateProjectBranch, (_e, input: { id: string; branch: string }) => setProjectDefaultBranch(input.id, input.branch))
  on(CH.configUpdateProjectAlias, (_e, input: { id: string; alias: string }) => setProjectAlias(input.id, input.alias))
  on(CH.configListWorkflows, () => readWorkflows().workflows)
  on(CH.configAddWorkflow, (_e, input: { name: string; stages: import('../config/buildWorkflow').StageSeed[] }) => {
    const list = readWorkflows().workflows
    // Enforce unique display names (the UI blocks this too; this is the safety net). Duplicate =
    // no-op returning the current list, so a bypassed UI can't silently create a confusing twin.
    if (workflowNameTaken(input.name, list.map(w => w.name))) return list
    const wf = buildWorkflow(input.name, input.stages, list.map(w => w.id))
    writeWorkflows({ workflows: [...list, wf] })
    return readWorkflows().workflows
  })
  on(CH.configDeleteWorkflow, (_e, id: string) => {
    writeWorkflows({ workflows: readWorkflows().workflows.filter(w => w.id !== id) })
    return readWorkflows().workflows
  })
  on(CH.configUpdateWorkflow, (_e, input: { id: string; plugins?: import('../config/schema').Plugin[]; stagePrompts?: Record<string, string>; stages?: import('../config/schema').Workflow['stages'] }) => {
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
  on(CH.hookLibraryList, () => readHookLibrary().hooks)
  on(CH.hookLibrarySave, (_e, hook: import('../config/schema').LibraryHook) => {
    const list = readHookLibrary().hooks
    const next = list.some(h => h.id === hook.id) ? list.map(h => h.id === hook.id ? hook : h) : [...list, hook]
    writeHookLibrary({ hooks: next })
    return readHookLibrary().hooks
  })
  on(CH.hookLibraryDelete, (_e, id: string) => {
    writeHookLibrary({ hooks: readHookLibrary().hooks.filter(h => h.id !== id) })
    return readHookLibrary().hooks
  })
  on(CH.hookLibrarySetAll, (_e, hooks: import('../config/schema').LibraryHook[]) => {
    writeHookLibrary({ hooks })
    return readHookLibrary().hooks
  })
  // --- Global custom-stage library (定义一次,被多个工作流模版按 libId 引用,编辑一次处处生效) ---
  on(CH.customStagesList, () => readCustomStages().stages)
  on(CH.customStagesUpsert, (_e, def: Partial<import('../config/schema').CustomStage> & { name: string }) => {
    const list = upsertCustomStage(def)
    broadcast(CH.customStagesChanged, list)
    return list
  })
  on(CH.customStagesDelete, (_e, id: string) => {
    const list = deleteCustomStage(id)
    broadcast(CH.customStagesChanged, list)
    return list
  })
  // Cached: concurrent callers share one probe, results live 60s. `force` (重新检测) re-probes AND
  // honors the result (trustPersisted:false) so it can clear a genuinely-gone CLI; a normal detect keeps
  // last-known-good agents sticky so a slow cold-start probe never makes them vanish.
  on(CH.agentsDetect, (_e, opts?: { force?: boolean }) =>
    cachedDetectProviders(providers, buildAgentEnv({ proxy: readSettings().agentProxy }), { force: opts?.force === true, trustPersisted: opts?.force !== true }))
  // "有新版" 提示(只提示):安装版本由 detect 探测,这里查各 CLI 的 npm latest 并比对。走 termProxy(undici
  // 不认 HTTP_PROXY 环境变量),失败/未知包静默略过 —— 提示是锦上添花,绝不能拖垮或报错阻塞设置页。
  on(CH.agentsCliUpdates, (_e, installed: { id: string; version?: string }[]) =>
    checkCliUpdates(installed ?? [], makeProxyFetch(readSettings().agentProxy), Date.now()))
  // Registry just changed (bin override / custom agent add-remove) — bypass the cache but stay sticky
  // (trustPersisted) so a transient probe failure during the rebuild doesn't wipe known-good agents.
  const redetect = () => cachedDetectProviders(providers, buildAgentEnv({ proxy: readSettings().agentProxy }), { force: true, trustPersisted: true })
  on(CH.agentsGetConfig, () => readAgentsConfig())
  on(CH.agentsSetBin, (_e, a: { id: string; bin: string }) => {
    const cfg = readAgentsConfig()
    const existing = cfg.providers.find(p => p.id === a.id)
    const providersCfg = [
      ...cfg.providers.filter(p => p.id !== a.id),
      { id: a.id, binOverride: a.bin.trim(), env: existing?.env ?? {}, modelsCache: existing?.modelsCache ?? [], modelsFetchedAt: existing?.modelsFetchedAt ?? 0, customModels: existing?.customModels ?? [] },
    ]
    writeAgentsConfig({ ...cfg, providers: providersCfg })
    rebuildProviderRegistry(providers)   // mutate in place so orchestrator/handlers see new bins
    return redetect()
  })
  on(CH.agentsAddCustom, (_e, c: CustomAgent) => {
    const cfg = readAgentsConfig()
    writeAgentsConfig({ ...cfg, custom: [...cfg.custom.filter(x => x.id !== c.id), c] })
    rebuildProviderRegistry(providers)
    return redetect()
  })
  on(CH.agentsRemoveCustom, (_e, id: string) => {
    const cfg = readAgentsConfig()
    writeAgentsConfig({ ...cfg, custom: cfg.custom.filter(x => x.id !== id) })
    rebuildProviderRegistry(providers)
    return redetect()
  })
  on(CH.agentsRefreshModels, async (_e, providerId: string) => {
    const r = await refreshProviderModels(providerId, providers, buildAgentEnv({ proxy: readSettings().agentProxy }))
    invalidateDetectCache()   // models cache changed on disk — cached ProviderInfo[] is stale
    return r
  })
  on(CH.agentsSetModels, (_e, a: { id: string; models: { id: string; label: string; description?: string }[] }) => {
    const r = setProviderModels(a.id, a.models)
    invalidateDetectCache()   // ditto: edited model list must show up on the next detect
    return r
  })
  on(CH.agentsSetTimezone, (_e, a: { id: string; timezone: string }) => {
    setProviderTimezone(a.id, a.timezone)
    invalidateDetectCache()   // detect surfaces provCfg.timezone → refresh so the UI reflects the change
  })
  on(CH.netCheckExitIp, () => checkExitIp(readSettings().agentProxy))
  on(CH.contextScan, (_e, workspacePath?: string) => {
    if (workspacePath && existsSync(workspacePath)) return scanWorkspaceContext(workspacePath, true)
    return { skills: [], rules: [], mcps: [{ name: 'forge', path: 'mcp://forge', reason: 'Forge workflow tools', state: 'ok' }] }
  })
  on(CH.contextScanGlobal, () => scanGlobalContext())
  on(CH.skillsList, () => readInstalledSkills())
  on(CH.commandsList, (_e, providerId: string, wsPath?: string) => providerCommands(providerId, wsPath))
  on(CH.workspaceCreate, async (_e, opts: CreateWorkspaceOpts) => {
    const knownProjects = readProjects().projects
    const proxy = readSettings().agentProxy
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
  on(CH.workspaceCancelSetup, () => { setupAbort?.abort() })
  on(CH.workspaceDiscardPartial, (_e, path: string) => discardPartialCreation(expandTilde(path)))
  on(CH.workspaceGet, (_e, path: string) => readWorkspace(path))
  on(CH.workspaceScanRepos, (_e, path: string) => scanRepos(path))
  // P4.1(2026-07-30):wsSetAutoDecide 已删除(autoDecide 随提案门一并废除)。
  on(CH.workspaceSetStageModel, (_e, a: { path: string; stageKey: string; provider: string; model: string }) => {
    setStageModel(a.path, a.stageKey, a.provider, a.model)
  })
  // Quick alias rename — just the display name (registry + workspace.json), no re-provisioning.
  on(CH.workspaceRename, (_e, a: { path: string; name: string }) => {
    const name = a.name.trim()
    if (!name) return
    const path = expandTilde(a.path)
    registerWorkspace(name, path)
    const ws = readWorkspace(path)
    if (ws) writeWorkspace({ ...ws, name })
    broadcast(CH.workspacesChanged, {})
  })
  on(CH.workspaceEdit, async (_e, a: { path: string; opts: CreateWorkspaceOpts; runProjHooks?: boolean }) => {
    if (isArchivedWorkspace(a.path)) throw new Error('工作区已归档，恢复后才能继续。')
    const result = await editWorkspace({
      path: a.path, opts: a.opts, knownProjects: readProjects().projects, proxy: readSettings().agentProxy,
      emit: (ev) => broadcast(CH.workspaceSetup, ev),
      runProjHooks: a.runProjHooks, providers,
    })
    broadcast(CH.workspacesChanged, {})
    return result
  })
  const chatEmit = (e: ChatEvent) => {
    broadcast(CH.chatEvent, e)
    // 一轮结束后重播一次会话列表。lastMessageAt 是按消息文件 mtime 现算的,而写消息本身不会产生任何
    // sessions 事件 —— 不补这一下,侧栏那一行的时间会一直停在上次拉取列表时的值(一个刚跑完的会话仍显示
    // 几天前),直到用户碰巧做了个新建/切换/改名。done 和 error 都是终态,两者互斥。
    if (e.type === 'done' || e.type === 'error') {
      try { broadcastSessions(e.workspacePath, readSessions(e.workspacePath)) } catch { /* 会话文件读不到就算了,不能拖累事件广播 */ }
    }
  }
  // ConfirmDecision(而不是光 'allow'|'deny'):带选项的门(claude AskUserQuestion)要把用户选了什么一起送回
  // provider —— 只回 allow 等于什么都没答,模型会收到「没等到回复」。
  const chatConfirms = new Map<string, (decision: ConfirmDecision) => void>()
  /**
   * 最近被答掉的门:id → 谁答的、答了什么、在哪个会话。
   *
   * ★这是「先回先算」在多客户端下唯一会骗人的地方(设计文档 7.2 第 1 条)。
   * 手机点了「允许」,电脑上的卡片消失前有几百毫秒 —— 电脑前的人完全可能在这期间点了「拒绝」。
   * 现在的代码拿不到 resolver 就直接 return,**他会以为自己拦住了那条 `rm -rf`,其实已经放行了**。
   * 记下来,好在第二个答案落空时**当面告诉他**。
   */
  const recentlyResolved = new Map<string, { by: string; decision: string; ws: string; sessionId: string; ts: number }>()
  const rememberResolved = (id: string, by: string, decision: string, ws: string, sessionId: string) => {
    recentlyResolved.set(id, { by, decision, ws, sessionId, ts: Date.now() })
    // 只留最近 50 条 —— 迟到的答案都是几百毫秒级的,留久了没意义,还白占内存。
    if (recentlyResolved.size > 50) {
      const oldest = [...recentlyResolved.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
      if (oldest) recentlyResolved.delete(oldest[0])
    }
  }
  const DECISION_CN: Record<string, string> = { allow: '允许', deny: '拒绝', modify: '修改' }
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
  // 除了 ws/session/type,还要留下【重建卡片所需的全部内容】(标题、目标、选项、提出时间)——
  // 见 CH.chatGateState:聊天视图重新挂载后要靠这份快照把卡片画回来,只记住"有一个门"是不够的。
  // ts 也必须留:卡片在时间线里按 ts 排序,重建时用原始时间才会落回它原来的位置。
  type GateMeta = {
    ws: string
    sessionId: string
    type: 'confirm' | 'ask'
    ts: string
    title: string
    where?: string
    options?: { t: string; d: string }[]
    // AskUserQuestion 的问题/选项:重建卡片时必须一起还原,否则重挂后又退回成那张没选项的空确认卡。
    questions?: AskQuestion[]
    agentName?: string
  }
  const chatGateOwner = new Map<string, GateMeta>()
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
      chatGateOwner.set(id, { ws: wsPath, sessionId, type: 'ask', ts: new Date().toISOString(), title: question, options, agentName })
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

  // ── 权限档在【运行中】切换的即时兑现 ────────────────────────────────────────────────────────
  // permissionMode 只在进程启动那一刻被翻译成 CLI 沙箱参数(agents/permissionArgs.ts),进程起来后沙箱就
  // 钉死了 —— 所以运行中切换默认只能等【下一轮】。唯一还能半途兑现的通道是 CLI 主动升起的确认门:门是
  // 我们答的,我们答 allow,CLI 就照做。于是权限档在门上要被【重新读一次】,而不是沿用起跑时的那个值。
  //
  // ★ 但带 questions 的门必须排除:那不是权限请求,是模型在【问人】(AskUserQuestion 借 can_use_tool 通道
  //   伪装成权限请求发出来)。自动 allow 会带着空 answers 回去,CLI 转头告诉模型「用户没有回答」——
  //   正是 3c899d3 修掉的那个 bug。
  const autoAllowable = (g: { questions?: AskQuestion[] }) => !g.questions?.length
  const gateWhere = (g: { title: string; where?: string }) => `${g.title}${g.where ? ` · ${g.where}` : ''}`

  const emitNote = (wsPath: string, sessionId: string, noteText: string) => {
    const id = `sys-${Date.now()}`
    broadcast(CH.chatEvent, { workspacePath: wsPath, sessionId, type: 'assistant-start', id, model: '系统' })
    const note: ChatMessage = { id, who: 'ai', text: noteText, model: '系统', ts: new Date().toISOString().slice(11, 19) }
    appendMessage(wsPath, sessionId, note)
    broadcast(CH.chatEvent, { workspacePath: wsPath, sessionId, type: 'done', message: note })
  }

  // 用户在门【已经挂在屏幕上】的时候才切到「完全访问」(被问烦了才去切,这才是真实场景)——把该会话所有
  // 挂起的确认门就地放行,卡片当场消失。只碰 confirm 门:ask 门是子代理在问人,与权限档无关。
  const allowPendingConfirms = (wsPath: string, sessionId: string, by = '本机') => {
    for (const [id, meta] of [...chatGateOwner]) {
      if (meta.ws !== wsPath || meta.sessionId !== sessionId || meta.type !== 'confirm') continue
      if (!autoAllowable(meta)) continue
      const r = chatConfirms.get(id)
      if (!r) continue
      chatGateOwner.delete(id)
      chatConfirms.delete(id)
      r('allow')
      broadcast(CH.chatEvent, { workspacePath: wsPath, sessionId, type: 'confirm-resolved', id })
      rememberResolved(id, by, 'allow', wsPath, sessionId)
      // ★把「是谁切的」写进去。别的设备切了完全访问,这台机器上挂着的门会**当场凭空消失** ——
      //   不说清楚的话,电脑前的人只会觉得界面出了鬼。
      emitNote(wsPath, sessionId, by === '本机'
        ? `🛡 已切到「完全访问」，自动放行：${gateWhere(meta)}`
        : `🛡 「${by}」切到了「完全访问」，自动放行：${gateWhere(meta)}`)
    }
  }
  // 权限档的唯一写入口(IPC 与机器人桥共用):落盘 + 广播 + 若切到 full 就排空挂起的门 + 该说的说清楚。
  const applyPermission = (wsPath: string, sessionId: string, mode: import('@shared/permissions').PermissionMode, by = '本机') => {
    const prev = getSession(wsPath, sessionId)?.permissionMode ?? DEFAULT_PERMISSION_MODE
    const file = setSessionPermission(wsPath, sessionId, mode)
    broadcastSessions(wsPath, file)
    if (mode === 'full') allowPendingConfirms(wsPath, sessionId, by)
    // 运行中改档,但这个 provider 的沙箱是启动参数、进程起来就钉死了(见 agents/permissionArgs.ts)——
    // 不说一声,用户只会以为「我切了但没反应 = 这功能坏了」。
    // 不提示的两种情况:① claude 切到完全访问,门重读后当场就兑现了;② cursor 这类压根不吃权限档的
    // provider —— 对它们说「下一条消息生效」是骗人的,它永远不生效(picker 上已经标了"不支持")。
    const running = chatQueue.runningProvider(wsPath, sessionId)
    if (running && providerSupportsPermissions(running) && !permissionAppliesMidRun(running, mode)) {
      const who = providers[running]?.displayName ?? running
      emitNote(wsPath, sessionId,
        `🛡 已切到「${permissionModeLabel(mode)}」· ${who} 不支持运行中改档，当前这一轮仍按「${permissionModeLabel(prev)}」跑完，下一条消息才生效。`)
    }
    return file
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

  // Lightweight delegation (path A): the chat agent dispatches sub-agents into projects without the
  // workflow gate. Runs are ephemeral (no run slot). The legacy orchestrator + its chat-triggered
  // proposeRun gate are gone — the only workflow-run entry point is now the run2 「工作流运行」launcher.
  const runDelegate = makeRunDelegate({ providers, proxy: () => readSettings().agentProxy, mcpEntry, readWorkspace })
  const runTurn = async (payload: ChatSendPayload) => {
    removeWorkspaceSkill(payload.workspacePath)   // pure chat (P5 T1): forge-workflow skill has no reader anymore
    const provider = providers[payload.agent] ?? providers['claude'] ?? Object.values(providers)[0]
    const confirm = (req: { title: string; where?: string; questions?: AskQuestion[] }) => new Promise<ConfirmDecision>((resolve) => {
      const id = `cc-${++chatConfirmSeq}`
      chatConfirms.set(id, resolve)
      chatGateOwner.set(id, { ws: payload.workspacePath, sessionId: payload.sessionId, type: 'confirm', ts: new Date().toISOString(), title: req.title, where: req.where, questions: req.questions })
      broadcast(CH.chatEvent, { workspacePath: payload.workspacePath, sessionId: payload.sessionId, type: 'confirm-request', id, title: req.title, where: req.where, questions: req.questions })
    })
    // CLI 的逐操作确认门专用出口:升门【之前】先读一次会话当前的权限档,已经是「完全访问」就直接放行,
    // 卡片根本不弹(用户切到 full 的意思就是「别再问我」)。留一行审计痕迹,不做无声放行。
    //
    // ★ 只给 provider 的逐操作门用,不能给下面那个「无沙箱 provider 预授权门」用:那个门已经自己按
    //   payload.permissionMode !== 'full' 守过了,再叠一层等于替用户默默写下 fullAccessAck ——
    //   那是另一件事的授权,不是同一件。
    const toolConfirm = (req: { title: string; where?: string; questions?: AskQuestion[] }): Promise<ConfirmDecision> => {
      if (autoAllowable(req) && getSession(payload.workspacePath, payload.sessionId)?.permissionMode === 'full') {
        emitNote(payload.workspacePath, payload.sessionId, `🛡 已按当前权限档「完全访问」自动放行：${gateWhere(req)}`)
        return Promise.resolve('allow')
      }
      return confirm(req)
    }
    // Pre-run consent gate: providers with no sandbox dimension (cursor/gemini/opencode/qwen/copilot)
    // ignore the permission档 and run with blanket full access (--force/--allow-all-tools/--yolo). Make
    // that explicit — ask ONCE per (workspace, provider), remember an allow. 'full' mode = the user
    // already chose full access, so skip. Interactive/sandboxed providers (claude/codex/qoder) don't hit this.
    // Classify by payload.agent — the selected provider id, always present — NOT provider.id, which
    // requires the provider object to be resolved (undefined when providers is empty). Label falls back
    // to the id if the provider object isn't available.
    const gateProviderId = payload.agent
    const gateLabel = provider?.displayName ?? payload.agent
    if (!providerSupportsPermissions(gateProviderId) && payload.permissionMode !== 'full'
        && !isFullAccessAcked(payload.workspacePath, gateProviderId)) {
      const decision = await confirm({
        title: `${gateLabel} 无法逐操作确认，本次将以「完全访问」运行（可修改任意文件、可联网）。是否授权？（本工作区将记住）`,
      })
      if (decision !== 'allow') {
        emitNote(payload.workspacePath, payload.sessionId, `已取消：未授权 ${gateLabel} 以完全访问运行。`)
        return
      }
      ackFullAccess(payload.workspacePath, gateProviderId)
      // Keep the renderer's in-memory settings snapshot in sync — otherwise its next config:set-settings
      // (any UI settings save) writes back a stale fullAccessAck and wipes this ack. Mirrors the
      // pinnedWorkspaces/workspaceOrder writers in this file.
      broadcast(CH.settingsChanged, readSettings())
    }
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
          onSession: (s) => chatQueue.registerActive(payload.workspacePath, payload.sessionId, () => s.cancel()),
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
    // Pure chat (P5 Task 1): the chat agent gets NO forge overrides — no FORGE_SOCKET/FORGE_TOOLS/
    // FORGE_WORKFLOWS — so it has no forge MCP tools (forge_propose_plan/forge_delegate) for ANY
    // provider, and forgeChatDirective(env) (gated on env.FORGE_TOOLS containing forge_propose_plan)
    // returns '' automatically. Workflows only launch via the explicit run2 "工作流运行" launcher now.
    const env = buildAgentEnv({ proxy: readSettings().agentProxy, timezone: providerTimezone(payload.agent) })
    try {
      const msg = await sendTurn(payload, {
        provider,
        env,
        emit: chatEmit,
        confirm: toolConfirm,
        onSessionStart: (session) => chatQueue.registerActive(payload.workspacePath, payload.sessionId, () => session.cancel()),
      })
      // Chat NEVER triggers a workflow (this was the user's #1 complaint — "聊着聊着突然启动工作流").
      // forge_propose_plan's bridge callback above is neutered (redirect note + approved:false); the
      // legacy proposeRun gate has been removed entirely — the only workflow entry point now is the run2
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
  on(CH.chatSend, (_e, payload: ChatSendPayload, source?: string) => {
    if (isArchivedWorkspace(payload.workspacePath)) throw new Error('工作区已归档，恢复后才能继续。')
    /**
     * 这一轮是从哪台设备发的。
     *
     * ★★**由这里填,不读 payload 里客户端自报的那个**:自报等于任何一个连上来的客户端
     *  都能把自己写成别人,而这条标记的全部价值就是「可信地说清是谁发的」。
     * ★本机窗口(`id === 'local'`)**不填** —— 没有标记就是「在这台机器上敲的」。
     *  常见情况下一个字节都不多存,界面上也一个像素都不多画。
     */
    const via = _e?.client && _e.client.id !== 'local' ? _e.client.label : undefined
    chatQueue.enqueue({ ...payload, via }, source ?? '你')
  })
  on(CH.chatQueueState, (_e, a: { workspacePath: string }) => chatQueue.snapshot(a.workspacePath))
  // 还挂着的确认/提问门快照。聊天视图每次挂载都拉一次,把主进程仍在阻塞等待的门重建成卡片。
  // 不做任何清理:这里只是【读】,门的生命周期仍由回答 / drainChatGates 负责。
  on(CH.chatGateState, (_e, a: { workspacePath: string }): ChatGateSnapshot => {
    // chatGateOwner 就是「还挂着的门」的单一事实源:每条解析路径(chatResolve / resolveChatGateById /
    // drainChatGates)都把 owner 和 resolver 一起删,而 drain 还会在没有 resolver 时也删 owner ——
    // 所以 owner 恒是更严格的那一边,不需要再拿 chatConfirms/chatAsks 复核一遍。
    // (原先写了这么一道复核,变异测试证明它永远为真、删掉全绿 = 不可达的防御分支,已去掉。)
    const snap: ChatGateSnapshot = { confirms: [], asks: [] }
    for (const [id, m] of chatGateOwner) {
      if (m.ws !== a.workspacePath) continue
      if (m.type === 'confirm') snap.confirms.push({ id, sessionId: m.sessionId, title: m.title, where: m.where, questions: m.questions, ts: m.ts })
      else snap.asks.push({ id, sessionId: m.sessionId, title: m.title, options: m.options, agentName: m.agentName, ts: m.ts })
    }
    return snap
  })
  // 跨设备未读:某个客户端打开了一条会话 → 告诉所有别的客户端「这条被看过了」。
  // ★纯转发,不留状态:这条 channel 存在的全部理由就是「手机上读了,电脑上那颗圆点也该灭」。
  //  空 workspacePath / sessionId 直接丢掉 —— 切主机那一瞬客户端的 viewing 就是两个空串,
  //  广播出去每台设备都会拿空 key 去 clearUnread,虽然无害但是一条纯噪音。
  on(CH.chatMarkSeen, (_e, a: { workspacePath: string; sessionId: string }) => {
    if (!a?.workspacePath || !a?.sessionId) return
    broadcast(CH.chatSeen, { workspacePath: a.workspacePath, sessionId: a.sessionId })
  })
  on(CH.chatCancelQueued, (_e, a: { workspacePath: string; id: string }) => chatQueue.cancel(a.workspacePath, a.id))
  on(CH.chatClearQueue, (_e, a: { workspacePath: string }) => chatQueue.clear(a.workspacePath))
  // 「停止」只停当前【会话】的轮次 + 它派发的后台 delegate 子代理 + 它挂起的门(confirm/ask),不动同工作区里
  // 并发跑着的另一个会话(fire-and-forget 的子代理已脱离 chatQueue 的 activeCancel,必须靠 delegate 自己的跨轮
  // 取消表才杀得掉,否则会留成孤儿)。省略 sessionId(如宠物的工作区级停止)仍是「取消这个工作区的全部」。
  on(CH.chatStop, (_e, a: { workspacePath: string; sessionId?: string }) => {
    // Normalize once so all three stop ops treat "no session" identically — an empty-string sessionId
    // (should never reach here, real ids are non-empty) would otherwise be "defined" to stop()/delegates
    // but falsy to drainChatGates, diverging their scope.
    const sid = a.sessionId || undefined
    chatQueue.stop(a.workspacePath, sid); cancelWorkspaceDelegates(a.workspacePath, sid)
    drainChatGates(a.workspacePath, sid ? { sessionId: sid } : {})
  })
  // 给每个会话附加派生的 lastMessageAt(消息文件 mtime),供侧栏会话列表显示「最后对话时间」而非首次开始时间。
  // 不写回 sessions.json(保持存储干净;每次读时按文件重新派生)。
  //
  // ★ 必须在**每一个**会话出口上都补,不能只补 session:list:侧栏的列表还会被 sessions:changed 广播、以及
  // sessionNew/Switch/Close/Rename 的返回值**整个替换**(见 useSessions / useSessionsMulti,它们都是直接
  // setState(payload))。漏掉任一出口,那条路径送出去的会话就没有 lastMessageAt,侧栏回落 createdAt ——
  // 而切会话是高频操作,于是几乎总是显示创建时间。所以统一走下面这两个出口函数,不要再手写裸 broadcast。
  const sessionsOut = (wsPath: string, file: SessionsFile): SessionsFile => withLastMessageAt(wsPath, file)
  const broadcastSessions = (wsPath: string, file: SessionsFile): void => {
    broadcast(CH.sessionsChanged, { workspacePath: wsPath, file: sessionsOut(wsPath, file) })
  }
  on(CH.sessionList, (_e, wsPath: string) => sessionsOut(wsPath, readSessions(wsPath)))
  on(CH.sessionNew, (_e, wsPath: string) => {
    if (isArchivedWorkspace(wsPath)) throw new Error('工作区已归档，恢复后才能继续。')
    const file = newSession(wsPath)
    broadcastSessions(wsPath, file)
    return sessionsOut(wsPath, file)
  })
  on(CH.sessionSwitch, (_e, a: { workspacePath: string; sessionId: string }) => {
    const file = switchSession(a.workspacePath, a.sessionId)
    broadcastSessions(a.workspacePath, file)
    return sessionsOut(a.workspacePath, file)
  })
  on(CH.sessionClose, (_e, a: { workspacePath: string; sessionId: string }) => {
    const file = closeSession(a.workspacePath, a.sessionId)
    broadcastSessions(a.workspacePath, file)
    return sessionsOut(a.workspacePath, file)
  })
  on(CH.sessionRename, (_e, a: { workspacePath: string; sessionId: string; title: string }) => {
    const file = renameSession(a.workspacePath, a.sessionId, a.title)
    broadcastSessions(a.workspacePath, file)
    return sessionsOut(a.workspacePath, file)
  })
  on(CH.sessionSetPermission, (_e, a: { workspacePath: string; sessionId: string; mode: import('@shared/permissions').PermissionMode }) => {
    return sessionsOut(a.workspacePath, applyPermission(a.workspacePath, a.sessionId, a.mode, _e?.client?.label ?? '本机'))
  })
  on(CH.sessionSetModel, (_e, a: { workspacePath: string; sessionId: string; agentId: string; modelId: string }) => {
    const file = setSessionModel(a.workspacePath, a.sessionId, a.agentId, a.modelId)
    broadcastSessions(a.workspacePath, file)
    return sessionsOut(a.workspacePath, file)
  })
  // 对话式工作流(2026-07-30):enter=把选定工作流配置固化成 session 上的 WorkflowSessionState(停在阶段0,
  // 不自动跑);advance=推进到下一阶段(跨进扇出阶段时用 run2 的 launchRun 启动执行尾段 run,记下 runId);
  // exit=清除工作流状态、退回普通会话。全部复用 P1 已打通的 buildLaunchPlan/权限透传。
  // 图3修复:进入一个"对话阶段"时自动起手一轮 —— 让该阶段的 provider 按本阶段(内置/自定义)prompt 跑一次,
  // 产出交付物(如技术方案)并**在回复里完整展示**供用户审阅,而不是要用户先自己开口它才动、也不是只写进文件
  // 用户看不到。kick 文案显式要求"回复里展示",压过内置 prompt 里"放进 artifact 别只写回复"的下游导向。
  const kickConversationalStage = (workspacePath: string, sessionId: string, ws: WorkflowSessionState) => {
    if (ws.phase !== 'chatting') return
    const stage = ws.stages[ws.currentIndex]
    if (!stage || !stage.provider) return
    // 把选定项目列表告诉对话阶段的 agent —— 尤其技术方案阶段要据此产出「各项目任务分工」(见 STAGE_PROMPTS.design)。
    const projNote = ws.projects.length
      ? `\n\n本工作流涉及以下项目/仓库:${ws.projects.map((p) => p.name).join('、')}。若本步产出技术方案,请据此为每个项目单列任务分工。`
      : ''
    chatQueue.enqueue({
      workspacePath, sessionId,
      agent: stage.provider,
      agentLabel: providers[stage.provider]?.displayName ?? stage.provider,
      model: stage.model,
      text: `请开始「${stage.name}」这一步:按本阶段要求完成工作,并在你的回复里**完整展示**交付物(如方案/清单)供我审阅;如涉及落盘也可同时写成文件。完成后我会审阅、必要时追问,然后我再点「下一步」进入下一阶段。${projNote}`,
      attachments: [],
      permissionMode: stage.permissionMode ?? 'auto',
    }, '工作流')
  }
  on(CH.workflowEnter, (_e, p: LaunchStartConfig) => {
    if (!p.sessionId) throw new Error('workflow:enter 缺少 sessionId')
    // 什么都没说就不许启动 —— 否则阶段 agent 只拿到一串项目名,会自己猜一个需求出来跑一堆东西。
    // 这道必须在主进程:「⚡自动」那条路不经过启动门的按钮。
    if (!hasRequirement(p)) throw new Error('还不知道这次要做什么:先说一句需求(或在启动卡的补充说明里写一句)再启动工作流。')
    const ws = readWorkspace(p.workspacePath)
    if (!ws) throw new Error(`工作区不存在: ${p.workspacePath}`)
    const plan = buildLaunchPlan(p, ws, readWorkflows().workflows, readCustomStages().stages)
    const projects = buildLaunchProjects(p, ws)
    const wf = ws.workflows.find((w) => w.id === p.workflowId)
    const session = buildWorkflowSession({
      flowId: p.workflowId,
      flowName: workflowDisplayName(wf?.name ?? p.workflowId),
      plan,
      projects: projects.map((pr) => ({ name: pr.name, provider: pr.provider ?? '', model: pr.model ?? '', permissionMode: pr.permissionMode })),
      supplement: p.supplement,
      seed: p.seed,
    })
    // 会话自动命名:工作流用 seed(用户的原始需求)命名这个会话(仍是 '新会话' 才改;导入会话有真实标题不受
    // 影响)。在 setSessionWorkflow 之前做,避免被它的写入覆盖;kick 的 "请开始「…」" 消息因此不会再命名它。
    if (p.seed?.trim()) autoNameIfDefault(p.workspacePath, p.sessionId, p.seed)
    // ④ 对话兜底契约:这条流程里没有任何产出文档的阶段(用户把「技术方案设计」去掉、聊完直接开发)时,
    // 执行 lane 将拿不到任何上下文——它是全新的 CLI 会话,只读 forge-docs/*.md。把这次对话原文落一份
    // 进去,让它照走「读整份文档」那条既有的路。有方案阶段时不写:那份产出才是契约。
    if (needsConversationDoc(plan.stages)) {
      const md = buildConversationDoc(history(p.workspacePath, p.sessionId).map(m => ({ who: m.who, text: m.text ?? '' })))
      if (md) {
        const docPath = join(p.workspacePath, CONVERSATION_DOC_REL)
        try {
          mkdirSync(dirname(docPath), { recursive: true })
          writeFileSync(docPath, md, 'utf8')
        } catch { /* best-effort:写不进去也不该挡住启动 */ }
      }
    }
    const file = setSessionWorkflow(p.workspacePath, p.sessionId, session)
    broadcastSessions(p.workspacePath, file)
    kickConversationalStage(p.workspacePath, p.sessionId, session)   // 图3:进入阶段0自动起手产出交付物
    return session
  })
  on(CH.workflowAdvance, async (_e, a: { workspacePath: string; sessionId: string; handoffText?: string; briefs?: Record<string, string>; skip?: string[] }) => {
    const s = getSession(a.workspacePath, a.sessionId)
    if (!s?.workflowSession) throw new Error('该会话不在工作流中')
    let next: WorkflowSessionState = advanceWorkflow(s.workflowSession)
    // D3(2026-07-30):跨 provider 推进时,用户编辑过的交接稿覆盖下一(对话)阶段的角色提示 preamble ——
    // chatService 会在进入该阶段的首轮把它注入给新 provider(作为该步的地面真相),取代自动蒸馏。
    if (a.handoffText && a.handoffText.trim() && next.phase === 'chatting' && next.stages[next.currentIndex]) {
      const stages = next.stages.map((st, i) => (i === next.currentIndex ? { ...st, preamble: a.handoffText!.trim() } : st))
      next = { ...next, stages }
    }
    // D4:进入执行前用户为各项目编辑的任务简报,合并到 projects[].brief,由 tailLaunchConfig 带进执行尾段。
    if (a.briefs && next.phase === 'executing') {
      next = { ...next, projects: next.projects.map((p) => ({ ...p, brief: a.briefs![p.name] ?? p.brief })) }
    }
    // #2:用户在简报卡里勾了"本次跳过"的项目 → 不进执行尾段(不起 lane、不浪费 token)。至少保留一个项目,
    // 否则扇出为空、这个执行阶段没有意义(全跳过应由用户直接不进执行,而非启动一个空 run)。
    if (a.skip?.length && next.phase === 'executing') {
      const kept = next.projects.filter((p) => !a.skip!.includes(p.name))
      if (kept.length) next = { ...next, projects: kept }
    }
    // Crossing into the fan-out execution tail → kick off ONE RunController run for stages[currentIndex..],
    // reusing run2's launch kickoff (temp branches + lane cards + finalize + summary). Only if not already started.
    if (next.phase === 'executing' && !next.runId) {
      const cfg = tailLaunchConfig(
        { workspacePath: a.workspacePath, flowId: next.flowId, sessionId: a.sessionId, supplement: next.supplement, seed: next.seed, projects: next.projects },
        next.stages, next.currentIndex,
      )
      const result = await run2.launchRun(cfg)
      const runId = result?.status === 'started' ? result.state.machine.plan.runId : undefined
      next = { ...next, runId }
    }
    const file = setSessionWorkflow(a.workspacePath, a.sessionId, next)
    broadcastSessions(a.workspacePath, file)
    kickConversationalStage(a.workspacePath, a.sessionId, next)   // 图3:推进到新对话阶段也自动起手
    return next
  })
  on(CH.workflowExit, (_e, a: { workspacePath: string; sessionId: string }) => {
    const file = setSessionWorkflow(a.workspacePath, a.sessionId, undefined)
    broadcastSessions(a.workspacePath, file)
    return sessionsOut(a.workspacePath, file)
  })
  // Change 2(doc-as-contract):进代码开发前读技术方案文档,抽每项目那节预填简报 + 报告文档是否存在。
  on(CH.workflowPrepareBriefs, (_e, a: { workspacePath: string; stageKey: string; projects: string[] }): { docExists: boolean; docPath: string; sections: Record<string, string> } => {
    const rel = stageDocRelPath(a.stageKey)
    const docPath = join(a.workspacePath, rel)
    let md = ''
    try { if (existsSync(docPath)) md = readFileSync(docPath, 'utf8') } catch { /* best-effort */ }
    const docExists = !!md.trim()
    const { sections } = docExists ? extractProjectBriefs(md, a.projects) : { sections: {} as Record<string, string> }
    return { docExists, docPath, sections }
  })
  on(CH.workflowFinish, (_e, a: { workspacePath: string; sessionId: string }) => {
    const s = getSession(a.workspacePath, a.sessionId)
    if (!s?.workflowSession) return readSessions(a.workspacePath)
    const next: WorkflowSessionState = { ...s.workflowSession, phase: 'done', currentIndex: s.workflowSession.stages.length }
    const file = setSessionWorkflow(a.workspacePath, a.sessionId, next)
    broadcastSessions(a.workspacePath, file)
    return sessionsOut(a.workspacePath, file)
  })
  on(CH.sessionContinueFrom, (_e, a: { wsPath: string; source: import('@shared/types').SourceId; externalId: string; title: string; filePaths: string[] }) => {
    if (isArchivedWorkspace(a.wsPath)) throw new Error('工作区已归档，恢复后才能继续。')
    const file = continueFrom(a.wsPath, a)
    broadcastSessions(a.wsPath, file)
    return sessionsOut(a.wsPath, file)
  })
  on(CH.sessionAgentIds, (_e, a: { workspacePath: string; sessionId: string }) => agentSessionsForId(a.workspacePath, a.sessionId, chatQueue.runningProvider(a.workspacePath, a.sessionId)))
  on(CH.chatResolve, (_e, a: { id: string; decision: 'allow' | 'deny' | 'modify'; value?: string; choice?: number; answers?: AskAnswers; response?: string; selection?: { stages: string[]; stageProjects: Record<string, string[]>; hooks?: string[] }; workspacePath: string }) => {
    const askResolve = chatAsks.get(a.id)
    if (askResolve) {
      chatAsks.delete(a.id)
      chatGateOwner.delete(a.id)
      askResolve({ decision: a.decision === 'modify' ? 'deny' : a.decision, value: a.value, choice: a.choice })
      broadcast(CH.chatEvent, { workspacePath: a.workspacePath, sessionId: readSessions(a.workspacePath).activeSessionId, type: 'ask-resolved', id: a.id })
      return
    }
    const resolve = chatConfirms.get(a.id)
    if (!resolve) {
      // ★门已经被别人答掉了。原来这里直接 return —— 那正是「你以为自己拦住了」的来源。
      //   只有**答案不一样**时才提示:同一台设备手抖点两下是常事,不该为此加噪音;
      //   而「一个说允许、一个说拒绝」是安全问题,必须让落空的那个人看见。
      const prev = recentlyResolved.get(a.id)
      if (prev && prev.decision !== a.decision) {
        emitNote(prev.ws, prev.sessionId,
          `⚠️ 你的「${DECISION_CN[a.decision] ?? a.decision}」没有生效 —— 这道门已由「${prev.by}」抢先答为「${DECISION_CN[prev.decision] ?? prev.decision}」。`)
      }
      return
    }
    const by = _e?.client?.label ?? '本机'
    chatConfirms.delete(a.id)
    chatGateOwner.delete(a.id)
    rememberResolved(a.id, by, a.decision, a.workspacePath, readSessions(a.workspacePath).activeSessionId ?? '')
    // 带 answers/response 的放行 = 这是一道「请回答」的门(AskUserQuestion),必须把选择原样送回 provider。
    const answered = a.decision === 'allow' && (a.answers !== undefined || a.response !== undefined)
    resolve(answered ? { decision: 'allow', answers: a.answers, response: a.response }
      : a.decision === 'modify' ? 'deny' : a.decision)
    broadcast(CH.chatEvent, { workspacePath: a.workspacePath, sessionId: readSessions(a.workspacePath).activeSessionId, type: 'confirm-resolved', id: a.id })
    // 别的设备答的门,要在对话里留个痕 —— 否则电脑前的人只看到卡片凭空消失,不知道发生了什么。
    // 本机自己答的不提示:那会给单机用户的每一次确认都加一条噪音。
    if (_e?.client && _e.client.id !== 'local') {
      const sid = readSessions(a.workspacePath).activeSessionId ?? ''
      if (sid) emitNote(a.workspacePath, sid, `🛡 「${by}」${DECISION_CN[a.decision] ?? a.decision}了这道门。`)
    }
  })

  // ---- Bot bridge (钉钉) ----
  // Resolve a chat ask/confirm gate by id, mirroring CH.chatResolve but callable from the bot bridge
  // (which lives here so it can touch the closure-local gate maps directly, no ipc round-trip).
  const resolveChatGateById = (id: string, decision: 'allow' | 'deny', value?: string, choice?: number): boolean => {
    const owner = chatGateOwner.get(id)
    const ask = chatAsks.get(id)
    if (ask) {
      chatAsks.delete(id); chatGateOwner.delete(id)
      ask({ decision, value, choice })
      if (owner) broadcast(CH.chatEvent, { workspacePath: owner.ws, sessionId: owner.sessionId, type: 'ask-resolved', id })
      return true
    }
    const conf = chatConfirms.get(id)
    if (conf) {
      chatConfirms.delete(id); chatGateOwner.delete(id)
      conf(decision)
      if (owner) broadcast(CH.chatEvent, { workspacePath: owner.ws, sessionId: owner.sessionId, type: 'confirm-resolved', id })
      return true
    }
    return false
  }
  // Persist a bot-bridge config AND broadcast settingsChanged — otherwise the renderer keeps showing a
  // stale pairing code / bindings after the main process rotates them (attach bootstrap, bind rotation,
  // regen, connect/disconnect). This was the "配对码不正确" bug: disk had the new code, pane the old one.
  const persistBotConfig = (bb: BotBridgeConfig) => {
    const s = readSettings(); writeSettings({ ...s, botBridge: bb })
    const next = readSettings(); broadcast(CH.settingsChanged, next); onSettings?.(next)
  }
  botBridge.attach({
    readConfig: () => readSettings().botBridge as BotBridgeConfig,
    writeConfig: (cfg) => persistBotConfig(cfg),
    enqueue: (payload, source) => chatQueue.enqueue(payload as ChatSendPayload, source),
    resolveChatGate: resolveChatGateById,
    resolveRun2Gate: (ws, eventId, decision) => run2Manager.resolveGate(ws, eventId, decision),
    resolveRun2Lane: (ws, eventId, decision) => run2Manager.resolveLane(ws, eventId, decision),
    listWorkspaces: () => readWorkspaceRegistry().filter(w => !w.archived).map(w => {
      const sf = readSessions(w.path)
      return {
        path: w.path, name: w.name, activeSessionId: sf.activeSessionId,
        sessions: sf.sessions.map(s => ({ id: s.id, title: s.title, mode: s.mode })),
      }
    }),
    resolveAgentForSession: async (ws, sessionId) => {
      const s = getSession(ws, sessionId)
      const agent = s?.agentId || 'claude'
      const agentLabel = providers[agent]?.displayName ?? agent
      let model = s?.modelId || ''
      if (!model) {   // a brand-new session has no model yet; empty model 400s the chat API
        try {
          const env = buildAgentEnv({ proxy: readSettings().agentProxy })
          const models = await (providers[agent] ?? providers['claude'])?.listModels(env)
          model = models?.[0]?.id || ''
        } catch { /* leave empty — a clear API error beats a crash */ }
      }
      return { agent, agentLabel, model }
    },
    createSession: (ws, title) => {
      const f = newSession(ws, title)
      broadcastSessions(ws, f)
      return f.activeSessionId
    },
    stopSession: (ws, sessionId) => { chatQueue.stop(ws, sessionId); cancelWorkspaceDelegates(ws, sessionId) },
    sessionMeta: (ws, sessionId) => {
      const s = getSession(ws, sessionId)
      if (!s) return null
      const agent = s.agentId || 'claude'
      return { agent, agentLabel: providers[agent]?.displayName ?? agent, model: s.modelId || '', permission: s.permissionMode || 'auto' }
    },
    listModels: async (agent) => {
      try {
        const env = buildAgentEnv({ proxy: readSettings().agentProxy })
        const models = await (providers[agent] ?? providers['claude'])?.listModels(env)
        return (models ?? []).map(mm => ({ id: mm.id, label: mm.label }))
      } catch { return [] }
    },
    setModel: (ws, sessionId, agent, model) => {
      const file = setSessionModel(ws, sessionId, agent, model)
      broadcastSessions(ws, file)
    },
    setPermission: (ws, sessionId, mode) => { applyPermission(ws, sessionId, mode, '机器人桥') },
    getProxy: () => readSettings().agentProxy,
    emitStatus: (platform, st) => broadcast(CH.botStatusEvent, { platform, status: st }),
  })
  on(CH.botConnect, async (_e, a: { platform: BotPlatform }) => {
    const bb = readSettings().botBridge as BotBridgeConfig
    persistBotConfig({ ...bb, [a.platform]: { ...bb[a.platform], enabled: true } })
    await botBridge.connect(a.platform); return botBridge.getStatuses()
  })
  on(CH.botDisconnect, async (_e, a: { platform: BotPlatform }) => {
    const bb = readSettings().botBridge as BotBridgeConfig
    persistBotConfig({ ...bb, [a.platform]: { ...bb[a.platform], enabled: false } })
    await botBridge.disconnect(a.platform); return botBridge.getStatuses()
  })
  on(CH.botGetStatus, () => botBridge.getStatuses())
  on(CH.botRegenPairing, () => {
    const code = genPairing()
    persistBotConfig({ ...(readSettings().botBridge as BotBridgeConfig), pairingCode: code })
    return code
  })
  on(CH.botUnbind, (_e, a: { chatId: string }) => {
    const bb = readSettings().botBridge as BotBridgeConfig
    persistBotConfig({ ...bb, bindings: bb.bindings.filter(b => b.chatId !== a.chatId) })
    return (readSettings().botBridge as BotBridgeConfig).bindings
  })

  // ── 推送。手机把自己的 Expo 推送令牌登记到**这台机器**上,并持续上报在场状态;
  //    门升起 / 一轮跑完时,这台机器直接 POST 给 Expo(决策 7:不经中转、不自建后端)。
  //    ★桌面端设置里也能看这张表和发测试推送,所以它们在方法表里而不是只给手机用。
  on(CH.pushRegister, (_e, a: { token: string; label?: string; platform?: 'ios' | 'android' | 'web' }) =>
    pushService.register({ token: String(a?.token ?? ''), label: a?.label, platform: a?.platform }))
  on(CH.pushUnregister, (_e, a: { token: string }) => pushService.unregister(String(a?.token ?? '')))
  on(CH.pushDevices, () => pushService.devices())
  // ★在场上报是**高频**的(切前后台、换会话都会发一次),所以它什么都不返回 ——
  //  一次往返里少一个响应体,手机上少一次序列化。
  on(CH.pushPresence, (_e, a: { token: string; visible: boolean; at: { workspacePath: string; sessionId?: string | null } | null }) => {
    pushService.presence(String(a?.token ?? ''), { visible: !!a?.visible, at: a?.at ?? null })
  })
  on(CH.pushTest, () => pushService.sendTest())
  // Provider-switch context summary: after the user confirms switching agent mid-session, the NEW
  // provider reads the prior conversation and produces a visible summary message (provider = toAgent,
  // so the timeline auto-inserts a provider-switch divider above it: old agent's msgs → summary).
  on(CH.chatSwitchSummary, async (_e, a: { workspacePath: string; sessionId: string; toAgent: string; model: string }) => {
    const provider = providers[a.toAgent] ?? providers['claude']
    if (!provider?.chat) return
    const msgs = history(a.workspacePath, a.sessionId).filter(m => m.text?.trim())
    if (!msgs.length) return
    const env = buildAgentEnv({ proxy: readSettings().agentProxy })
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
  // Launch-gate requirement summary: when the user opens the workflow launch gate, distill the whole
  // conversation into ONE concise, executable requirement string (shown in the gate as an editable
  // "原始需求"). Unlike chatSwitchSummary above this returns a plain string (no persisted message, no
  // event stream) — the renderer awaits it and drops it into the gate. Same provider/model/env recipe
  // as the distiller: cheap distill model when available, else the session's own model. Fail-open with
  // a hard timeout so a hung provider never leaves the gate spinning — the renderer falls back to the
  // raw last-N transcript when this returns ''.
  on(CH.chatSummarizeRequirement, async (_e, a: { workspacePath: string; sessionId: string; agent: string; model: string }): Promise<string> => {
    const provider = providers[a.agent] ?? providers['claude']
    if (!provider?.chat) return ''
    const msgs = history(a.workspacePath, a.sessionId).filter(m => m.text?.trim())
    if (!msgs.length) return ''
    const env = buildAgentEnv({ proxy: readSettings().agentProxy })
    const model = distillModelFor(a.agent) ?? a.model
    const id = `req-sum-${Date.now()}`
    // 超时/出错 → null(不是「已经流出来的半截」)。半截需求会被当成「需求原文」发给每个阶段的 agent,
    // 比回退到啰嗦但完整的原始对话摘录糟得多。见 requirementSummary.ts 顶部。
    return summarizeRequirement(msgs.map(m => ({ who: m.who === 'user' ? '用户' : '助手', text: m.text })), {
      summarize: (prompt) => new Promise<string | null>((resolve) => {
        let acc = ''
        let done = false
        let session: { cancel: () => void } | undefined
        const timer = setTimeout(() => { try { session?.cancel() } catch { /* best-effort */ } resolve(null) }, 60_000)
        const finish = (ok: boolean) => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve(ok ? acc : null)
        }
        session = provider.chat!({ id, prompt, model, cwd: a.workspacePath }, {
          onSession: () => {},
          onAssistantDelta: (t) => { acc += t },
          onThinkDelta: () => {},
          onDone: () => finish(true),
          onError: () => finish(false),
        }, env)
      }),
    })
  })
  // P1-5: persist a confirmed launch-gate's frozen record so it survives reload/session-switch.
  // Reuses the exact appendMessage + broadcast(chatEvent 'done') mechanism every other persisted chat
  // card uses (see chatSwitchSummary just above, and subagents in chatService.ts) — the record rides on
  // a synthetic system ChatMessage (blank text, `launchGate` field carries the record) with the SAME id
  // as the renderer's in-chat LaunchGateCard, so when this broadcast round-trips back into chat.messages
  // WorkspaceView can dedupe it against its own local (already-frozen) entry by id.
  on(CH.chatAppendLaunchGate, (_e, a: {
    workspacePath: string; sessionId: string; id: string; ts: string
    workflowName: string; projects: string[]; supplement: string; decidedAt: number; seed: string
  }) => {
    const note: ChatMessage = {
      id: a.id, who: 'ai', text: '', ts: a.ts,
      launchGate: { workflowName: a.workflowName, projects: a.projects, supplement: a.supplement, decidedAt: a.decidedAt, seed: a.seed },
    }
    appendMessage(a.workspacePath, a.sessionId, note)
    broadcast(CH.chatEvent, { workspacePath: a.workspacePath, sessionId: a.sessionId, type: 'done', message: note })
    return note
  })
  // P3-4: persist a resolved run2 inbox event's frozen record (mirrors chatAppendLaunchGate just above)
  // so a resolved gate/auth/question/doubt/failure card survives reload/session-switch. Rides on a
  // synthetic system ChatMessage (blank text, `runCard` field carries the frozen decision) with the
  // SAME id as the in-chat RunEventCard's event id, so it round-trips back into chat.messages and
  // WorkspaceView can dedupe against its own local resolved-cards state by id.
  on(CH.chatAppendRunCard, (_e, a: { workspacePath: string; sessionId: string; ts: string; runCard: NonNullable<ChatMessage['runCard']> }) => {
    // Idempotent by id: every run-card id is write-once (an event id, `abort-<runId>`, or
    // `summary-<runId>`) — never re-appended with different content. Persisting the same id twice must
    // be a no-op, because appendMessage (chatStore.ts) writes the jsonl with a blind appendFileSync (no
    // id-dedupe). This matters most for the STATE-DRIVEN 本次运行总结 card (①汇总): unlike the other
    // cards, which persist only from a one-shot user action, its WorkspaceView effect re-fires on every
    // remount, and can race a fresh-ref-before-chatHistory-loads window — without this guard that race
    // would append a duplicate summary line every time. Return the existing record so callers still get
    // a note back, and don't re-broadcast (the active session already has it / will on next load).
    const existing = readMessages(a.workspacePath, a.sessionId).find((m) => m.id === a.runCard.id)
    if (existing) return existing
    const note: ChatMessage = { id: a.runCard.id, who: 'ai', text: '', ts: a.ts, runCard: a.runCard }
    appendMessage(a.workspacePath, a.sessionId, note)
    broadcast(CH.chatEvent, { workspacePath: a.workspacePath, sessionId: a.sessionId, type: 'done', message: note })
    return note
  })
  // Fold any in-flight (still-streaming) assistant message into the returned history so switching to the
  // home view / another session mid-stream and back restores the already-produced output (it isn't
  // persisted until the turn's terminal state).
  /**
   * 一个会话的全部历史。
   *
   * ★★`toolOutputLines` / `toolOutputBytes` 是**给带宽小的客户端**的:工具输出(shell stdout、
   *  读文件回显)占一份历史 99% 的字节,而手机最多画 200 行。手机走中转打开长会话要十秒,
   *  九成时间花在下载它立刻就要丢掉的东西上。给了上限就在这儿截,并带上原始行数
   *  (界面照旧如实说「还有 N 行没显示」)。详见 `toolOutputCap.ts`。
   * ★不给 = 一个字不截。电脑端本机那条路行为逐字不变。
   */
  on(CH.chatHistory, (_e, a: { workspacePath: string; sessionId: string; toolOutputLines?: number; toolOutputBytes?: number }) => {
    const msgs = mergeLive(a.workspacePath, a.sessionId, history(a.workspacePath, a.sessionId))
    const cap = readCap(a)
    return cap ? capToolOutputs(msgs, cap) : msgs
  })
  on(CH.dialogOpenFiles, async (): Promise<Attachment[]> => {
    const paths = await caps.pickPaths({ kind: 'file', multi: true })
    return paths.map(p => ({ name: basename(p), path: p, size: statSync(p).size }))
  })
  // 大段粘贴转文件走这里(见 Composer.handlePaste)。盘满 ENOSPC、无权限 EPERM、只读工作树都会让
  // mkdirSync/writeFileSync 抛出 —— 不接住的话异常会穿过 ipcMain.handle 变成渲染层的 unhandled
  // rejection,preventDefault() 已经吃掉的原生粘贴内容就凭空消失了。转成 null,与 Composer 里
  // `att === null` 的既有失败分支同形,由它把原文插回正文兜底。
  //
  // 重名去重是这里的**必需品**,不是锦上添花:剪贴板图片在 Chrome 里一律叫 image.png,连粘三张就是
  // 三次写同一个路径,后一张静默盖掉前一张 —— chip 上三个不同大小都在,盘上只剩最后一个,agent 拿到
  // 三份同一张图。渲染层猜不出盘上已经有什么,只有这里知道。
  on(CH.chatSavePaste, (_e, a: { workspacePath: string; name: string; dataBase64: string }): Attachment | null => {
    try {
      const dir = join(a.workspacePath, '.forge', 'attachments')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const name = uniqueAttachmentName(dir, a.name)
      const dest = join(dir, name)
      const bytes = Buffer.from(a.dataBase64, 'base64')
      writeFileSync(dest, bytes)
      return { name, path: dest, size: bytes.length }
    } catch {
      return null
    }
  })

  const watcher = new WorktreeWatcher((p, opts) => chokidarWatch(p, opts as object) as unknown as import('../watcher/worktreeWatcher').FsWatcherLike)
  const proxy = () => readSettings().agentProxy
  const changesEmit = (e: ChangesEvent) => broadcast(CH.changesEvent, e)

  on(CH.gitChanges, (_e, cwd: string) => perfSpan('git', 'readChanges', () => readChanges(cwd, proxy())))
  on(CH.changesMulti, (_e, cwds: string[]) => perfSpan('git', 'changesMulti', () => readChangesMulti(cwds, proxy())))
  on(CH.gitDiff, (_e, a: { cwd: string; file: string }) => readDiff(a.cwd, a.file, proxy()))
  on(CH.gitFile, (_e, a: { cwd: string; file: string }) => readFile(a.cwd, a.file, proxy()))
  // Read an image file's bytes → data URL for the inspector's image preview (gitFile returns text, which
  // renders binary images as garbage). Guards: known image ext, stays within cwd, size cap.
  on(CH.imageFile, (_e, a: { cwd: string; file: string }): { dataUrl: string } | { error: string } => {
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
  // ── 对话产物可点开 ────────────────────────────────────────────────────────────
  // 聊天正文里的 [设计文档](docs/design.md) 点击后走这里:renderer 只知道一串 href,存在性、是不是目录、
  // 有没有越出工作区,全部在主进程判(renderer 没有 fs)。bases 按优先级给:当前会话 worktree → 工作区根。
  on(CH.resolveFileRef, (_e, a: { bases: string[]; href: string }) =>
    resolveFileRef(Array.isArray(a?.bases) ? a.bases : [], String(a?.href ?? '')))
  // 预览显示不了的类型(pdf/xlsx/zip)和 .html 的「用浏览器打开」。只放行 bases 之内的真实文件 ——
  // 这是个能拉起任意本地程序的口子,越界必须拒。
  on(CH.openFilePath, async (_e, a: { bases: string[]; href: string }) => {
    const r = resolveFileRef(Array.isArray(a?.bases) ? a.bases : [], String(a?.href ?? ''))
    if (!r.ok) return { ok: false as const, error: r.reason }
    const err = await caps.openPath(r.abs)
    return err ? { ok: false as const, error: err } : { ok: true as const }
  })
  // 服务端目录选择器的两个只读端点(第二期 D)。★只读:列目录、看上一层。没有写、没有删、没有改名 ——
  // 多一个能写的口子,就多一条从网络直达文件系统的路径。
  on(CH.fsBrowse, (_e, a: { path?: string; showHidden?: boolean; filesToo?: boolean }) =>
    listDir(String(a?.path ?? ''), { showHidden: !!a?.showHidden, filesToo: !!a?.filesToo }))
  on(CH.fsBrowseRoots, () => defaultRoots())
  on(CH.fsTree, async (_e, cwd: string) => perfSpan('ipc', 'fsTree', async () => readTree(cwd, await readChanges(cwd, proxy()), proxy())))
  on(CH.gitBranch, (_e, cwd: string) => readBranch(cwd, proxy()))
  on(CH.fileSearchContent, (_e, a: { root: string; query: string; files?: string[] }) =>
    searchContent({ root: a.root, query: a.query, files: a.files }))
  on(CH.watchChanges, (_e, cwd: string) => {
    watcher.start(cwd, () => { void perfSpan('watcher', 'onChange', () => readChanges(cwd, proxy()).then(changes => changesEmit({ cwd, changes }))) })
    return readChanges(cwd, proxy())
  })
  on(CH.watchStop, () => { watcher.stop() })

  // ── Plugin IPC ──────────────────────────────────────────────────────────────
  on(CH.pluginsList, () =>
    getPluginScheduler()?.snapshot() ?? { plugins: [], results: {} }
  )
  on(CH.pluginsInstall, (_e, dir: string) => {
    const r = installPlugin(dir)
    if (r.ok) {
      // reconcile() already runs the new plugin; no need to also call refresh()
      getPluginScheduler()?.reconcile()
    }
    return r
  })
  on(CH.pluginsUninstall, (_e, id: string) => {
    uninstallPlugin(id)
    getPluginScheduler()?.reconcile()
  })
  on(CH.pluginsSetEnabled, (_e, a: { id: string; enabled: boolean }) => {
    setPluginEnabled(a.id, a.enabled)
    getPluginScheduler()?.reconcile()
  })
  on(CH.pluginsRefresh, (_e, id?: string) => {
    // 带 id = 用户在某张插件卡上点了「刷新」,是明确意图 → 绕过最小间隔。不带 id 的全量刷新走节流。
    void getPluginScheduler()?.refresh(id, id !== undefined)
  })
  on(CH.pluginsGetCreds, () => readSettings().pluginCreds ?? {})
  on(CH.pluginsSetCred, (_e, a: { provider: string; value: string }) => {
    const s = readSettings()
    const creds = { ...(s.pluginCreds ?? {}) }
    if (a.value.trim()) creds[a.provider] = a.value.trim()
    else delete creds[a.provider]   // empty value clears the override → back to auto-read
    writeSettings({ ...s, pluginCreds: creds })
    // 只重跑真正用到这条凭据的那个插件。从前这里是无参 refresh() —— 改一次 cookie 就把 claude/codex/
    // gemini/cursor 的额度 API 全打一遍,是 429 的主要来源之一。
    const affected = readPlugins().find(p => p.type === 'statusbar-usage' && p.provider === a.provider)
    if (affected) void getPluginScheduler()?.refresh(affected.id, true)
    return creds
  })
  // 走用户代理拉远程「下架名单」(与 nsfw/wallpaper 同一条 makeContentFetch 通道);fail-open,拉不到就显示全部。
  on(CH.pluginsCatalog, () => listCatalog(makeContentFetch(readSettings().agentProxy)))
  on(CH.pluginsInstallExample, (_e, id: string) => {
    const r = installOfficial(id)
    if (r.ok) getPluginScheduler()?.reconcile()
    return r
  })
  // ── End Plugin IPC ──────────────────────────────────────────────────────────

  on(CH.dialogPickDirectory, async (): Promise<string | null> => {
    const paths = await caps.pickPaths({ kind: 'directory', createDirectory: true })
    return paths[0] ?? null
  })
  on(CH.dialogPickFile, async (): Promise<string | null> => {
    const paths = await caps.pickPaths({ kind: 'file' })
    return paths[0] ?? null
  })

  // ── Session Import IPC ──────────────────────────────────────────────────────
  on(CH.sessionImportScan, () => {
    const sessions = scanAll()
    const wsPaths = readWorkspaceRegistry().map(w => w.path)
    const groups = groupByCwd(sessions, wsPaths)
    const scannedAt = Date.now()
    writeScanCache(groups, scannedAt)
    return { scannedAt, groups }
  })
  on(CH.sessionImportLastScan, () => readScanCache())
  on(CH.sessionImportRun, (_e, sessions: DiscoveredSession[]): import('@shared/types').ImportResult => {
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
  on(CH.sessionImportRead, (_e, s: DiscoveredSession) => readSession(s))
  on(CH.sessionImportList, () => readIndex())
  on(CH.sessionImportCoverage, () => sessionImportCoverage())
  // ── End Session Import IPC ──────────────────────────────────────────────────

  on(CH.petPickPack, async (_e, petId: string) => {
    const [dir] = await caps.pickPaths({ kind: 'directory' })
    if (!dir) return null
    // Persist each state image to disk under the pet's folder; return { images: { state: relPath } }
    // (no data URLs) plus the folder name so the pet gets a sensible default name (authoring nicety —
    // drop a folder of state-named images and it's ready). Only idle is required; missing states fall
    // back to idle at render time.
    const packed = readPetPack(dir)
    const images: Record<string, string> = {}
    for (const [state, dataUrl] of Object.entries(packed)) {
      if (!dataUrl) continue
      const rel = writePetImageFromDataUrl(petId, state, dataUrl)
      if (rel) images[state] = rel
    }
    return { name: basename(dir), images }
  })

  on(CH.petPickImage, async (_e, petId: string, state: string = 'idle') => {
    const [file] = await caps.pickPaths({ kind: 'file', filters: [{ name: '图片', extensions: ['png', 'gif', 'svg', 'webp'] }] })
    if (!file) return null
    const read = readPetImage(file)
    if ('error' in read) return { error: read.error }
    // Write to ~/.myFlowForge/pet-images/<petId>/<state>.<ext> and return the relative path only.
    const rel = writePetImageFromDataUrl(petId, state, read.dataUrl)
    if (!rel) return { error: '图片写入失败' }
    return { path: rel }
  })

  // Codex v2 pet packs: validate + copy a pack directory into the pet store (returns a CustomPet the
  // renderer adds to customPets, mirroring petPickImage), list auto-discovered packs under ~/.codex/pets,
  // and pick-a-folder → import. Directory input only (no zip dependency).
  on(CH.codexPetImport, (_e, dir: string) => importCodexPetPack(dir))
  on(CH.codexPetList, () => discoverCodexPets())
  on(CH.codexPetPick, async () => {
    const [dir] = await caps.pickPaths({ kind: 'directory' })
    if (!dir) return null
    return importCodexPetPack(dir)
  })

  // 成长宠物包:同样是「选一个目录 → 校验 → 拷进宠物图库 → 返回 CustomPet」,只是包里带的是
  // 每阶段一张 atlas(kind:"growth")。取消时返回 null,与 codexPetPick 一致 —— 用户主动取消不是错误,
  // 渲染层不该把它当成红字报错弹出来。
  on(CH.growthPetImport, async () => {
    const [dir] = await caps.pickPaths({ kind: 'directory', title: '选择成长宠物包目录' })
    if (!dir) return null
    // importGrowthPetPack 只把「包本身不合格」变成 {ok:false},写盘的 I/O 异常照抛(ENOSPC 盘满、
    // EPERM 无权、EISDIR 目标名被目录占住 —— 最后这个在 growthPetImport.test.ts 里就是真实用例)。
    // 不在这里接住的话,异常会穿过 ipcMain.handle 变成渲染层的未处理 rejection:红字行不出现,
    // 用户看到的是「点了没反应」。转成与既有失败同形的 {ok:false,error},渲染层原路显示。
    try {
      return importGrowthPetPack(dir)
    } catch (e) {
      return { ok: false, error: `安装失败:${e instanceof Error ? e.message : String(e)}` }
    }
  })

  // Background image: open a picker, store the chosen image on disk under ~/.myFlowForge/backgrounds
  // and return its forge-bg:// URL (settings.json keeps only the small URL, not multi-MB base64). No
  // tiny cap needed anymore — storeBackgroundFromPath guards against pathological files. After a
  // successful pick, GC any background file no longer referenced by settings (old image on replace).
  on(CH.appearancePickBgImage, async () => {
    const [file] = await caps.pickPaths({ kind: 'file', filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] })
    if (!file) return null
    const stored = storeBackgroundFromPath(file)
    if ('error' in stored) return { error: stored.error }
    try {
      const a = readSettings().appearance
      const keep = new Set([stored.rel, bgRelFromUrl(a.bgImage), bgRelFromUrl(a.homeBgImage), ...previewKeepRels()].filter((x): x is string => !!x))
      gcBackgrounds(keep)
    } catch { /* GC is best-effort; a leftover file is harmless */ }
    return { url: backgroundImageUrl(stored.rel) }
  })

  // Downloadable fonts: list what's on disk (each entry carries its rewritten @font-face CSS so the
  // renderer can inject it), download a catalog font (streaming per-file progress to the caller), and
  // delete one. Downloads honour the user's configured proxy via makeProxyFetch.
  on(CH.fontsListDownloaded, () => listDownloadedFonts())
  on(CH.fontsDownload, async (e, id: string) => {
    const entry = catalogEntry(id)
    if (!entry) return { error: '未知字体' }
    const pf = makeProxyFetch(readSettings().appProxy)   // 字体是客户端的事(Q4)
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
  on(CH.fontsDelete, (_e, id: string) => ({ ok: deleteDownloadedFont(id) }))

  // License-gated extra content. All requests go through the user's configured proxy and carry the
  // locally-stored activation code (settings.nsfwCode); the Worker holds the real keys + image bytes.
  const nsfwFetch = () => makeContentFetch(readSettings().appProxy) // 客户端专属内容(Q4);proxy-first, direct fallback
  // The activation key sent to the Worker: ALL activated codes joined by comma (multi-code additive →
  // Worker returns the deduped union of their subsets). Falls back to the legacy single nsfwCode so an
  // install that predates nsfwCodes keeps working. encodeURIComponent in nsfwService escapes the commas.
  const nsfwKey = () => {
    const s = readSettings()
    const codes = s.nsfwCodes?.length ? s.nsfwCodes : (s.nsfwCode ? [s.nsfwCode] : [])
    return codes.join(',')
  }
  // Shared preview cache: a persistent url-key → on-disk-file index so re-opening Settings returns the
  // already-downloaded thumbnails with NO network — the fix for "every open re-hits the Cloudflare Worker
  // per thumbnail". Shared across NSFW + built-in wallpaper previews (both store under backgrounds/).
  const previewCache = makeDiskPreviewCache()
  on(CH.nsfwValidate, (_e, code: string) => nsfwValidate(code, nsfwFetch()))
  on(CH.nsfwCatalog, () => nsfwCatalog(nsfwKey(), nsfwFetch()))
  on(CH.nsfwPreview, (_e, kind: 'pet' | 'bg', id: string) => nsfwPreview(kind, id, nsfwKey(), nsfwFetch(), previewCache))
  // Gallery (design E): returns catalog + already-cached thumbnails immediately; the missing ones stream
  // in and arrive one-by-one as CH.nsfwPreviewEvent {key,url} on the SAME window.
  on(CH.nsfwGallery, (e, force?: boolean) => {
    const emit = (key: string, url: string) => { try { e.sender.send(CH.nsfwPreviewEvent, { key, url }) } catch { /* window closed */ } }
    return nsfwGallery(nsfwKey(), nsfwFetch(), previewCache, emit, { force: !!force })
  })
  on(CH.nsfwInstallPet, (_e, petId: string, pet: NsfwPet) => nsfwInstallPet(petId, pet, nsfwKey(), nsfwFetch()))
  on(CH.nsfwInstallBg, (_e, bg: NsfwBg) => nsfwInstallBg(bg, nsfwKey(), nsfwFetch()))
  // Does the local file behind a forge-bg:// URL still exist? (An installed extra bg may have been
  // GC'd; if gone, the renderer re-downloads instead of pointing at a missing file.)
  on(CH.nsfwBgExists, (_e, url: string) => {
    const rel = bgRelFromUrl(url)
    const abs = rel ? resolveBackgroundAbs(rel) : null
    return { exists: !!abs && existsSync(abs) }
  })

  // Built-in wallpapers: public jsDelivr catalog + images, downloaded on demand through the user's proxy
  // and stored on disk like any uploaded background. No activation code, no Worker (so no Worker quota).
  const wallpaperFetch = () => makeContentFetch(readSettings().appProxy) // 壁纸/宠物包跟设备走(Q4);proxy-first, direct fallback
  on(CH.wallpaperCatalog, () => wallpaperCatalog(wallpaperFetch()))
  on(CH.wallpaperPreview, (_e, item: WallpaperItem) => wallpaperPreview(item, wallpaperFetch(), previewCache))
  on(CH.wallpaperInstall, (_e, item: WallpaperItem) => wallpaperInstall(item, wallpaperFetch()))

  // Downloadable pet packs — same public jsDelivr pipeline as wallpapers, no activation code.
  on(CH.petPackCatalog, () => petPackCatalog(wallpaperFetch()))
  on(CH.petPackPreview, (_e, item: { thumb: string }) => petPackPreview(item, wallpaperFetch()))
  on(CH.petPackInstall, (_e, petId: string, item: PetPackItem) => petPackInstall(petId, item, wallpaperFetch()))
  on(CH.growthPackInstall, (_e, petId: string, item: GrowthPackItem) => growthPackInstall(petId, item, wallpaperFetch()))

  // codex-pets.net 宠物市场(第三方社区库,插件 gating)。走同一条 proxy-first fetch 避免 CORS,但**必须带
  // 超时** —— 它是个第三方社区小站,慢/挂是常态,而 undici 的 fetch 自己没有整体超时:不设死线就是用户
  // 盯着转圈直到天荒地老。代理那一跳给更短的死线,超时即回退直连(以前只有代理"抛异常"才回退,挂起不回退)。
  const marketFetch = (timeoutMs: number) =>
    makeContentFetch(readSettings().appProxy, undefined, { timeoutMs, proxyTimeoutMs: 5_000 })   // 宠物市场跟设备走(Q4)
  on(CH.codexMarketCatalog, (_e, page: number) => codexMarketCatalog(page, marketFetch(8_000)))
  on(CH.codexMarketPreview, (_e, url: string) => codexMarketPreview(url, marketFetch(15_000)))
  on(CH.codexMarketInstall, (_e, item: CodexMarketPet) => codexMarketInstall(item, marketFetch(60_000)))

  const MAX_PINNED = 5
  on(CH.workspacesList, () => {
    const s = readSettings()
    // The legacy in-memory orchestrator run is gone; run2 runs don't surface a "live path" here.
    const livePath = undefined
    return listWorkspaces(livePath, s.pinnedWorkspaces, s.workspaceOrder)
  })
  on(CH.workspacesHomeStats, () => readHomeStats(readSettings().agentProxy))
  on(CH.workspacesSetPinned, (_e, a: { path: string; pinned: boolean }) => {
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
    // The legacy in-memory orchestrator run is gone; run2 runs don't surface a "live path" here.
    const livePath = undefined
    return listWorkspaces(livePath, pinned, s.workspaceOrder)
  })
  on(CH.workspacesSetOrder, (_e, a: { order: string[] }) => {
    const s = readSettings()
    writeSettings({ ...s, workspaceOrder: a.order })
    // Keep every window's settings snapshot fresh so a later config:set-settings (which writes the
    // whole settings object) doesn't clobber the manual order with a stale value.
    broadcast(CH.settingsChanged, readSettings())
    // The legacy in-memory orchestrator run is gone; run2 runs don't surface a "live path" here.
    const livePath = undefined
    return listWorkspaces(livePath, s.pinnedWorkspaces, a.order)
  })
  const wsList = () => {
    const s = readSettings()
    // The legacy in-memory orchestrator run is gone; run2 runs don't surface a "live path" here.
    const livePath = undefined
    return listWorkspaces(livePath, s.pinnedWorkspaces, s.workspaceOrder)
  }
  on(CH.workspaceArchive, (_e, path: string) => {
    cancelWorkspaceDelegates(path)   // 归档=只读封存,先停掉该工作区后台还在跑的 delegate 子代理
    // 描述在 archiveWorkspaceLifecycle 里就地取自最后一个聊过的会话标题 —— 归档不再起「摘要 agent」
    // (那会在刚封存的目录里拉起一个 CLI 进程,被外部 agent 监控看见并推通知)。
    archiveWorkspaceLifecycle(path)
    broadcast(CH.workspacesChanged, {})
    return wsList()
  })
  on(CH.workspaceRestore, (_e, path: string) => {
    restoreWorkspaceLifecycle(path)
    broadcast(CH.workspacesChanged, {})
    return wsList()
  })
  on(CH.workspaceDelete, async (_e, path: string) => {
    cancelWorkspaceDelegates(path)   // 删除前先停掉后台 delegate 子代理,避免孤儿进程仍在读/写将被删的目录
    const r = await deleteWorkspace(path)
    broadcast(CH.workspacesChanged, {})
    return { ...r, list: wsList() }
  })
  // 移除:仅从列表移除,保留磁盘文件(可重新添加目录恢复)。
  on(CH.workspaceRemove, (_e, path: string) => {
    removeWorkspaceFromList(path)
    broadcast(CH.workspacesChanged, {})
    return wsList()
  })
  // 在 Finder / 资源管理器 / 文件管理器中打开该目录。走宿主能力 —— 远程时「打开」这件事
  // 只在客户端那台机器上才有意义,daemon 那台没人看着屏幕。
  on(CH.revealPath, async (_e, path: string) => {
    const err = await caps.openPath(path)   // '' on success; non-empty error string otherwise
    return err ? { ok: false as const, error: err } : { ok: true as const }
  })
  // 用系统默认浏览器打开一个 http(s) 链接(仅放行 http/https,拒绝其它协议以免被当作命令/文件执行)。
  on(CH.openExternal, async (_e, url: string) => {
    try {
      const u = new URL(String(url))
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false as const, error: 'unsupported protocol' }
      await caps.openExternal(u.toString())
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── 用外部软件打开(「打开位置」下拉) ─────────────────────────────────────────
  // Extract an app's real icon → dataURL for the dropdown (best-effort; falls back to a glyph).
  // On macOS we read the bundle's own .icns first: the host's getFileIcon returns a generic
  // placeholder (an identical blank icon for every app) on some macOS builds. caps.fileIcon stays as
  // the fallback for apps without a standalone .icns (Assets.car system apps) and for other platforms.
  const openerIcon = async (appPath: string): Promise<string | undefined> => {
    // macOS: read the bundle's own .icns first (see readMacAppIcon). Windows: getFileIcon extracts
    // the icon embedded in the .exe, which is the real per-app icon — no special case needed.
    if (process.platform === 'darwin') {
      const real = await readMacAppIcon(appPath)
      if (real) return real
    }
    return caps.fileIcon(appPath)
  }
  // Launch one command from buildOpenCommand. macOS routes through the `open` helper; Windows
  // launches the app's .exe directly (there is no `open` there) — the shape is identical either way.
  const runOpen = (cmd: LaunchCommand) => new Promise<void>((res, rej) => {
    execFile(cmd.exe, cmd.args, (err) => (err ? rej(err) : res()))
  })
  let openersCache: DetectedOpener[] = []
  on(CH.openersDetect, async (_e, refresh?: boolean) => {
    openersCache = await detectOpeners(openerIcon, !!refresh)
    return openersCache
  })
  on(CH.openersOpen, async (_e, arg: { openerId: string; folder: string; file?: string }) => {
    let op = resolveOpener(arg.openerId, openersCache)
    // Cold cache (renderer never called detect this session) — populate once, then retry.
    if (!op) { openersCache = await detectOpeners(openerIcon, false); op = resolveOpener(arg.openerId, openersCache) }
    if (!op) return { ok: false as const, error: '未找到该软件' }
    // Lazy refresh: the app was deleted since detection — drop it from the cache + persist, and tell
    // the renderer to remove it too (removedId), instead of forcing a full rescan.
    if (!existsSync(op.appPath)) {
      openersCache = withoutOpener(openersCache, op.id)
      try { writeJsonAtomic(openersCacheFile(), { v: OPENERS_CACHE_VERSION, apps: openersCache }) } catch { /* best-effort */ }
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
    const cmds = buildOpenCommand(process.platform, op.openMode, op.appPath, { folder: arg.folder, file: arg.file }, op.argStyle)
    try { for (const cmd of cmds) await runOpen(cmd); return { ok: true as const } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })
  on(CH.workspacesOpenDir, async (_e, explicitPath?: string) => {
    // 带路径 = 客户端已经用服务端目录选择器选好了(远程场景),不需要再弹本地对话框 ——
    // 也正因为如此,这个 handler 在无头 daemon 上照样能用。
    const [dir] = explicitPath ? [explicitPath] : await caps.pickPaths({ kind: 'directory' })
    if (dir) {
      const wsJson = join(dir, '.forge', 'workspace.json')
      if (existsSync(wsJson)) {
        try { const ws = JSON.parse(readFileSync(wsJson, 'utf8')); if (ws?.name) registerWorkspace(String(ws.name), dir) } catch { /* ignore malformed */ }
      }
    }
    // The legacy in-memory orchestrator run is gone; run2 runs don't surface a "live path" here.
    const livePath = undefined
    return listWorkspaces(livePath, readSettings().pinnedWorkspaces)
  })

  on(CH.configExportProjects, async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return caps.saveFile(`myFlowForge-projects-${stamp}.json`, JSON.stringify(readProjects(), null, 2), '导出项目配置')
  })
  // 只出内容,不落盘 —— 连着远程时由路由器接上客户端的 client:save-file(见 router.ts)。
  on(CH.configExportProjectsData, () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return { name: `myFlowForge-projects-${stamp}.json`, content: JSON.stringify(readProjects(), null, 2), title: '导出项目配置' }
  })
  // 只落盘,不管内容从哪儿来。永远在**客户端**执行:保存对话框要弹在有人看着的那块屏幕上。
  on(CH.clientSaveFile, (_e, a: { name: string; content: string; title?: string }) =>
    caps.saveFile(String(a?.name ?? 'export.txt'), String(a?.content ?? ''), a?.title))

  // ── App debug log ───────────────────────────────────────────────────────────
  on(CH.appLogGet, () => getAppLog())
  on(CH.appLogClear, () => { clearAppLog(); return getAppLog() })
  on(CH.appLogExport, async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return caps.saveFile(`myFlowForge-debug-${stamp}.log`, formatAppLog(), '导出调试日志')
  })

  // Memory management (记忆面板): read/write/clear the three tiers directly. Decoupled from the
  // memory.enabled toggle — the user can always view/edit/clear stored memory regardless of the switch.
  on(CH.memoryRead, (_e, a: MemoryArg) => memoryRead(a))
  on(CH.tokenUsageAggregate, () => aggregateTokenUsage())
  on(CH.growthSignalGet, () => currentGrowthSignal())
  on(CH.memoryWrite, (_e, a: MemoryArg) => memoryWrite(a))
  on(CH.memoryClear, (_e, a: MemoryArg) => memoryClear(a))

  // 终端(PTY)。★挂在**这里**而不是宿主各自注册,是为了让它和别的方法共享同一条不变式:
  //  「方法只有一份」。它单独走 `register` 是因为要拿到完整的 `InvokeCtx`(出口 + 是谁 + 断线钩子),
  //  而上面那个 `on()` 兼容层只喂得出一个假 event。宿主想在退出时收拾 pty 就自己传一个进来。
  ;(terminal ?? createTerminalService()).register(table)

  return table
}
