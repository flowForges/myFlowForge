export const CH = {
  configGetSettings: 'config:get-settings',
  configSetSettings: 'config:set-settings',
  configListProjects: 'config:list-projects',
  configAddProject: 'config:add-project',
  configDeleteProject: 'config:delete-project',
  configUpdateProjectBranch: 'config:update-project-branch',
  configExportProjects: 'config:export-projects',
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
  chatCancelQueued: 'chat:cancel-queued',
  chatClearQueue: 'chat:clear-queue',
  chatStop: 'chat:stop',
  sessionList: 'session:list',
  sessionNew: 'session:new',
  sessionSwitch: 'session:switch',
  sessionClose: 'session:close',
  sessionRename: 'session:rename',
  sessionSetPermission: 'session:set-permission',
  wsSetAutoDecide: 'workspace:set-auto-decide',
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
  dialogOpenFiles: 'dialog:open-files',
  dialogPickDirectory: 'dialog:pick-directory',
  dialogPickFile: 'dialog:pick-file',
  chatSavePaste: 'chat:save-paste',
  gitChanges: 'git:changes',
  changesMulti: 'changes:multi',
  gitDiff: 'git:diff',
  gitFile: 'git:file',
  imageFile: 'file:image', // read an image file's bytes → data URL (for the inspector image preview)
  fsTree: 'fs:tree',
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
  petPackInstall: 'petpack:install',
  // Main renderer → main process: the workspace currently open in the main window ('ws' view), or null on
  // the home view. Relayed to the pet so its command input can target "the workspace you're in".
  setPetActiveWorkspace: 'pet:set-active-workspace',
  // Main process → pet window: the current active workspace path (or null).
  petActiveWorkspace: 'pet:active-workspace',
  settingsChanged: 'settings:changed',
  sessionsChanged: 'sessions:changed',
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
  appRelaunch: 'app:relaunch',
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
  // Dirty-tree pre-check: which of the workspace's projects have uncommitted changes? Used by the launch
  // gate to warn (and confirm) before starting — a dirty tree is now stashed+restored, not blocked.
  run2CheckDirty: 'run2:check-dirty',
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
export const run2CheckDirty = CH.run2CheckDirty
export const run2ReadFile = CH.run2ReadFile
export const run2Resumable = CH.run2Resumable
export const run2ResumeFromDisk = CH.run2ResumeFromDisk
export const run2DiscardResumable = CH.run2DiscardResumable
export const run2ListRuns = CH.run2ListRuns
export const run2LoadRun = CH.run2LoadRun
export const run2DeleteRun = CH.run2DeleteRun
