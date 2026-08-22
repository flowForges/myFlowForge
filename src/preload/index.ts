import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../main/ipc/channels'
import type { AskAnswers, ChatEvent, ChangesEvent, ChatGateSnapshot, ChatQueueEvent, SetupEvent, UpdateInfo, UpdateEvent } from '@shared/types'
import type { PluginSnapshot } from '@shared/plugins'
import type { HostInput, HostStatusView, RemoteHostView } from '@shared/remote/hostView'

const api = {
  // Which OS this window is drawn on. A plain constant, not an IPC call: the renderer needs it during
  // the FIRST paint (window-control layout, native material buckets) and an await would flash the
  // wrong chrome. Note this is the CLIENT's platform — the machine showing the pixels.
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke(CH.configGetSettings),
  setSettings: (s: unknown) => ipcRenderer.invoke(CH.configSetSettings, s),
  listProjects: () => ipcRenderer.invoke(CH.configListProjects),
  addProject: (input: { repoUrl: string; branch: string; alias?: string }) => ipcRenderer.invoke(CH.configAddProject, input),
  deleteProject: (id: string) => ipcRenderer.invoke(CH.configDeleteProject, id),
  updateProjectBranch: (input: { id: string; branch: string }) => ipcRenderer.invoke(CH.configUpdateProjectBranch, input),
  updateProjectAlias: (input: { id: string; alias: string }) => ipcRenderer.invoke(CH.configUpdateProjectAlias, input),
  listWorkflows: () => ipcRenderer.invoke(CH.configListWorkflows),
  // stages: bare keys (built-in defaults) or full stage configs (custom stages), in order.
  addWorkflow: (input: { name: string; stages: unknown[] }) => ipcRenderer.invoke(CH.configAddWorkflow, input),
  deleteWorkflow: (id: string) => ipcRenderer.invoke(CH.configDeleteWorkflow, id),
  updateWorkflow: (id: string, plugins: unknown[]) => ipcRenderer.invoke(CH.configUpdateWorkflow, { id, plugins }),
  updateStagePrompts: (id: string, stagePrompts: Record<string, string>) => ipcRenderer.invoke(CH.configUpdateWorkflow, { id, stagePrompts }),
  updateWorkflowStages: (id: string, stages: unknown[]) => ipcRenderer.invoke(CH.configUpdateWorkflow, { id, stages }),
  listHookLibrary: (): Promise<import('@shared/plugin').LibraryHook[]> => ipcRenderer.invoke(CH.hookLibraryList),
  saveHookLibrary: (hook: import('@shared/plugin').LibraryHook): Promise<import('@shared/plugin').LibraryHook[]> => ipcRenderer.invoke(CH.hookLibrarySave, hook),
  deleteHookLibrary: (id: string): Promise<import('@shared/plugin').LibraryHook[]> => ipcRenderer.invoke(CH.hookLibraryDelete, id),
  setHookLibrary: (hooks: import('@shared/plugin').LibraryHook[]): Promise<import('@shared/plugin').LibraryHook[]> => ipcRenderer.invoke(CH.hookLibrarySetAll, hooks),
  listCustomStages: (): Promise<import('@shared/customStages').CustomStageDef[]> => ipcRenderer.invoke(CH.customStagesList),
  upsertCustomStage: (def: unknown): Promise<import('@shared/customStages').CustomStageDef[]> => ipcRenderer.invoke(CH.customStagesUpsert, def),
  deleteCustomStage: (id: string): Promise<import('@shared/customStages').CustomStageDef[]> => ipcRenderer.invoke(CH.customStagesDelete, id),
  onCustomStagesChanged: (cb: (list: import('@shared/customStages').CustomStageDef[]) => void) => {
    const listener = (_: unknown, list: import('@shared/customStages').CustomStageDef[]) => cb(list)
    ipcRenderer.on(CH.customStagesChanged, listener)
    return () => ipcRenderer.removeListener(CH.customStagesChanged, listener)
  },
  detectProviders: (opts?: { force?: boolean }) => ipcRenderer.invoke(CH.agentsDetect, opts),
  getAgentsConfig: () => ipcRenderer.invoke(CH.agentsGetConfig),
  setAgentBin: (id: string, bin: string) => ipcRenderer.invoke(CH.agentsSetBin, { id, bin }),
  addCustomAgent: (c: unknown) => ipcRenderer.invoke(CH.agentsAddCustom, c),
  removeCustomAgent: (id: string) => ipcRenderer.invoke(CH.agentsRemoveCustom, id),
  refreshModels: (providerId: string) => ipcRenderer.invoke(CH.agentsRefreshModels, providerId),
  setModels: (id: string, models: { id: string; label: string; description?: string }[]) => ipcRenderer.invoke(CH.agentsSetModels, { id, models }),
  setTimezone: (id: string, timezone: string): Promise<void> => ipcRenderer.invoke(CH.agentsSetTimezone, { id, timezone }),
  checkExitIp: (): Promise<{ ip: string; region: string; via: 'proxy' | 'direct' }> => ipcRenderer.invoke(CH.netCheckExitIp),
  // 查各 CLI 是否有新版(只提示):传入已探测到的安装版本,返回可确定有/无新版的那些(未知包/查不到的略过)。
  checkCliUpdates: (installed: { id: string; version?: string }[]): Promise<import('../main/agents/cliLatest').CliUpdateInfo[]> => ipcRenderer.invoke(CH.agentsCliUpdates, installed),
  scanContext: (workspacePath?: string) => ipcRenderer.invoke(CH.contextScan, workspacePath),
  scanGlobalContext: (): Promise<import('@shared/types').AgentContextMeta> => ipcRenderer.invoke(CH.contextScanGlobal),
  listSkills: (): Promise<import('@shared/types').InstalledSkill[]> => ipcRenderer.invoke(CH.skillsList),
  createWorkspace: (opts: unknown) => ipcRenderer.invoke(CH.workspaceCreate, opts),
  cancelSetup: (): Promise<void> => ipcRenderer.invoke(CH.workspaceCancelSetup),
  discardPartialWorkspace: (path: string): Promise<void> => ipcRenderer.invoke(CH.workspaceDiscardPartial, path),
  getWorkspace: (path: string) => ipcRenderer.invoke(CH.workspaceGet, path),
  // Batch-3/Task3: scan a folder for existing git repos (bounded, recursive) with their current
  // branch — for the "create workspace from existing folder" form to prepopulate.
  scanRepos: (path: string): Promise<import('@shared/types').DetectedRepo[]> => ipcRenderer.invoke(CH.workspaceScanRepos, path),
  setStageModel: (a: { path: string; stageKey: string; provider: string; model: string }) => ipcRenderer.invoke(CH.workspaceSetStageModel, a),
  editWorkspace: (a: { path: string; opts: unknown; runProjHooks?: boolean }) => ipcRenderer.invoke(CH.workspaceEdit, a),
  renameWorkspace: (a: { path: string; name: string }) => ipcRenderer.invoke(CH.workspaceRename, a),
  // The legacy orchestrator run channels (startRun/resumeRun/resolve/cancel/discard/lastRun/engineEvent)
  // have been removed entirely — run2 (see run2LaunchStart below) is the only workflow-run path now.
  onSetupEvent: (cb: (e: SetupEvent) => void) => {
    const listener = (_: unknown, e: SetupEvent) => cb(e)
    ipcRenderer.on(CH.workspaceSetup, listener)
    return () => ipcRenderer.removeListener(CH.workspaceSetup, listener)
  },
  // #13: answer a setup hook's confirm/input card.
  resolveSetupInteraction: (id: string, answer: { decision?: 'allow' | 'deny'; value?: string }) => ipcRenderer.invoke(CH.workspaceSetupResolve, { id, answer }),
  sendChat: (payload: unknown, source?: string) => ipcRenderer.invoke(CH.chatSend, payload, source),
  chatQueueState: (a: { workspacePath: string }): Promise<ChatQueueEvent> => ipcRenderer.invoke(CH.chatQueueState, a),
  // 还挂着、等人回答的确认/提问门。聊天视图每次挂载都拉一次 —— 它自己的 state 是空的,门却还在主进程阻塞着。
  chatGateState: (a: { workspacePath: string }): Promise<ChatGateSnapshot> => ipcRenderer.invoke(CH.chatGateState, a),
  chatCancelQueued: (a: { workspacePath: string; id: string }) => ipcRenderer.invoke(CH.chatCancelQueued, a),
  chatClearQueue: (a: { workspacePath: string }) => ipcRenderer.invoke(CH.chatClearQueue, a),
  chatStop: (a: { workspacePath: string; sessionId?: string }) => ipcRenderer.invoke(CH.chatStop, a),
  // reproposeWorkflow (old PlanCard workflow-switch → orch.startRun) removed — see channels.ts note.
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
  chatSwitchSummary: (a: { workspacePath: string; sessionId: string; toAgent: string; model: string }) => ipcRenderer.invoke(CH.chatSwitchSummary, a),
  chatSummarizeRequirement: (a: { workspacePath: string; sessionId: string; agent: string; model: string }): Promise<string> => ipcRenderer.invoke(CH.chatSummarizeRequirement, a),
  // P1-5: persist a confirmed launch-gate's frozen record onto the session (see WorkspaceView's
  // confirmLaunchGate) so it survives reload/session-switch.
  chatAppendLaunchGate: (a: {
    workspacePath: string; sessionId: string; id: string; ts: string
    workflowName: string; projects: string[]; supplement: string; decidedAt: number; seed: string
  }) => ipcRenderer.invoke(CH.chatAppendLaunchGate, a),
  // P3-4: persist a resolved run2 event's frozen record onto the session (see WorkspaceView's
  // freezeRunCard) so it survives reload/session-switch. Mirrors chatAppendLaunchGate above.
  chatAppendRunCard: (a: {
    workspacePath: string; sessionId: string; ts: string
    runCard: import('@shared/types').ChatMessage['runCard']
  }) => ipcRenderer.invoke(CH.chatAppendRunCard, a),
  notifyTest: (): Promise<{ supported: boolean }> => ipcRenderer.invoke(CH.notifyTest),
  sessionSetModel: (a: { workspacePath: string; sessionId: string; agentId: string; modelId: string }) => ipcRenderer.invoke(CH.sessionSetModel, a),
  sessionContinueFrom: (a: { wsPath: string; source: import('@shared/types').SourceId; externalId: string; title: string; filePaths: string[] }) => ipcRenderer.invoke(CH.sessionContinueFrom, a),
  // 对话式工作流(2026-07-30):进入/推进/退出。enter 收启动门同款配置(LaunchStartConfig 结构),返回 WorkflowSessionState。
  workflowEnter: (cfg: { workspacePath: string; workflowId: string; projects: { name: string; provider: string; model: string; permissionMode?: import('@shared/permissions').PermissionMode }[]; supplement: string; seed: string; sessionId?: string; stages?: { key: string; enabled: boolean; provider?: string; model?: string; perProject?: boolean; permissionMode?: import('@shared/permissions').PermissionMode }[]; hooks?: { id: string; enabled: boolean }[] }) => ipcRenderer.invoke(CH.workflowEnter, cfg),
  workflowAdvance: (a: { workspacePath: string; sessionId: string; handoffText?: string; briefs?: Record<string, string>; skip?: string[] }) => ipcRenderer.invoke(CH.workflowAdvance, a),
  workflowExit: (a: { workspacePath: string; sessionId: string }) => ipcRenderer.invoke(CH.workflowExit, a),
  workflowPrepareBriefs: (a: { workspacePath: string; stageKey: string; projects: string[] }): Promise<{ docExists: boolean; docPath: string; sections: Record<string, string> }> => ipcRenderer.invoke(CH.workflowPrepareBriefs, a),
  workflowFinish: (a: { workspacePath: string; sessionId: string }) => ipcRenderer.invoke(CH.workflowFinish, a),
  agentSessionIds: (workspacePath: string, sessionId: string) => ipcRenderer.invoke(CH.sessionAgentIds, { workspacePath, sessionId }),
  // answers/response:AskUserQuestion 门上用户选的选项 / 自填答案(见 shared/types 的 AskQuestion)。
  chatResolve: (a: { id: string; decision: 'allow' | 'deny' | 'modify'; value?: string; choice?: number; answers?: AskAnswers; response?: string; selection?: { stages: string[]; stageProjects: Record<string, string[]> }; workspacePath: string }) => ipcRenderer.invoke(CH.chatResolve, a),
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
  imageFile: (cwd: string, file: string): Promise<{ dataUrl: string } | { error: string }> => ipcRenderer.invoke(CH.imageFile, { cwd, file }),
  // 对话正文里的文件链接:点击时才解析(渲染时不探测,否则每条消息都要打一批 IPC 且会闪)。
  resolveFileRef: (bases: string[], href: string): Promise<
    { ok: true; cwd: string; file: string; abs: string } | { ok: false; reason: 'missing' | 'outside' | 'dir' | 'bad' }
  > => ipcRenderer.invoke(CH.resolveFileRef, { bases, href }),
  // 用系统默认程序打开(pdf/xlsx/… 与 .html 的「用浏览器打开」)。
  openFilePath: (bases: string[], href: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CH.openFilePath, { bases, href }),
  fsTree: (cwd: string) => ipcRenderer.invoke(CH.fsTree, cwd),
  gitBranch: (cwd: string) => ipcRenderer.invoke(CH.gitBranch, cwd),
  searchContent: (a: { root: string; query: string; files?: string[] }): Promise<import('@shared/types').ContentSearchResult> => ipcRenderer.invoke(CH.fileSearchContent, a),
  watchChanges: (cwd: string) => ipcRenderer.invoke(CH.watchChanges, cwd),
  watchStop: () => ipcRenderer.invoke(CH.watchStop),
  listWorkspaces: () => ipcRenderer.invoke(CH.workspacesList),
  homeStats: (): Promise<import('@shared/types').HomeStats> => ipcRenderer.invoke(CH.workspacesHomeStats),
  openWorkspaceDir: () => ipcRenderer.invoke(CH.workspacesOpenDir),
  setWorkspacePinned: (path: string, pinned: boolean) => ipcRenderer.invoke(CH.workspacesSetPinned, { path, pinned }),
  setWorkspaceOrder: (order: string[]) => ipcRenderer.invoke(CH.workspacesSetOrder, { order }),
  petSetExpanded: (mode: 'collapsed' | 'bubble' | 'expanded'): Promise<'up' | 'down'> => ipcRenderer.invoke(CH.petSetExpanded, mode),
  // sessionId 可选:宠物气泡上的「去 app 处理」要落到发起这次确认的那个会话,只给工作区会跳到当前会话。
  petFocusWorkspace: (path: string, sessionId?: string) => ipcRenderer.invoke(CH.petFocusWorkspace, path, sessionId),
  petSetPosition: (x: number, y: number) => ipcRenderer.invoke(CH.petSetPosition, { x, y }),
  petSetScale: (scale: number): Promise<'up' | 'down'> => ipcRenderer.invoke(CH.petSetScale, scale),
  petResizeBegin: (): Promise<void> => ipcRenderer.invoke(CH.petResizeBegin),
  petGetBounds: () => ipcRenderer.invoke(CH.petGetBounds),
  petSetIgnoreMouse: (ignore: boolean) => ipcRenderer.invoke(CH.petSetIgnoreMouse, ignore),
  petContextMenu: (): Promise<void> => ipcRenderer.invoke(CH.petContextMenu),
  pickPetPack: (petId: string): Promise<{ name: string; images: Record<string, string> } | null> => ipcRenderer.invoke(CH.petPickPack, petId),
  pickPetImage: (petId: string, state?: string): Promise<{ path?: string; error?: string } | null> => ipcRenderer.invoke(CH.petPickImage, petId, state),
  codexPetImport: (dir: string): Promise<{ ok: true; pet: import('@shared/petCustom').CustomPet } | { ok: false; error: string }> => ipcRenderer.invoke(CH.codexPetImport, dir),
  codexPetList: (): Promise<{ id: string; displayName: string; dir: string }[]> => ipcRenderer.invoke(CH.codexPetList),
  codexPetPick: (): Promise<{ ok: true; pet: import('@shared/petCustom').CustomPet } | { ok: false; error: string } | null> => ipcRenderer.invoke(CH.codexPetPick),
  pickBgImage: (): Promise<{ url?: string; error?: string } | null> => ipcRenderer.invoke(CH.appearancePickBgImage),
  // Downloadable fonts. A DownloadedFont carries { id, family, css } — css is the rewritten @font-face
  // block the renderer injects to make the font usable.
  fontsListDownloaded: (): Promise<{ id: string; family: string; css: string }[]> => ipcRenderer.invoke(CH.fontsListDownloaded),
  fontsDownload: (id: string): Promise<{ font?: { id: string; family: string; css: string }; error?: string }> => ipcRenderer.invoke(CH.fontsDownload, id),
  fontsDelete: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(CH.fontsDelete, id),
  onFontDownloadProgress: (cb: (p: { id: string; done: number; total: number }) => void) => {
    const listener = (_: unknown, p: { id: string; done: number; total: number }) => cb(p)
    ipcRenderer.on(CH.fontsDownloadProgress, listener)
    return () => ipcRenderer.removeListener(CH.fontsDownloadProgress, listener)
  },
  // License-gated extra content (NSFW). validate a code, list the gated catalog, install a pet/background.
  nsfwValidate: (code: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(CH.nsfwValidate, code),
  nsfwCatalog: (): Promise<import('@shared/nsfw').NsfwCatalog | { error: string }> => ipcRenderer.invoke(CH.nsfwCatalog),
  nsfwPreview: (kind: 'pet' | 'bg', id: string): Promise<{ url: string } | { error: string }> => ipcRenderer.invoke(CH.nsfwPreview, kind, id),
  nsfwGallery: (force?: boolean): Promise<import('@shared/nsfw').NsfwGallery | { error: string; rateLimited?: boolean }> => ipcRenderer.invoke(CH.nsfwGallery, force),
  onNsfwPreview: (cb: (e: import('@shared/nsfw').NsfwPreviewEvent) => void): (() => void) => {
    const h = (_: unknown, ev: import('@shared/nsfw').NsfwPreviewEvent) => cb(ev)
    ipcRenderer.on(CH.nsfwPreviewEvent, h)
    return () => ipcRenderer.removeListener(CH.nsfwPreviewEvent, h)
  },
  nsfwInstallPet: (petId: string, pet: import('@shared/nsfw').NsfwPet): Promise<{ name: string; images: Record<string, string> } | { error: string }> => ipcRenderer.invoke(CH.nsfwInstallPet, petId, pet),
  nsfwInstallBg: (bg: import('@shared/nsfw').NsfwBg): Promise<{ url: string } | { error: string }> => ipcRenderer.invoke(CH.nsfwInstallBg, bg),
  nsfwBgExists: (url: string): Promise<{ exists: boolean }> => ipcRenderer.invoke(CH.nsfwBgExists, url),
  // Built-in wallpapers (no activation code). List the public catalog, preview a thumbnail, install a full image.
  wallpaperCatalog: (): Promise<import('@shared/wallpaper').WallpaperCatalog | { error: string }> => ipcRenderer.invoke(CH.wallpaperCatalog),
  wallpaperPreview: (item: import('@shared/wallpaper').WallpaperItem): Promise<{ url: string } | { error: string }> => ipcRenderer.invoke(CH.wallpaperPreview, item),
  wallpaperInstall: (item: import('@shared/wallpaper').WallpaperItem): Promise<{ url: string } | { error: string }> => ipcRenderer.invoke(CH.wallpaperInstall, item),
  // Downloadable pet packs (no activation code). List the public catalog, preview a pack, install its frames.
  petPackCatalog: (): Promise<import('@shared/petPack').PetPackCatalog | { error: string }> => ipcRenderer.invoke(CH.petPackCatalog),
  petPackPreview: (item: { thumb: string }): Promise<{ url: string } | { error: string }> => ipcRenderer.invoke(CH.petPackPreview, item),
  petPackInstall: (petId: string, item: import('@shared/petPack').PetPackItem): Promise<{ name: string; images: Record<string, string> } | { error: string }> => ipcRenderer.invoke(CH.petPackInstall, petId, item),
  growthPackInstall: (petId: string, item: import('@shared/petPack').GrowthPackItem) => ipcRenderer.invoke(CH.growthPackInstall, petId, item),
  codexMarketCatalog: (page: number): Promise<import('@shared/codexPetMarket').CodexMarketPage | { error: string }> => ipcRenderer.invoke(CH.codexMarketCatalog, page),
  codexMarketPreview: (url: string): Promise<{ url: string } | { error: string }> => ipcRenderer.invoke(CH.codexMarketPreview, url),
  codexMarketInstall: (item: import('@shared/codexPetMarket').CodexMarketPet): Promise<{ ok: true; pet: import('@shared/petCustom').CustomPet } | { ok: false; error: string }> => ipcRenderer.invoke(CH.codexMarketInstall, item),
  onSettingsChanged: (cb: (s: unknown) => void) => {
    const listener = (_: unknown, s: unknown) => cb(s)
    ipcRenderer.on(CH.settingsChanged, listener)
    return () => ipcRenderer.removeListener(CH.settingsChanged, listener)
  },
  // Bot bridge (钉钉/Telegram/飞书)
  botConnect: (platform: import('@shared/types').BotPlatform): Promise<Record<string, import('@shared/types').BotStatus>> => ipcRenderer.invoke(CH.botConnect, { platform }),
  botDisconnect: (platform: import('@shared/types').BotPlatform): Promise<Record<string, import('@shared/types').BotStatus>> => ipcRenderer.invoke(CH.botDisconnect, { platform }),
  botGetStatus: (): Promise<Record<string, import('@shared/types').BotStatus>> => ipcRenderer.invoke(CH.botGetStatus),
  botRegenPairing: (): Promise<string> => ipcRenderer.invoke(CH.botRegenPairing),
  botUnbind: (chatId: string): Promise<unknown> => ipcRenderer.invoke(CH.botUnbind, { chatId }),
  onBotStatus: (cb: (e: import('@shared/types').BotStatusEvent) => void) => {
    const listener = (_: unknown, e: import('@shared/types').BotStatusEvent) => cb(e)
    ipcRenderer.on(CH.botStatusEvent, listener)
    return () => ipcRenderer.removeListener(CH.botStatusEvent, listener)
  },
  onSessionsChanged: (cb: (p: unknown) => void) => {
    const listener = (_: unknown, p: unknown) => cb(p)
    ipcRenderer.on(CH.sessionsChanged, listener)
    return () => ipcRenderer.removeListener(CH.sessionsChanged, listener)
  },
  onMenuAction: (cb: (action: string) => void) => {
    const listener = (_: unknown, action: string) => cb(action)
    ipcRenderer.on(CH.menuAction, listener)
    return () => ipcRenderer.removeListener(CH.menuAction, listener)
  },
  onNavigateWorkspace: (cb: (p: { path: string; sessionId?: string }) => void) => {
    const listener = (_: unknown, p: { path: string; sessionId?: string }) => cb(p)
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
  // Pet window: heading from the pet to the cursor (null in the deadzone) for look-at-cursor.
  onPetLookAngle: (cb: (deg: number | null) => void) => {
    const listener = (_: unknown, deg: number | null) => cb(deg)
    ipcRenderer.on(CH.petLookAngle, listener)
    return () => ipcRenderer.removeListener(CH.petLookAngle, listener)
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
  windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke(CH.windowIsMaximized),
  onWindowMaximized: (cb: (maximized: boolean) => void) => {
    const listener = (_: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on(CH.windowMaximizedChanged, listener)
    // Braces matter: removeListener returns the IpcRenderer, and a React effect cleanup must return void.
    return () => { ipcRenderer.removeListener(CH.windowMaximizedChanged, listener) }
  },
  appRelaunch: () => ipcRenderer.invoke(CH.appRelaunch),
  appVibrancyBaseline: (): Promise<number> => ipcRenderer.invoke(CH.appVibrancyBaseline),
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

  // ── 多主机(第二期 B)。★注意这里没有第二套传输:渲染层永远走 IPC 找主进程,
  //    「这一刀由本机接还是转发给远程」是主进程里路由器的判断,preload 一行都不用改。
  hostsList: (): Promise<RemoteHostView[]> => ipcRenderer.invoke(CH.hostsList),
  hostsUpsert: (h: HostInput): Promise<RemoteHostView[]> => ipcRenderer.invoke(CH.hostsUpsert, h),
  hostsRemove: (id: string): Promise<RemoteHostView[]> => ipcRenderer.invoke(CH.hostsRemove, id),
  hostsConnect: (id: string | null): Promise<HostStatusView> => ipcRenderer.invoke(CH.hostsConnect, id),
  hostsDisconnect: (): Promise<HostStatusView> => ipcRenderer.invoke(CH.hostsDisconnect),
  hostsStatus: (): Promise<HostStatusView> => ipcRenderer.invoke(CH.hostsStatus),
  hostsExport: (includeTokens: boolean): Promise<string> => ipcRenderer.invoke(CH.hostsExport, includeTokens),
  hostsImport: (text: string): Promise<{ ok: true; added: number } | { ok: false; error: string }> => ipcRenderer.invoke(CH.hostsImport, text),
  onHostStatus: (cb: (s: HostStatusView) => void) => {
    const listener = (_: unknown, s: HostStatusView) => cb(s)
    ipcRenderer.on(CH.hostsStatusEvent, listener)
    // 花括号包住:removeListener 会返回 ipcRenderer 本身,直接返回它的话
    // React 的 useEffect 会把它当成一个「不是清理函数」的返回值而报类型错。
    return () => { ipcRenderer.removeListener(CH.hostsStatusEvent, listener) }
  },
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
  exportProjects: (): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> => ipcRenderer.invoke(CH.configExportProjects),
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
  memoryRead: (a: { level: 'system' | 'workspace' | 'session'; wsPath?: string; sessionId?: string }): Promise<string> => ipcRenderer.invoke(CH.memoryRead, a),
  memoryWrite: (a: { level: 'system' | 'workspace' | 'session'; wsPath?: string; sessionId?: string; content: string }): Promise<void> => ipcRenderer.invoke(CH.memoryWrite, a),
  memoryClear: (a: { level: 'system' | 'workspace' | 'session'; wsPath?: string; sessionId?: string }): Promise<void> => ipcRenderer.invoke(CH.memoryClear, a),
  tokenUsageAggregate: (): Promise<import('../main/ipc/tokenUsageHandlers').TokenUsageRow[]> => ipcRenderer.invoke(CH.tokenUsageAggregate),
  // 成长宠物:一次性拉取当前信号 + 订阅后续实时推送。
  growthSignalGet: (): Promise<import('../main/tokens/dailyTokenCounter').GrowthSignal | null> => ipcRenderer.invoke(CH.growthSignalGet),
  onGrowthSignal: (cb: (s: import('../main/tokens/dailyTokenCounter').GrowthSignal) => void) => {
    const listener = (_: unknown, s: import('../main/tokens/dailyTokenCounter').GrowthSignal) => cb(s)
    ipcRenderer.on(CH.growthSignal, listener)
    return () => ipcRenderer.removeListener(CH.growthSignal, listener)
  },
  // 成长宠物包安装:主进程弹目录选择器,校验并拷贝后返回一个 CustomPet(取消 → null)。
  growthPetImport: (): Promise<{ ok: true; pet: import('@shared/petCustom').CustomPet } | { ok: false; error: string } | null> => ipcRenderer.invoke(CH.growthPetImport),
  // Run2 (P3-A): additive API surface for the new headless run controller. Coexists with startRun/resolve/
  // onEngineEvent above — none of those are touched.
  run2: {
    start: (opts: { workspacePath: string; runId: string; stages: unknown[]; projects: unknown[] }) => ipcRenderer.invoke(CH.run2Start, opts),
    // Task 8: the launch gate's 运行基准 section — see run2Handlers.ts's ProjectBaseInfo/run2BaseInfo doc.
    baseInfo: (workspacePath: string): Promise<import('../main/ipc/run2Handlers').ProjectBaseInfo[]> => ipcRenderer.invoke(CH.run2BaseInfo, { workspacePath }),
    resolveGate: (a: { workspacePath: string; eventId: string; decision: unknown }) => ipcRenderer.invoke(CH.run2ResolveGate, a),
    resolveLane: (a: { workspacePath: string; eventId: string; decision: unknown }) => ipcRenderer.invoke(CH.run2ResolveLane, a),
    addFeedback: (a: { workspacePath: string; text: string }) => ipcRenderer.invoke(CH.run2AddFeedback, a),
    editFeedback: (a: { workspacePath: string; id: string; text: string }) => ipcRenderer.invoke(CH.run2EditFeedback, a),
    removeFeedback: (a: { workspacePath: string; id: string }) => ipcRenderer.invoke(CH.run2RemoveFeedback, a),
    abort: (a: { workspacePath: string }) => ipcRenderer.invoke(CH.run2Abort, a),
    pause: (a: { workspacePath: string }) => ipcRenderer.invoke(CH.run2Pause, a),
    resume: (a: { workspacePath: string }) => ipcRenderer.invoke(CH.run2Resume, a),
    jumpBack: (a: { workspacePath: string; targetKey: string }) => ipcRenderer.invoke(CH.run2JumpBack, a),
    getState: (workspacePath: string) => ipcRenderer.invoke(CH.run2GetState, { workspacePath }),
    // P4-A launcher: list a workspace's named workflows + projects, and start one by id (server-side
    // resolves ws.workflows[].stages into a RunPlan — the renderer only picks workflowId/projectNames).
    launchInfo: (workspacePath: string) => ipcRenderer.invoke(CH.run2LaunchInfo, { workspacePath }),
    startWorkflow: (opts: { workspacePath: string; workflowId: string; projectNames: string[]; task?: string; runId: string }) =>
      ipcRenderer.invoke(CH.run2StartWorkflow, opts),
    // P1-4: in-chat launch gate's 确认 button — carries the gate's own per-project provider/model
    // selection + supplement/seed (see LaunchStartConfig in src/main/run/launch.ts), unlike
    // startWorkflow above which only forwards a workflowId + projectNames.
    launchStart: (cfg: { workspacePath: string; workflowId: string; projects: { name: string; provider: string; model: string }[]; supplement: string; seed: string; sessionId?: string }) =>
      ipcRenderer.invoke(CH.run2LaunchStart, cfg),
    // P5-UI Task 2: on-demand file content read for the RunPanel file viewer (read-only).
    readFile: (a: { path: string; cwd?: string }) => ipcRenderer.invoke(CH.run2ReadFile, a),
    // P-C2/T3 (disk-resume): checked on workspace open — is there an interrupted run left over from
    // before an app restart? Returns a ResumableSummary or null (see Run2Manager.resumable's doc).
    resumable: (workspacePath: string) => ipcRenderer.invoke(CH.run2Resumable, { workspacePath }),
    // P-C2/T3: 继续 — rebuild + resume the interrupted run from disk.
    resumeFromDisk: (workspacePath: string, sessionId?: string) => ipcRenderer.invoke(CH.run2ResumeFromDisk, { workspacePath, sessionId }),
    // P-C2/T3: 丢弃 — clear the saved state so it stops being offered.
    discardResumable: (workspacePath: string) => ipcRenderer.invoke(CH.run2DiscardResumable, { workspacePath }),
    // Spec §12.7 (run-history): list past runs for a workspace (newest first), and load one run's
    // full saved state for read-only replay.
    listRuns: (workspacePath: string) => ipcRenderer.invoke(CH.run2ListRuns, { workspacePath }),
    loadRun: (workspacePath: string, runId: string) => ipcRenderer.invoke(CH.run2LoadRun, { workspacePath, runId }),
    // Run-state UX fix: delete one run-history entry (refused by the main-process handler for the
    // workspace's currently-live run).
    deleteRun: (workspacePath: string, runId: string) => ipcRenderer.invoke(CH.run2DeleteRun, { workspacePath, runId }),
    onEvent: (cb: (p: { workspacePath: string; event: unknown }) => void) => {
      const listener = (_: unknown, p: { workspacePath: string; event: unknown }) => cb(p)
      ipcRenderer.on(CH.run2Event, listener)
      return () => ipcRenderer.removeListener(CH.run2Event, listener)
    },
    onUpdate: (cb: (p: { workspacePath: string; state: unknown }) => void) => {
      const listener = (_: unknown, p: { workspacePath: string; state: unknown }) => cb(p)
      ipcRenderer.on(CH.run2Update, listener)
      return () => ipcRenderer.removeListener(CH.run2Update, listener)
    },
    onLog: (cb: (p: { workspacePath: string; log: unknown }) => void) => {
      const listener = (_e: unknown, p: { workspacePath: string; log: unknown }) => cb(p)
      ipcRenderer.on(CH.run2Log, listener)
      return () => ipcRenderer.removeListener(CH.run2Log, listener)
    },
    // Task 1 (queue): a workspace's pending-queue length changed (enqueue/dequeue).
    onQueue: (cb: (p: { workspacePath: string; length: number }) => void) => {
      const listener = (_e: unknown, p: { workspacePath: string; length: number }) => cb(p)
      ipcRenderer.on(CH.run2Queue, listener)
      return () => ipcRenderer.removeListener(CH.run2Queue, listener)
    },
  },
}
contextBridge.exposeInMainWorld('forge', api)
export type ForgeApi = typeof api
