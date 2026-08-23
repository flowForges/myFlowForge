export const CH = {
  // ── 多主机(第二期 B)。全部是**客户端自己的**事:这台设备认识哪些机器、现在连着谁。
  //    所以它们注册在 index.ts 而不是方法表里,天然不会被路由到远程。
  hostsList: 'hosts:list',
  hostsUpsert: 'hosts:upsert',
  hostsRemove: 'hosts:remove',
  hostsConnect: 'hosts:connect',
  hostsDisconnect: 'hosts:disconnect',
  hostsStatus: 'hosts:status',
  hostsExport: 'hosts:export',
  hostsImport: 'hosts:import',
  hostsStatusEvent: 'hosts:status-event',
  configGetSettings: 'config:get-settings',
  // 设置一分为二之后的两个半边(第二期 C)。`config:get/set-settings` 由路由器**组合**这两个:
  // 跟设备的那半边永远本机答,跟机器的那半边跟着当前 host 走。
  configGetHostSettings: 'config:get-host-settings',
  configSetHostSettings: 'config:set-host-settings',
  configGetClientSettings: 'config:get-client-settings',
  configSetClientSettings: 'config:set-client-settings',
  configSetSettings: 'config:set-settings',
  configListProjects: 'config:list-projects',
  configAddProject: 'config:add-project',
  configDeleteProject: 'config:delete-project',
  configUpdateProjectBranch: 'config:update-project-branch',
  configUpdateProjectAlias: 'config:update-project-alias',
  configExportProjects: 'config:export-projects',
  // 「daemon 出内容 → 客户端落盘」(第二期 D)。导出的**内容**是那台机器的,**文件**得落在你面前
  // 这台设备上 —— 无头机器上没有「保存到哪儿」这回事。路由器把这两步组合成原来那一个调用。
  configExportProjectsData: 'config:export-projects-data',
  clientSaveFile: 'client:save-file',
  configListWorkflows: 'config:list-workflows',
  configAddWorkflow: 'config:add-workflow',
  configDeleteWorkflow: 'config:delete-workflow',
  configUpdateWorkflow: 'config:update-workflow',
  hookLibraryList: 'hook-library:list',
  hookLibrarySave: 'hook-library:save',
  hookLibraryDelete: 'hook-library:delete',
  hookLibrarySetAll: 'hook-library:set-all',
  customStagesList: 'custom-stages:list',
  customStagesUpsert: 'custom-stages:upsert',
  customStagesDelete: 'custom-stages:delete',
  customStagesChanged: 'custom-stages:changed',
  agentsDetect: 'agents:detect',
  agentsGetConfig: 'agents:get-config',
  agentsSetBin: 'agents:set-bin',
  agentsAddCustom: 'agents:add-custom',
  agentsRemoveCustom: 'agents:remove-custom',
  agentsRefreshModels: 'agents:refresh-models',
  agentsSetModels: 'agents:set-models',
  agentsSetTimezone: 'agents:set-timezone',
  agentsCliUpdates: 'agents:cli-updates',
  netCheckExitIp: 'net:check-exit-ip',
  contextScan: 'context:scan',
  contextScanGlobal: 'context:scan-global',
  skillsList: 'skills:list',
  commandsList: 'commands:list',
  workspaceCreate: 'workspace:create',
  workspaceCancelSetup: 'workspace:cancel-setup',
  workspaceDiscardPartial: 'workspace:discard-partial',
  workspaceGet: 'workspaces:get',
  // Batch-3/Task3: scan an arbitrary folder for already-cloned git repos (bounded, recursive), each
  // with its current branch — prepopulates the "create workspace from existing folder" form.
  workspaceScanRepos: 'workspace:scan-repos',
  workspaceEdit: 'workspaces:edit',
  workspaceRename: 'workspaces:rename',
  workspaceSetup: 'workspace:setup',
  workspaceSetupResolve: 'workspace:setup-resolve',
  // The legacy orchestrator (and all its engine:* run channels — resolve/cancel/discard/last-run/event)
  // has been removed entirely. run2 (run2LaunchStart below) is the only workflow-run path now.
  chatSend: 'chat:send',
  chatHistory: 'chat:history',
  chatEvent: 'chat:event',
  chatResolve: 'chat:resolve',
  chatQueueEvent: 'chat:queue-event',
  chatQueueState: 'chat:queue-state',
  // 当前还挂着、等用户回答的确认/提问门。和 chatQueueState 同一个用途:聊天视图重新挂载(切会话、离开再
  // 回来、刷新)时,它自己的 React state 是空的,而主进程那些门还阻塞着 —— 必须能把快照拉回来重建卡片。
  chatGateState: 'chat:gate-state',
  chatCancelQueued: 'chat:cancel-queued',
  chatClearQueue: 'chat:clear-queue',
  chatStop: 'chat:stop',
  sessionList: 'session:list',
  sessionNew: 'session:new',
  sessionSwitch: 'session:switch',
  sessionClose: 'session:close',
  sessionRename: 'session:rename',
  sessionSetPermission: 'session:set-permission',
  chatSwitchSummary: 'chat:switch-summary',
  chatSummarizeRequirement: 'chat:summarize-requirement',
  // P1-5: persist a confirmed launch-gate's frozen record onto the session (synthetic ChatMessage
  // carrying `launchGate`), so it survives reload/session-switch.
  chatAppendLaunchGate: 'chat:append-launch-gate',
  // P3-4: persist a resolved run2 event's frozen record onto the session (synthetic ChatMessage
  // carrying `runCard`), so it survives reload/session-switch. Mirrors chatAppendLaunchGate above.
  chatAppendRunCard: 'chat:append-run-card',
  notifyTest: 'notify:test',
  sessionSetModel: 'session:set-model',
  sessionAgentIds: 'session:agent-ids',
  // 对话式工作流(2026-07-30):enter=把某工作流配置固化成 session 上的 WorkflowSessionState(不自动跑);
  // advance=推进到下一阶段(跨到扇出阶段时启动执行尾段 run);exit=退出工作流清除状态。
  workflowEnter: 'workflow:enter',
  workflowAdvance: 'workflow:advance',
  workflowExit: 'workflow:exit',
  // Change 2(doc-as-contract):进入代码开发前读技术方案文档 forge-docs/<designKey>.md,抽出每个项目那节
  // 预填任务简报 + 报告文档是否存在(缺了就警告,别把空文档甩给编码 agent)。
  workflowPrepareBriefs: 'workflow:prepare-briefs',
  // finish=执行尾段 run 终态(ok/failed)后把 workflowSession 置 done(ribbon 不再卡在"执行中")。
  workflowFinish: 'workflow:finish',
  dialogOpenFiles: 'dialog:open-files',
  dialogPickDirectory: 'dialog:pick-directory',
  dialogPickFile: 'dialog:pick-file',
  chatSavePaste: 'chat:save-paste',
  gitChanges: 'git:changes',
  changesMulti: 'changes:multi',
  gitDiff: 'git:diff',
  gitFile: 'git:file',
  imageFile: 'file:image', // read an image file's bytes → data URL (for the inspector image preview)
  // 对话正文里的 [名字](路径) 点击:解析成「哪个 cwd 下的哪个文件」(存在性 + 越界校验都在主进程)
  resolveFileRef: 'file:resolve-ref',
  // 预览打不开的类型(pdf/xlsx/…)与 .html 的「用浏览器打开」:交给系统默认程序
  openFilePath: 'file:open-path',
  fsTree: 'fs:tree',
  // 服务端只读目录浏览(第二期 D)。「手机上怎么选目录」的落地 —— 跟机器走:
  // 你要定位的目录在那台机器上,只有它列得出来。
  fsBrowse: 'fs:browse',
  fsBrowseRoots: 'fs:browse-roots',
  gitBranch: 'git:branch',
  fileSearchContent: 'file:search-content',
  watchChanges: 'watch:changes',
  watchStop: 'watch:stop',
  changesEvent: 'changes:event',
  workspacesList: 'workspaces:list',
  workspacesHomeStats: 'workspaces:home-stats',
  workspacesOpenDir: 'workspaces:open-dir',
  workspacesSetPinned: 'workspaces:set-pinned',
  workspacesSetOrder: 'workspaces:set-order',
  petSetExpanded: 'pet:set-expanded',
  petFocusWorkspace: 'pet:focus-workspace',
  navigateWorkspace: 'navigate:workspace',
  petSetPosition: 'pet:set-position',
  petSetScale: 'pet:set-scale',
  // Resize-handle drag begins: pre-grow the pet window once to the max-scale footprint so the live
  // drag is pure CSS (zero setBounds per move — re-bounding while dragging jittered).
  petResizeBegin: 'pet:resize-begin',
  petGetBounds: 'pet:get-bounds',
  petSetIgnoreMouse: 'pet:set-ignore-mouse',
  petContextMenu: 'pet:context-menu',
  petPickPack: 'pet:pick-pack',
  petPickImage: 'pet:pick-image',
  petLookAngle: 'pet:look-angle',
  codexPetImport: 'codex-pet:import',
  codexPetList: 'codex-pet:list',
  codexPetPick: 'codex-pet:pick',
  // codex-pets.net 宠物市场(第三方,插件 gating):分页列表 / 缩略图 / 安装
  codexMarketCatalog: 'codex-market:catalog',
  codexMarketPreview: 'codex-market:preview',
  codexMarketInstall: 'codex-market:install',
  appearancePickBgImage: 'appearance:pick-bg-image',
  // Main → renderer: a tray/dock context-menu item was chosen; the payload is a keybinding-action name
  // (e.g. 'new-workspace') the renderer dispatches through its existing kbHandlers.
  menuAction: 'menu:action',
  // Downloadable-font management (see appearance/fontStore.ts): list what's on disk, download a catalog
  // font (streams progress on fontsDownloadProgress), delete a downloaded font.
  fontsListDownloaded: 'fonts:list-downloaded',
  fontsDownload: 'fonts:download',
  fontsDelete: 'fonts:delete',
  fontsDownloadProgress: 'fonts:download-progress',
  // License-gated extra content (see shared/nsfw.ts + cloudflare/nsfw-worker.js): validate an activation
  // code against the Worker, list the gated catalog, and download+install a pet pack / background.
  nsfwValidate: 'nsfw:validate',
  nsfwCatalog: 'nsfw:catalog',
  nsfwPreview: 'nsfw:preview',
  nsfwGallery: 'nsfw:gallery',
  nsfwPreviewEvent: 'nsfw:preview-event',
  nsfwInstallPet: 'nsfw:install-pet',
  nsfwInstallBg: 'nsfw:install-bg',
  nsfwBgExists: 'nsfw:bg-exists',
  // Built-in wallpapers (no activation code / Worker) — list the public jsDelivr catalog, preview a
  // thumbnail, and download+store a full image as an app background.
  wallpaperCatalog: 'wallpaper:catalog',
  wallpaperPreview: 'wallpaper:preview',
  wallpaperInstall: 'wallpaper:install',
  // Downloadable pet packs (no activation code) — list the public jsDelivr catalog, preview a pack's
  // thumbnail, and download+store a pack's animated frames as a usable custom pet.
  petPackCatalog: 'petpack:catalog',
  petPackPreview: 'petpack:preview',
  growthPackInstall: 'pet-pack:growth-install',
  petPackInstall: 'petpack:install',
  // Main renderer → main process: the workspace currently open in the main window ('ws' view), or null on
  // the home view. Relayed to the pet so its command input can target "the workspace you're in".
  setPetActiveWorkspace: 'pet:set-active-workspace',
  // Main process → pet window: the current active workspace path (or null).
  petActiveWorkspace: 'pet:active-workspace',
  settingsChanged: 'settings:changed',
  // ★Q7:设置的并发冲突走「后写的赢」(和权限门的「先回先算」是同一套规则,用户只需要理解一套)。
  //   后写的赢本身没问题,问题是**另一端不知道刚才发生了什么** —— 值变了、界面跟着变了,
  //   看起来像是自己点错了。这条事件只在「改动来自别的设备」时发,专门用来说清是谁改的。
  settingsChangedBy: 'settings:changed-by',
  sessionsChanged: 'sessions:changed',
  // Bot bridge (钉钉): renderer settings pane ⇄ main.
  botConnect: 'bot:connect',
  botDisconnect: 'bot:disconnect',
  botGetStatus: 'bot:get-status',
  botStatusEvent: 'bot:status-event',
  botRegenPairing: 'bot:regen-pairing',
  botUnbind: 'bot:unbind',
  updateGet: 'update:get',
  updateCheck: 'update:check',
  updateStart: 'update:start',
  updateAvailable: 'update:available',
  updateNone: 'update:none',
  updateCheckFailed: 'update:check-failed',
  updateProgress: 'update:progress',
  updateDone: 'update:done',
  updateError: 'update:error',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  // Frameless windows draw their own caption buttons, so the renderer has no native chrome to read
  // the maximised state from — the main process has to tell it, or the Windows maximise/restore glyph
  // never changes.
  windowIsMaximized: 'window:is-maximized',
  windowMaximizedChanged: 'window:maximized-changed',
  appRelaunch: 'app:relaunch',
  appVibrancyBaseline: 'app:vibrancy-baseline',
  appIconOptions: 'app-icon:options',
  termCreate: 'term:create',
  termWrite: 'term:write',
  termResize: 'term:resize',
  termKill: 'term:kill',
  termData: 'term:data',
  termCwd: 'term:cwd',
  termExit: 'term:exit',
  pluginsChanged: 'plugins:changed',
  pluginsList: 'plugins:list',
  pluginsInstall: 'plugins:install',
  pluginsUninstall: 'plugins:uninstall',
  pluginsSetEnabled: 'plugins:set-enabled',
  pluginsRefresh: 'plugins:refresh',
  pluginsCatalog: 'plugins:catalog',
  pluginsInstallExample: 'plugins:install-example',
  pluginsGetCreds: 'plugins:get-creds',
  pluginsSetCred: 'plugins:set-cred',
  sessionImportScan: 'session-import:scan',
  sessionImportLastScan: 'session-import:last-scan',
  sessionImportRun: 'session-import:run',
  sessionImportRead: 'session-import:read',
  sessionImportList: 'session-import:list',
  sessionImportCoverage: 'session-import:coverage',
  sessionContinueFrom: 'session:continue-from',
  workspaceArchive: 'workspace:archive',
  workspaceRestore: 'workspace:restore',
  workspaceDelete: 'workspace:delete',
  workspacesChanged: 'workspaces:changed',
  workspaceSetStageModel: 'workspaces:setStageModel',
  workspaceRemove: 'workspace:remove',
  revealPath: 'shell:reveal-path',
  openExternal: 'shell:open-external',
  openersDetect: 'openers:detect',
  openersOpen: 'openers:open',
  shortcutsGetStatus: 'shortcuts:get-status',
  shortcutsStatus: 'shortcuts:status',
  appLogGet: 'app-log:get',
  appLogClear: 'app-log:clear',
  appLogExport: 'app-log:export',
  appLogEvent: 'app-log:event',
  perfStall: 'perf:stall',
  memoryRead: 'memory:read',
  tokenUsageAggregate: 'token-usage:aggregate',
  // 成长宠物:主进程 → 宠物窗口的实时信号(今日 token / 每日目标 / 0~1 进度)。
  growthSignal: 'growth:signal',
  growthSignalGet: 'growth:signal-get',
  // 成长宠物:从本地文件夹装一个成长宠物包(选目录 → 校验 → 拷贝阶段图 → 返回 CustomPet)。
  growthPetImport: 'growth:pet-import',
  memoryWrite: 'memory:write',
  memoryClear: 'memory:clear',
  // Run2 (P3-A): additive, coexists with the existing engine* orchestrator channels above.
  run2Start: 'run2:start',
  run2ResolveGate: 'run2:resolve-gate',
  run2ResolveLane: 'run2:resolve-lane',
  run2AddFeedback: 'run2:add-feedback',
  run2EditFeedback: 'run2:edit-feedback',
  run2RemoveFeedback: 'run2:remove-feedback',
  run2Abort: 'run2:abort',
  run2Pause: 'run2:pause',
  run2Resume: 'run2:resume',
  run2JumpBack: 'run2:jump-back',
  run2GetState: 'run2:get-state',
  run2Event: 'run2:event',
  run2Update: 'run2:update',
  run2Log: 'run2:log',
  // Task 1 (queue): broadcasts a workspace's pending-queue length whenever it changes (enqueue/dequeue) —
  // see Run2Manager.queues / Run2Emit.queue.
  run2Queue: 'run2:queue',
  // P4-A launcher: resolve a workspace's named workflows/projects server-side (run2LaunchInfo), and
  // resolve the picked workflow's stages (ws.workflows[].stages, NOT the permanently-empty legacy
  // ws.stages) into a RunPlan before starting run2 (run2StartWorkflow).
  run2LaunchInfo: 'run2:launch-info',
  run2StartWorkflow: 'run2:start-workflow',
  // P1-4: the in-chat launch gate's 确认 button. Distinct from `run2Start` (the raw
  // stages+projects channel, unused by any renderer UI — see run2Handlers.ts) because that name is
  // already taken with a different (lower-level) payload shape; this one takes a `LaunchStartConfig`
  // (workflowId + gate-selected per-project provider/model + supplement/seed) and resolves it
  // server-side via launch.ts's buildLaunchPlan/buildLaunchProjects, same pattern as run2StartWorkflow.
  run2LaunchStart: 'run2:launch-start',
  // Task 8: the launch gate's 运行基准 section — each selected project's REAL currently-checked-out
  // branch (currentBranch, the exact same measurement createRunTempBranches uses to pick the run's
  // base — never ws.projects[].branch, the stale field the 2026-08-17 bug came from) + how many
  // uncommitted lines it's carrying. Replaces run2CheckDirty (deleted — its only caller, this same
  // gate's dirty-tree notice, is what this channel now serves; dirtyCount below is a strict superset).
  run2BaseInfo: 'run2:base-info',
  // P5-UI Task 2: read a changed file's content on demand (renderer file viewer) — read-only.
  run2ReadFile: 'run2:read-file',
  // P-C2/T3 (disk-resume): checked on workspace open — is there an interrupted (non-terminal) run2
  // state saved on disk for this workspace with nothing currently driving it? See
  // Run2Manager.resumable()'s doc for exactly what counts.
  run2Resumable: 'run2:resumable',
  // P-C2/T3: 继续 — rebuilds a controller from the on-disk snapshot and resumes it (Run2Manager.resumeFromDisk).
  run2ResumeFromDisk: 'run2:resume-from-disk',
  // P-C2/T3: 丢弃 — clears the saved state so resumable() stops offering it again.
  run2DiscardResumable: 'run2:discard-resumable',
  // Spec §12.7 (run-history): list every past/interrupted run for a workspace (newest first), and
  // load one run's full saved state for read-only replay.
  run2ListRuns: 'run2:list-runs',
  run2LoadRun: 'run2:load-run',
  // Run-state UX fix: delete one run-history entry's saved state (never the workspace's currently
  // live run — see run2Handlers.ts's guard).
  run2DeleteRun: 'run2:delete-run',
} as const

// Individual named exports (in addition to the CH object above) so callers can `import * as CH from
// './channels'` and refer to `CH.run2Start` etc. — mirrors how run2Handlers.ts/its test consume this module.
export const run2Start = CH.run2Start
export const run2ResolveGate = CH.run2ResolveGate
export const run2ResolveLane = CH.run2ResolveLane
export const run2AddFeedback = CH.run2AddFeedback
export const run2EditFeedback = CH.run2EditFeedback
export const run2RemoveFeedback = CH.run2RemoveFeedback
export const run2Abort = CH.run2Abort
export const run2Pause = CH.run2Pause
export const run2Resume = CH.run2Resume
export const run2JumpBack = CH.run2JumpBack
export const run2GetState = CH.run2GetState
export const run2Event = CH.run2Event
export const run2Update = CH.run2Update
export const run2Log = CH.run2Log
export const run2Queue = CH.run2Queue
export const run2LaunchInfo = CH.run2LaunchInfo
export const run2StartWorkflow = CH.run2StartWorkflow
export const run2LaunchStart = CH.run2LaunchStart
export const run2BaseInfo = CH.run2BaseInfo
export const run2ReadFile = CH.run2ReadFile
export const run2Resumable = CH.run2Resumable
export const run2ResumeFromDisk = CH.run2ResumeFromDisk
export const run2DiscardResumable = CH.run2DiscardResumable
export const run2ListRuns = CH.run2ListRuns
export const run2LoadRun = CH.run2LoadRun
export const run2DeleteRun = CH.run2DeleteRun
