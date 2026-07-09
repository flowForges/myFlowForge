import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../main/ipc/channels'
import type { EngineEvent, ResolvePayload, ChatEvent, ChangesEvent, ChatQueueEvent, SetupEvent, UpdateInfo, UpdateEvent } from '@shared/types'
import type { PluginSnapshot } from '@shared/plugins'

const api = {
  getSettings: () => ipcRenderer.invoke(CH.configGetSettings),
  setSettings: (s: unknown) => ipcRenderer.invoke(CH.configSetSettings, s),
  listProjects: () => ipcRenderer.invoke(CH.configListProjects),
  addProject: (input: { repoUrl: string; branch: string }) => ipcRenderer.invoke(CH.configAddProject, input),
  deleteProject: (id: string) => ipcRenderer.invoke(CH.configDeleteProject, id),
  updateProjectBranch: (input: { id: string; branch: string }) => ipcRenderer.invoke(CH.configUpdateProjectBranch, input),
  listWorkflows: () => ipcRenderer.invoke(CH.configListWorkflows),
  addWorkflow: (input: { name: string; stages: string[] }) => ipcRenderer.invoke(CH.configAddWorkflow, input),
  deleteWorkflow: (id: string) => ipcRenderer.invoke(CH.configDeleteWorkflow, id),
  updateWorkflow: (id: string, plugins: unknown[]) => ipcRenderer.invoke(CH.configUpdateWorkflow, { id, plugins }),
  updateStagePrompts: (id: string, stagePrompts: Record<string, string>) => ipcRenderer.invoke(CH.configUpdateWorkflow, { id, stagePrompts }),
  listHookLibrary: (): Promise<import('@shared/plugin').LibraryHook[]> => ipcRenderer.invoke(CH.hookLibraryList),
  saveHookLibrary: (hook: import('@shared/plugin').LibraryHook): Promise<import('@shared/plugin').LibraryHook[]> => ipcRenderer.invoke(CH.hookLibrarySave, hook),
  deleteHookLibrary: (id: string): Promise<import('@shared/plugin').LibraryHook[]> => ipcRenderer.invoke(CH.hookLibraryDelete, id),
  setHookLibrary: (hooks: import('@shared/plugin').LibraryHook[]): Promise<import('@shared/plugin').LibraryHook[]> => ipcRenderer.invoke(CH.hookLibrarySetAll, hooks),
  detectProviders: (opts?: { force?: boolean }) => ipcRenderer.invoke(CH.agentsDetect, opts),
  getAgentsConfig: () => ipcRenderer.invoke(CH.agentsGetConfig),
  setAgentBin: (id: string, bin: string) => ipcRenderer.invoke(CH.agentsSetBin, { id, bin }),
  addCustomAgent: (c: unknown) => ipcRenderer.invoke(CH.agentsAddCustom, c),
  removeCustomAgent: (id: string) => ipcRenderer.invoke(CH.agentsRemoveCustom, id),
  refreshModels: (providerId: string) => ipcRenderer.invoke(CH.agentsRefreshModels, providerId),
  setModels: (id: string, models: { id: string; label: string; description?: string }[]) => ipcRenderer.invoke(CH.agentsSetModels, { id, models }),
  scanContext: (workspacePath?: string) => ipcRenderer.invoke(CH.contextScan, workspacePath),
  scanGlobalContext: (): Promise<import('@shared/types').AgentContextMeta> => ipcRenderer.invoke(CH.contextScanGlobal),
  listSkills: (): Promise<import('@shared/types').InstalledSkill[]> => ipcRenderer.invoke(CH.skillsList),
  createWorkspace: (opts: unknown) => ipcRenderer.invoke(CH.workspaceCreate, opts),
  cancelSetup: (): Promise<void> => ipcRenderer.invoke(CH.workspaceCancelSetup),
  discardPartialWorkspace: (path: string): Promise<void> => ipcRenderer.invoke(CH.workspaceDiscardPartial, path),
  getWorkspace: (path: string) => ipcRenderer.invoke(CH.workspaceGet, path),
  setStageModel: (a: { path: string; stageKey: string; provider: string; model: string }) => ipcRenderer.invoke(CH.workspaceSetStageModel, a),
  editWorkspace: (a: { path: string; opts: unknown; runProjHooks?: boolean }) => ipcRenderer.invoke(CH.workspaceEdit, a),
  runWorkspace: (path: string) => ipcRenderer.invoke(CH.workspaceRun, path),
  startRun: (opts: unknown) => ipcRenderer.invoke(CH.engineStartRun, opts),
  resolve: (p: ResolvePayload) => ipcRenderer.invoke(CH.engineResolve, p),
  cancelRun: () => ipcRenderer.invoke(CH.engineCancel),
  resumeRun: (workspacePath: string, opts?: { provider?: string; model?: string }) => ipcRenderer.invoke(CH.engineResume, { workspacePath, ...(opts ?? {}) }),
  lastRun: (wsPath: string) => ipcRenderer.invoke(CH.engineLastRun, wsPath),
  onEngineEvent: (cb: (e: EngineEvent) => void) => {
    const listener = (_: unknown, e: EngineEvent) => cb(e)
    ipcRenderer.on(CH.engineEvent, listener)
    return () => ipcRenderer.removeListener(CH.engineEvent, listener)
  },
  onSetupEvent: (cb: (e: SetupEvent) => void) => {
    const listener = (_: unknown, e: SetupEvent) => cb(e)
    ipcRenderer.on(CH.workspaceSetup, listener)
    return () => ipcRenderer.removeListener(CH.workspaceSetup, listener)
  },
  sendChat: (payload: unknown, source?: string) => ipcRenderer.invoke(CH.chatSend, payload, source),
  chatCancelQueued: (a: { workspacePath: string; id: string }) => ipcRenderer.invoke(CH.chatCancelQueued, a),
  chatClearQueue: (a: { workspacePath: string }) => ipcRenderer.invoke(CH.chatClearQueue, a),
  chatStop: (a: { workspacePath: string }) => ipcRenderer.invoke(CH.chatStop, a),
  onChatQueueEvent: (cb: (e: ChatQueueEvent) => void) => {
    const listener = (_: unknown, e: ChatQueueEvent) => cb(e)
    ipcRenderer.on(CH.chatQueueEvent, listener)
    return () => ipcRenderer.removeListener(CH.chatQueueEvent, listener)
  },
  chatHistory: (workspacePath: string, sessionId: string) => ipcRenderer.invoke(CH.chatHistory, { workspacePath, sessionId }),
  sessionList: (wsPath: string) => ipcRenderer.invoke(CH.sessionList, wsPath),
  sessionNew: (wsPath: string) => ipcRenderer.invoke(CH.sessionNew, wsPath),
  sessionSwitch: (a: { workspacePath: string; sessionId: string }) => ipcRenderer.invoke(CH.sessionSwitch, a),
  sessionClose: (a: { workspacePath: string; sessionId: string }) => ipcRenderer.invoke(CH.sessionClose, a),
  sessionRename: (a: { workspacePath: string; sessionId: string; title: string }) => ipcRenderer.invoke(CH.sessionRename, a),
  sessionSetPermission: (a: { workspacePath: string; sessionId: string; mode: import('@shared/permissions').PermissionMode }) => ipcRenderer.invoke(CH.sessionSetPermission, a),
  sessionContinueFrom: (a: { wsPath: string; source: import('@shared/types').SourceId; externalId: string; title: string; filePaths: string[] }) => ipcRenderer.invoke(CH.sessionContinueFrom, a),
  agentSessionIds: (workspacePath: string, sessionId: string) => ipcRenderer.invoke(CH.sessionAgentIds, { workspacePath, sessionId }),
  chatResolve: (a: { id: string; decision: 'allow' | 'deny' | 'modify'; value?: string; workspacePath: string }) => ipcRenderer.invoke(CH.chatResolve, a),
  openFiles: () => ipcRenderer.invoke(CH.dialogOpenFiles),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(CH.dialogPickDirectory),
  pickFile: (): Promise<string | null> => ipcRenderer.invoke(CH.dialogPickFile),
  savePaste: (a: { workspacePath: string; name: string; dataBase64: string }) => ipcRenderer.invoke(CH.chatSavePaste, a),
  onChatEvent: (cb: (e: ChatEvent) => void) => {
    const listener = (_: unknown, e: ChatEvent) => cb(e)
    ipcRenderer.on(CH.chatEvent, listener)
    return () => ipcRenderer.removeListener(CH.chatEvent, listener)
  },
  gitChanges: (cwd: string) => ipcRenderer.invoke(CH.gitChanges, cwd),
  changesMulti: (cwds: string[]) => ipcRenderer.invoke(CH.changesMulti, cwds),
  gitDiff: (cwd: string, file: string) => ipcRenderer.invoke(CH.gitDiff, { cwd, file }),
  gitFile: (cwd: string, file: string) => ipcRenderer.invoke(CH.gitFile, { cwd, file }),
  fsTree: (cwd: string) => ipcRenderer.invoke(CH.fsTree, cwd),
  searchContent: (a: { root: string; query: string; files?: string[] }): Promise<import('@shared/types').ContentSearchResult> => ipcRenderer.invoke(CH.fileSearchContent, a),
  watchChanges: (cwd: string) => ipcRenderer.invoke(CH.watchChanges, cwd),
  watchStop: () => ipcRenderer.invoke(CH.watchStop),
  listWorkspaces: () => ipcRenderer.invoke(CH.workspacesList),
  homeStats: (): Promise<import('@shared/types').HomeStats> => ipcRenderer.invoke(CH.workspacesHomeStats),
  openWorkspaceDir: () => ipcRenderer.invoke(CH.workspacesOpenDir),
  setWorkspacePinned: (path: string, pinned: boolean) => ipcRenderer.invoke(CH.workspacesSetPinned, { path, pinned }),
  setWorkspaceOrder: (order: string[]) => ipcRenderer.invoke(CH.workspacesSetOrder, { order }),
  petSetExpanded: (mode: 'collapsed' | 'bubble' | 'expanded'): Promise<'up' | 'down'> => ipcRenderer.invoke(CH.petSetExpanded, mode),
  petFocusWorkspace: (path: string) => ipcRenderer.invoke(CH.petFocusWorkspace, path),
  petSetPosition: (x: number, y: number) => ipcRenderer.invoke(CH.petSetPosition, { x, y }),
  petSetScale: (scale: number): Promise<'up' | 'down'> => ipcRenderer.invoke(CH.petSetScale, scale),
  petResizeBegin: (): Promise<void> => ipcRenderer.invoke(CH.petResizeBegin),
  petGetBounds: () => ipcRenderer.invoke(CH.petGetBounds),
  petSetIgnoreMouse: (ignore: boolean) => ipcRenderer.invoke(CH.petSetIgnoreMouse, ignore),
  pickPetPack: (petId: string): Promise<Record<string, string>> => ipcRenderer.invoke(CH.petPickPack, petId),
  pickPetImage: (petId: string, state?: string): Promise<{ path?: string; error?: string } | null> => ipcRenderer.invoke(CH.petPickImage, petId, state),
  onSettingsChanged: (cb: (s: unknown) => void) => {
    const listener = (_: unknown, s: unknown) => cb(s)
    ipcRenderer.on(CH.settingsChanged, listener)
    return () => ipcRenderer.removeListener(CH.settingsChanged, listener)
  },
  onSessionsChanged: (cb: (p: unknown) => void) => {
    const listener = (_: unknown, p: unknown) => cb(p)
    ipcRenderer.on(CH.sessionsChanged, listener)
    return () => ipcRenderer.removeListener(CH.sessionsChanged, listener)
  },
  onNavigateWorkspace: (cb: (p: { path: string }) => void) => {
    const listener = (_: unknown, p: { path: string }) => cb(p)
    ipcRenderer.on(CH.navigateWorkspace, listener)
    return () => ipcRenderer.removeListener(CH.navigateWorkspace, listener)
  },
  // Main renderer: report the workspace currently open in the main window (or null on home) to the pet.
  setActiveWorkspace: (path: string | null) => ipcRenderer.invoke(CH.setPetActiveWorkspace, path),
  // Pet window: subscribe to the main window's active workspace (null on home).
  onActiveWorkspace: (cb: (path: string | null) => void) => {
    const listener = (_: unknown, path: string | null) => cb(path)
    ipcRenderer.on(CH.petActiveWorkspace, listener)
    return () => ipcRenderer.removeListener(CH.petActiveWorkspace, listener)
  },
  onChangesEvent: (cb: (e: ChangesEvent) => void) => {
    const listener = (_: unknown, e: ChangesEvent) => cb(e)
    ipcRenderer.on(CH.changesEvent, listener)
    return () => ipcRenderer.removeListener(CH.changesEvent, listener)
  },
  getUpdate: (): Promise<{ currentVersion: string; info: UpdateInfo | null }> => ipcRenderer.invoke(CH.updateGet),
  checkUpdate: (): Promise<void> => ipcRenderer.invoke(CH.updateCheck),
  startUpdate: (): Promise<void> => ipcRenderer.invoke(CH.updateStart),
  onUpdateEvent: (cb: (e: UpdateEvent) => void) => {
    const map: Array<[string, (p: any) => UpdateEvent]> = [
      [CH.updateAvailable, (p) => ({ type: 'available', info: p.info })],
      [CH.updateNone, () => ({ type: 'none' })],
      [CH.updateCheckFailed, (p) => ({ type: 'checkfailed', message: p?.message ?? '' })],
      [CH.updateProgress, (p) => ({ type: 'progress', stage: p.stage, pct: p.pct, log: p.log })],
      [CH.updateDone, () => ({ type: 'done' })],
      [CH.updateError, (p) => ({ type: 'error', message: p.message })],
    ]
    const unsubs = map.map(([ch, conv]) => {
      const listener = (_: unknown, p: any) => cb(conv(p))
      ipcRenderer.on(ch, listener)
      return () => ipcRenderer.removeListener(ch, listener)
    })
    return () => unsubs.forEach(u => u())
  },
  windowMinimize: () => ipcRenderer.invoke(CH.windowMinimize),
  windowToggleMaximize: () => ipcRenderer.invoke(CH.windowToggleMaximize),
  windowClose: () => ipcRenderer.invoke(CH.windowClose),
  appRelaunch: () => ipcRenderer.invoke(CH.appRelaunch),
  getAppIconOptions: (): Promise<Array<{ id: import('@shared/types').DockIcon; label: string; filename: string; src: string }>> => ipcRenderer.invoke(CH.appIconOptions),
  termCreate: (opts: { termId: string; cwd?: string; cols: number; rows: number }) => ipcRenderer.invoke(CH.termCreate, opts),
  termWrite: (termId: string, data: string) => ipcRenderer.send(CH.termWrite, { termId, data }),
  termResize: (termId: string, cols: number, rows: number) => ipcRenderer.send(CH.termResize, { termId, cols, rows }),
  termKill: (termId: string) => ipcRenderer.send(CH.termKill, { termId }),
  onTermData: (cb: (p: { termId: string; data: string }) => void) => {
    const l = (_: unknown, p: { termId: string; data: string }) => cb(p)
    ipcRenderer.on(CH.termData, l); return () => ipcRenderer.removeListener(CH.termData, l)
  },
  onTermCwd: (cb: (p: { termId: string; cwd: string }) => void) => {
    const l = (_: unknown, p: { termId: string; cwd: string }) => cb(p)
    ipcRenderer.on(CH.termCwd, l); return () => ipcRenderer.removeListener(CH.termCwd, l)
  },
  onTermExit: (cb: (p: { termId: string; exitCode: number; signal?: number }) => void) => {
    const l = (_: unknown, p: { termId: string; exitCode: number; signal?: number }) => cb(p)
    ipcRenderer.on(CH.termExit, l); return () => ipcRenderer.removeListener(CH.termExit, l)
  },
  listPlugins: (): Promise<PluginSnapshot> => ipcRenderer.invoke(CH.pluginsList),
  installPlugin: (dir: string) => ipcRenderer.invoke(CH.pluginsInstall, dir),
  uninstallPlugin: (id: string) => ipcRenderer.invoke(CH.pluginsUninstall, id),
  setPluginEnabled: (a: { id: string; enabled: boolean }) => ipcRenderer.invoke(CH.pluginsSetEnabled, a),
  refreshPlugins: (id?: string) => ipcRenderer.invoke(CH.pluginsRefresh, id),
  listPluginCatalog: (): Promise<import('@shared/plugins').CatalogEntry[]> => ipcRenderer.invoke(CH.pluginsCatalog),
  installExamplePlugin: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(CH.pluginsInstallExample, id),
  getPluginCreds: (): Promise<Record<string, string>> => ipcRenderer.invoke(CH.pluginsGetCreds),
  setPluginCred: (provider: string, value: string): Promise<Record<string, string>> => ipcRenderer.invoke(CH.pluginsSetCred, { provider, value }),
  onPluginsChanged: (cb: (snap: PluginSnapshot) => void) => {
    const listener = (_: unknown, snap: PluginSnapshot) => cb(snap)
    ipcRenderer.on(CH.pluginsChanged, listener)
    return () => ipcRenderer.removeListener(CH.pluginsChanged, listener)
  },
  sessionImportScan: (): Promise<import('@shared/types').ScanResult> => ipcRenderer.invoke(CH.sessionImportScan),
  sessionImportLastScan: (): Promise<import('@shared/types').ScanCache | null> => ipcRenderer.invoke(CH.sessionImportLastScan),
  sessionImportRun: (sessions: import('@shared/types').DiscoveredSession[]): Promise<import('@shared/types').ImportResult> => ipcRenderer.invoke(CH.sessionImportRun, sessions),
  sessionImportRead: (s: import('@shared/types').DiscoveredSession): Promise<import('@shared/types').ImportedMessage[]> => ipcRenderer.invoke(CH.sessionImportRead, s),
  sessionImportList: (): Promise<import('@shared/types').ImportedIndex> => ipcRenderer.invoke(CH.sessionImportList),
  sessionImportCoverage: (): Promise<import('@shared/types').SessionImportCoverage> => ipcRenderer.invoke(CH.sessionImportCoverage),
  archiveWorkspace: (path: string) => ipcRenderer.invoke(CH.workspaceArchive, path),
  restoreWorkspace: (path: string) => ipcRenderer.invoke(CH.workspaceRestore, path),
  deleteWorkspace: (path: string) => ipcRenderer.invoke(CH.workspaceDelete, path),
  removeWorkspaceFromList: (path: string) => ipcRenderer.invoke(CH.workspaceRemove, path),
  revealPath: (path: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(CH.revealPath, path),
  openExternal: (url: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(CH.openExternal, url),
  detectOpeners: (refresh?: boolean): Promise<import('@shared/openers').DetectedOpener[]> => ipcRenderer.invoke(CH.openersDetect, refresh),
  openWith: (arg: { openerId: string; folder: string; file?: string }): Promise<{ ok: boolean; error?: string; removedId?: string }> => ipcRenderer.invoke(CH.openersOpen, arg),
  commandsList: (providerId: string, wsPath?: string): Promise<{ cmd: string; title: string; desc: string; template: string; kind: 'command' | 'skill' }[]> => ipcRenderer.invoke(CH.commandsList, providerId, wsPath),
  onWorkspacesChanged: (cb: () => void) => {
    const h = () => cb()
    ipcRenderer.on(CH.workspacesChanged, h)
    return () => ipcRenderer.removeListener(CH.workspacesChanged, h)
  },
  getShortcutStatus: (): Promise<{ failed: string[] }> => ipcRenderer.invoke(CH.shortcutsGetStatus),
  onShortcutStatus: (cb: (s: { failed: string[] }) => void) => {
    const listener = (_: unknown, s: { failed: string[] }) => cb(s)
    ipcRenderer.on(CH.shortcutsStatus, listener)
    return () => ipcRenderer.removeListener(CH.shortcutsStatus, listener)
  },
  appLogGet: (): Promise<import('@shared/types').AppLogEntry[]> => ipcRenderer.invoke(CH.appLogGet),
  appLogClear: (): Promise<import('@shared/types').AppLogEntry[]> => ipcRenderer.invoke(CH.appLogClear),
  appLogExport: (): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> => ipcRenderer.invoke(CH.appLogExport),
  onAppLogEvent: (cb: (e: import('@shared/types').AppLogEntry) => void) => {
    const listener = (_: unknown, e: import('@shared/types').AppLogEntry) => cb(e)
    ipcRenderer.on(CH.appLogEvent, listener)
    return () => ipcRenderer.removeListener(CH.appLogEvent, listener)
  },
  onPerfStall: (cb: (p: { msg: string }) => void): (() => void) => {
    const h = (_e: unknown, p: { msg: string }) => cb(p)
    ipcRenderer.on(CH.perfStall, h)
    return () => ipcRenderer.removeListener(CH.perfStall, h)
  },
}
contextBridge.exposeInMainWorld('forge', api)
export type ForgeApi = typeof api
