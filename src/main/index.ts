import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, session, Tray } from 'electron'
import { registerGlobalShortcuts, unregisterGlobalShortcuts } from './shortcuts/globalShortcuts'
import { createMainWindow, builtWindowBlurAmount } from './windows/mainWindow'
import { createPetWindow, resolvePetLayout, MARGIN, clampPetSprite, petClampRegion } from './windows/petWindow'
import { parkWindowInDock, resolveCloseAction, resolveDockActivationAction } from './windows/closeBehavior'
import { relocatePetToRegion, PET_EXPANDED, PET_BUBBLE, petCollapsedSize, petPopupSize, clampPetScale, petMaxSize, petResizeFootprint } from '@shared/petGeometry'
import type { PetVDir, PetSizeMode } from '@shared/petGeometry'
import { WindowRegistry } from './windows/windowRegistry'
import { createBroadcastHub } from './ipc/broadcastHub'
import { createElectronHost } from './host/electronHost'
import { hostname } from 'node:os'
import { createHostRouter } from './remote/router'
import { createAppGateway } from './host/appGateway'
import { createRelayController } from './host/relayController'
import { openSshTunnel } from './remote/sshTunnel'
import { readHosts, upsertHost, removeHost, markConnected, exportHosts, importHosts, type RemoteHost } from './remote/hostStore'
import { registerIpc } from './ipc/handlers'
import { killAllAgentTrees } from './agents/procGroup'
import { botBridge } from './bot/botBridge'
import { showOsNotification, osNotificationsSupported } from './notify/osNotify'
import { shouldNotify, buildNotification } from './notify/notifier'
import { createGateNotifier } from './notify/notifyBridge'
import { pushService } from './push/pushService'
import { gazeAngle } from '@shared/petGaze'
import { CH } from './ipc/channels'
import { buildProviderRegistry } from './agents/registry'
import { readSettings, migrateSettingsIfNeeded, writeSettings, readWorkspaceRegistry } from './config/store'
import { fixExecPath } from './agents/pathFix'
import { createDailyTokenCounter, scanTokenBaseline, localDayKey } from './tokens/dailyTokenCounter'
import { setDailyTokenCounter } from './tokens/growthSignalRef'
import type { Settings } from './config/schema'
import { createTerminalService } from './terminal/terminalService'
import { PluginScheduler } from './plugins/pluginScheduler'
import { readPlugins } from './plugins/pluginStore'
import { runPlugin } from './plugins/pluginHost'
import { setPluginScheduler } from './plugins/pluginSchedulerRef'
import { makeRun } from './usage/usageService'
import { initAppLogFile, setAppLogEventSink, logInfo, logError } from './log/appLog'
import { SYS_DIR } from './config/paths'
import { registerPetScheme, handlePetProtocol } from './pet/petProtocol'
import { migratePetImagesInPet } from './pet/petImageStore'
import { registerBackgroundScheme, handleBackgroundProtocol } from './appearance/backgroundProtocol'
import { bgRelFromUrl, gcBackgrounds } from './appearance/backgroundStore'
import { previewKeepRels } from './appearance/previewCache'
import { registerFontScheme, handleFontProtocol } from './appearance/fontProtocol'
import { join } from 'node:path'
import { resolveDockIconPath, resolveMenuBarIconPath } from './appIcon'
import { hasAllBuiltinPets, mergeBuiltinPets, isLegacyBundledPet } from '@shared/builtinPets'
import { perfSpan } from './perf/perfSpans'
import { EventLoopMonitor } from './perf/eventLoopMonitor'
import { StallReporter } from './perf/stallReporter'

// Start the centralized debug log as early as possible so even startup failures are persisted to
// ~/.myFlowForge/logs/app.log and exportable from Settings · 调试日志.
try { initAppLogFile(join(SYS_DIR, 'logs')); logInfo('app', `启动 myFlowForge${app.isPackaged ? ' (packaged)' : ' (dev)'}`) } catch { /* logging must never block boot */ }
// Last-resort crash capture: a thrown error in the main process would otherwise vanish silently.
process.on('uncaughtException', (e) => { logError('app', 'uncaughtException', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)) })
process.on('unhandledRejection', (r) => { logError('app', 'unhandledRejection', r instanceof Error ? `${r.message}\n${r.stack ?? ''}` : String(r)) })

// A packaged GUI app gets launchd's minimal PATH, not the user's shell PATH, so the agent
// CLIs (claude/codex) and `which` aren't found. Fix it before any agent is spawned.
const fixedPath = fixExecPath({ packaged: app.isPackaged, platform: process.platform, env: process.env })
if (fixedPath) process.env.PATH = fixedPath

// Single-instance lock: a relaunch (e.g. right after reinstalling) must not spin up a second
// process. The first instance keeps the lock; any later instance exits immediately and asks the
// primary to surface its window instead.
let mainWinRef: BrowserWindow | null = null
let menuBarTray: Tray | null = null
// True once the app is REALLY quitting (Cmd+Q / menu quit / dialog's 退出应用) — the main window's
// close interceptor must then let the close through no matter what settings.closeAction says.
let quitting = false
const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) app.quit()
// Privileged custom schemes for serving on-disk pet images / background images / downloaded fonts —
// MUST be declared before app 'ready'.
registerPetScheme()
registerBackgroundScheme()
registerFontScheme()
app.on('second-instance', () => {
  if (mainWinRef && !mainWinRef.isDestroyed()) { mainWinRef.show(); mainWinRef.focus() }
})

// Windows ties notifications and taskbar/tray identity to the AppUserModelID, and it must match the
// one the installer stamps on the Start-menu shortcut (electron-builder derives that from appId).
// Without this, toasts are silently dropped — the app looks like it simply never notifies.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.zghua.myflowforge')
  // The window is frameless, so Electron's default menu is never DRAWN on Windows — but its
  // accelerators stay registered. Ctrl+R would reload the renderer out from under a running
  // workflow, and Ctrl+W would close the window, neither of which this app ever asked for. Drop the
  // menu entirely. (macOS must keep it: the menu bar is real there, and Cmd+Q / Cmd+C / Cmd+V are
  // menu roles — removing it would break editing shortcuts.)
  Menu.setApplicationMenu(null)
}

// 启动期的失败必须留痕。whenReady 的回调里任何一处抛异常,后面的建窗代码就全不执行 —— 而 promise
// 的 rejection 没人接,于是表现为「进程活着、一个窗口都没有、app.log 只停在最初两行」。真机上就是这样。
// 这三个 handler 让那种失败至少写下一行。
process.on('unhandledRejection', (reason) => {
  try { logError('app', `未处理的 promise rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`) } catch { /* 日志本身绝不能再抛 */ }
})
process.on('uncaughtException', (err) => {
  try { logError('app', `未捕获异常: ${err.stack ?? err.message}`) } catch { /* 同上 */ }
})

app.whenReady().then(() => {
  if (!gotInstanceLock) return // a second instance is already quitting — don't build any windows
  const iconPathEnv = () => ({ resourcesPath: process.resourcesPath, appPath: app.getAppPath(), isPackaged: app.isPackaged })
  const applyDockIcon = (iconId: Settings['appIcon']['dockIcon']) => {
    // Windows has no Dock. The picked icon is still meaningful there — it's what the tray shows —
    // so the setting isn't dead, it just lands somewhere else (see applyStatusIcon).
    if (process.platform === 'win32') { refreshTrayImage(); return }
    if (process.platform !== 'darwin') return
    const image = nativeImage.createFromPath(resolveDockIconPath(iconPathEnv(), iconId))
    if (!image.isEmpty()) app.dock?.setIcon(image)
  }
  // Force a REGULAR foreground app on macOS: own a Dock icon and the menu bar. The pet window is a
  // floating, always-on-top, skip-taskbar panel; if it is the first window the runtime sees, the
  // app otherwise ends up registered as an accessory/UIElement process (no Dock icon, and the
  // previously-focused app keeps the menu bar). setActivationPolicy('regular') alone is NOT enough
  // once the runtime has registered as UIElement — app.dock.show() explicitly restores the Dock
  // icon. Do both, up front.
  //
  // ★★2026-08-30:**`dock.show()` 会把自定义 Dock 图标扔掉。**
  //  它在 macOS 上落到 `TransformProcessType(…, kProcessTransformToForegroundApplication)`,
  //  而那一步是**按 app bundle 重建 dock tile** —— 之前 `app.dock.setIcon()` 设的那张就没了。
  //  这三句因此必须是**捆在一起**的一件事,不能分开写:
  //    setActivationPolicy → dock.show → **重新贴一次图标**
  //  漏掉最后一句的地方就是「用户报的『切了图标 Dock 不跟着换』」:图标其实换过了,
  //  然后他点了一下 Dock(或者切走再切回来),`app.on('activate')` 里那两句把它刷回默认。
  //  ★重贴是幂等的、也很便宜(一次 nativeImage 读盘),别为了省这一次而把三句拆开。
  const reassertDock = () => {
    if (process.platform !== 'darwin') return
    app.setActivationPolicy('regular')
    app.dock?.show().catch(() => { /* dock unavailable — nothing to do */ })
    try { applyDockIcon(readSettings().appIcon.dockIcon) } catch { /* settings/icon unavailable — bundle icon remains */ }
  }
  reassertDock()

  // Serve on-disk pet images via forge-pet://, and one-time migrate any legacy inline data-URL pet
  // images out of settings.json onto disk (older builds stored multi-MB base64 inline, bloating it).
  handlePetProtocol()
  try {
    const s = readSettings()
    const { pet, migrated } = migratePetImagesInPet(s.pet)
    const hadBuiltinPets = hasAllBuiltinPets(pet.customPets)
    // Built-in pets are app-owned, not user data: always refresh their definitions from builtinPets() so
    // an image-path change (e.g. .gif → png/…png) reaches an existing settings.json instead of being
    // pinned to whatever was seeded on first run. User pets are preserved by mergeBuiltinPets.
    const mergedCustomPets = mergeBuiltinPets(pet.customPets)
    const builtinsRefreshed = hadBuiltinPets &&
      JSON.stringify(pet.customPets.filter(p => p.id.startsWith('builtin-'))) !==
      JSON.stringify(mergedCustomPets.filter(p => p.id.startsWith('builtin-')))
    // 内置图片宠物已全部下架(连最后的 white-catgirl 也不随包发了,5 张 animated webp 共 4.3MB)。
    // 老配置如果指着某只内置宠物,它的图已经不在包里 —— 不迁移的话用户看到的是一只空白/破图宠物。
    // 一律回落到内置 SVG「幽灵」(矢量、零字节、断网也在),想要原来那只可以去宠物库重新下载。
    const activeMissing = !!pet.activeCustomPetId && !mergedCustomPets.some(p => p.id === pet.activeCustomPetId)
    const droppedBuiltin = isLegacyBundledPet(pet.activeCustomPetId) || activeMissing
    const activeCustomPetId = droppedBuiltin ? undefined : pet.activeCustomPetId
    const nextPet = {
      ...pet,
      // 只有「原本就靠内置宠物显示」的配置才改 skin;用户自己选过幽灵/机器人或自己的包的,一律不动。
      skin: droppedBuiltin && pet.skin === 'custom' ? 'ghost' as const : pet.skin,
      customPets: mergedCustomPets,
      activeCustomPetId,
    }
    if (migrated > 0 || builtinsRefreshed || droppedBuiltin) {
      writeSettings({ ...s, pet: nextPet })
      if (migrated > 0) logInfo('pet', `已将 ${migrated} 张内联宠物图片迁移到磁盘,精简 settings.json`)
      if (!hadBuiltinPets) logInfo('pet', '已内置桌宠包并默认启用')
      if (builtinsRefreshed) logInfo('pet', '已更新内置桌宠形象')
      if (activeMissing) logInfo('pet', '原桌宠已转为可下载,已暂时回退到内置白猫娘(可在设置→宠物库重新下载)')
    }
  } catch (e) { logError('pet', `宠物图片迁移失败: ${String(e)}`) }

  // Serve on-disk background images via forge-bg://, and reclaim any background files no longer
  // referenced by settings (e.g. images that were cleared or replaced in a previous session).
  handleBackgroundProtocol()
  try {
    const a = readSettings().appearance
    // Keep the applied backgrounds AND every cached preview thumbnail (preview index) — otherwise startup
    // GC wipes the thumbnails and the next Settings-open re-downloads them all (NSFW → Cloudflare Worker).
    const keptPreviews = previewKeepRels()
    const keep = new Set([bgRelFromUrl(a.bgImage), bgRelFromUrl(a.homeBgImage), ...keptPreviews].filter((r): r is string => !!r))
    const removed = gcBackgrounds(keep)
    // 诊断(图11 NSFW 跨重启重下):记录本次启动保留了多少缓存预览、清了多少文件。若 keptPreviews=0 却之前预览过,
    // 说明 preview-index.json 没持久;若 keptPreviews>0 但仍全量重下,说明 lookup 时文件已不在(GC 之外的原因)。
    logInfo('appearance', `启动背景 GC:保留预览索引 ${keptPreviews.length} 条,清理无引用背景 ${removed} 张`)
  } catch (e) { logError('appearance', `背景图清理失败: ${String(e)}`) }

  // Serve downloaded font files via forge-font://. Also grant the Local Font Access API permission so
  // the renderer's font picker can enumerate installed system fonts via queryLocalFonts(). No handler
  // existed before (Electron's default already approves), so preserve that permissive default and just
  // ensure 'local-fonts' is granted.
  handleFontProtocol()
  try {
    const ses = session.defaultSession
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(true))
    ses.setPermissionCheckHandler(() => true)
  } catch (e) { logError('appearance', `本机字体权限授予失败: ${String(e)}`) }

  const registry = new WindowRegistry()
  // 所有事件外推的唯一出口。本机窗口是它的第一路 sink;第二期起,每个连上来的远程客户端
  // 各自 addSink 一路,互不知道对方存在。
  //
  // ★ 注意下面所有 `hub.broadcast(...)` 原本写的是 `hub.broadcast(...)` —— 那样写等于
  // 绕过总线直连窗口,settingsChanged / shortcutsStatus / menuAction / appLogEvent / growthSignal
  // 这五类事件就永远到不了远程客户端,而且是静默到不了。
  const hub = createBroadcastHub()
  // 先挂一路直通,让**路由器就位之前**发生的广播(早期日志、快捷键状态)照样能到界面;
  // 路由器建好后会把这一路换掉 —— 见下面的 detachDirectSink。
  // ★不能两路都挂着:那样每个事件会送到界面两遍,流式输出直接重影。
  const detachDirectSink = hub.addSink(registry.broadcast)

  // Live-stream debug log entries to any open renderer (the Settings · 调试日志 pane).
  setAppLogEventSink((e) => hub.broadcast(CH.appLogEvent, e))
  // 设置一分为二的落盘迁移(第二期 C)。readSettings() 本来就能在 client.json 缺席时
  // 透明地从老文件里拆,这一步只是把结果**落成两份**,顺便把老 settings.json 里的客户端字段清掉。
  // 幂等:client.json 已存在就什么都不做。
  try { if (migrateSettingsIfNeeded()) logInfo('config', '设置已拆分为 settings.json(跟机器)+ client.json(跟设备)') }
  catch (e) { logError('config', `设置拆分失败(不影响使用,仍按合并视图读): ${String(e)}`) }
  logInfo('app', '协议与会话准备完毕,开始建主窗口')
  const mainWin = createMainWindow()
  logInfo('app', '主窗口已创建,等待 ready-to-show')
  mainWinRef = mainWin
  registry.add(mainWin.webContents)

  const showMainWindow = () => {
    if (!mainWinRef || mainWinRef.isDestroyed()) return
    if (mainWinRef.isMinimized()) mainWinRef.restore()
    mainWinRef.show()
    mainWinRef.focus()
    app.focus({ steal: true })
  }
  // The tray image, per platform:
  //   macOS  — the menu bar wants a MONOCHROME template image; the OS recolours it for light/dark and
  //            for the highlighted state. A colourful icon there looks broken.
  //   Windows — the notification area wants a normal colour icon, and 16px is the slot size. It uses
  //            the icon the user picked in 设置→应用图标 (the Dock picker has nothing else to drive
  //            on Windows), so that setting stays meaningful instead of doing nothing.
  const buildTrayImage = (): Electron.NativeImage | null => {
    const win = process.platform === 'win32'
    const path = win
      ? resolveDockIconPath(iconPathEnv(), (() => { try { return readSettings().appIcon.dockIcon } catch { return 'ember-violet' } })())
      : resolveMenuBarIconPath(iconPathEnv())
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) return null
    const sized = image.resize(win ? { width: 16, height: 16 } : { width: 18, height: 18 })
    if (!win) sized.setTemplateImage(true)
    return sized
  }
  const refreshTrayImage = () => {
    if (!menuBarTray) return
    const image = buildTrayImage()
    if (image) menuBarTray.setImage(image)
  }
  // The status icon: macOS menu bar / Windows notification area. Same toggle, same menu, different
  // click conventions — Windows expects right-click (and the keyboard menu key) to open a context
  // menu owned by the tray, which is what setContextMenu gives; on macOS that would also hijack
  // LEFT-click into opening the menu, so there the menu is popped up by hand.
  const applyStatusIcon = (show: boolean) => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return
    if (!show) {
      menuBarTray?.destroy()
      menuBarTray = null
      return
    }
    if (menuBarTray) { refreshTrayImage(); return }
    const image = buildTrayImage()
    if (!image) return
    menuBarTray = new Tray(image)
    menuBarTray.setToolTip('myFlowForge')
    // Left-click opens the app; right-click drops the context menu (新建工作区 / 开关宠物 / 退出).
    menuBarTray.on('click', showMainWindow)
    if (process.platform === 'win32') menuBarTray.setContextMenu(buildAppMenu())
    else menuBarTray.on('right-click', () => menuBarTray?.popUpContextMenu(buildAppMenu()))
  }
  const applyAppIconSettings = (settings: Settings) => {
    applyStatusIcon(settings.appIcon.showMenuBar)
    applyDockIcon(settings.appIcon.dockIcon)
  }
  applyAppIconSettings(readSettings())
  // Once the window is up, make sure the app is the foreground one (owns the menu bar) AND that the
  // Dock icon is showing — re-assert both here because the pet window can flip the runtime back to
  // UIElement after the initial call.
  mainWin.once('ready-to-show', () => {
    app.focus({ steal: true })
    // ★走 reassertDock 而不是裸 `dock.show()` —— 裸的那句会把上面
    //  `applyAppIconSettings(readSettings())` 刚贴好的图标又刷回 bundle 默认。
    reassertDock()
  })
  // Close behavior per settings.closeAction: hide (缩小到 Dock — the pet window keeps the process
  // alive, the existing activate handler restores the window), quit, or ask via a dialog. When the
  // close IS allowed through, 'closed' quits the WHOLE app (pet window included) — without this the
  // frameless main window closes but the pet's separate BrowserWindow keeps the process alive
  // invisibly, so the app stays "running" and a reinstall/relaunch reports it's already open.
  const wireMainClose = (win: BrowserWindow) => {
    win.on('close', (e) => {
      const action = resolveCloseAction(readSettings().closeAction, quitting)
      if (action === 'pass') return
      e.preventDefault() // hide + ask both keep the window alive ('closed' never fires)
      if (action === 'hide') { parkWindowInDock(win, process.platform, !!menuBarTray); return }
      void dialog.showMessageBox(win, {
        type: 'question',
        message: '关闭 myFlowForge？',
        detail: '缩小到 Dock 后应用继续在后台运行，可随时从 Dock 图标回来。',
        buttons: ['缩小到 Dock', '退出应用', '取消'],
        defaultId: 0,
        cancelId: 2,
        checkboxLabel: '记住我的选择，不再询问',
      }).then(({ response, checkboxChecked }) => {
        if (response === 2) return // 取消 — do nothing
        if (checkboxChecked) {
          writeSettings({ ...readSettings(), closeAction: response === 0 ? 'hide' : 'quit' })
          // Keep every window's settings snapshot fresh so a later config:set-settings (whole-object
          // write) doesn't clobber the remembered choice with a stale value (same guard as petSetScale).
          hub.broadcast(CH.settingsChanged, readSettings())
        }
        if (response === 0) { parkWindowInDock(win, process.platform, !!menuBarTray); return }
        quitting = true
        app.quit()
      })
    })
    win.on('closed', () => app.quit())
  }
  wireMainClose(mainWin)

  // Whole-window transparency via setOpacity — reliable + live, ALWAYS applied so the 窗口透明度 slider
  // is honoured independently of 磨砂度. The two compose: opacity = whole-window see-through, vibrancy =
  // frosted blur. windowOpacity=1 is a no-op, so a pure-frosted window (no transparency) is unaffected.
  // (Previously frosted mode skipped setOpacity entirely, so any 磨砂度>0 silently killed 窗口透明度.)
  const applyWindowOpacity = (v: number | undefined) => {
    if (mainWin.isDestroyed()) return
    try { mainWin.setOpacity(Math.min(1, Math.max(0.3, v ?? 1))) } catch { /* unsupported platform */ }
  }
  applyWindowOpacity(readSettings().appearance.windowOpacity)

  // Font-size setting: the UI is px-based, so a CSS root font-size has no effect. Scale the whole
  // renderer via the zoom factor instead, which actually resizes the chrome + text.
  // 应用字号(px)→ 整窗缩放系数,基准 14px = 1.0,夹到合理范围。旧枚举字符串仍容错映射。
  const fontZoom = (px: number) => {
    const n = typeof px === 'number' ? px : ({ small: 13, medium: 14, large: 15.5 } as Record<string, number>)[px as unknown as string] ?? 14
    return Math.max(0.6, Math.min(1.6, n / 14))
  }
  const applyFontZoom = (px: number) => {
    if (!mainWin.isDestroyed()) mainWin.webContents.setZoomFactor(fontZoom(px))
  }
  mainWin.webContents.once('did-finish-load', () => applyFontZoom(readSettings().appearance.fontSize))

  let petWin: BrowserWindow | null = null
  let petMode: PetSizeMode = 'collapsed'
  // Multi-monitor aware: resolve the pet CLAMP REGION (physical screen edges, menu-bar trimmed off the
  // top so the pet can float over the Dock but not under the menu bar) of whichever display a point/window
  // sits on, so the pet can live on a secondary monitor instead of being clamped to the primary display.
  const waAtPoint = (x: number, y: number) => {
    const d = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) })
    return petClampRegion(d.bounds, d.workArea)
  }
  const primaryRegion = () => { const d = screen.getPrimaryDisplay(); return petClampRegion(d.bounds, d.workArea) }
  // The user-resizable sprite scale (settings.pet.scale), always re-clamped defensively.
  const petScale = () => clampPetScale(readSettings().pet.scale)
  // Region of the display a free (absolute, collapsed top-left) point lives on; primary as fallback.
  const waForFree = (free: { x: number; y: number } | undefined, sc: number) => {
    const collapsed = petCollapsedSize(sc)
    return free ? waAtPoint(free.x + collapsed.width / 2, free.y + collapsed.height / 2) : primaryRegion()
  }
  // Region of the display the pet window currently occupies (by its center point).
  const petWorkArea = () => {
    if (!petWin || petWin.isDestroyed()) return primaryRegion()
    const b = petWin.getBounds()
    return waAtPoint(b.x + b.width / 2, b.y + b.height / 2)
  }

  // The workspace open in the main window ('ws' view), or null on home — relayed from the main renderer so
  // the pet's command input can target "the workspace you're in" (idle included). Re-sent on pet load.
  let activeWsPath: string | null = null
  const createPet = () => {
    const pet = readSettings().pet
    petWin = createPetWindow({ corner: pet.corner, posBottom: pet.pos.bottom, free: pet.free, scale: pet.scale })
    registry.add(petWin.webContents)
    petWin.webContents.on('did-finish-load', () => {
      if (petWin && !petWin.isDestroyed()) petWin.webContents.send(CH.petActiveWorkspace, activeWsPath)
    })
    petWin.on('closed', () => { petWin = null })
  }
  // The pet window layout for a mode, from persisted settings (shared by dockPet + petResizeBegin).
  const petLayoutFor = (mode: PetSizeMode) => {
    const pet = readSettings().pet
    const sc = clampPetScale(pet.scale)
    const expanded = mode !== 'collapsed'
    // Popup-mode windows grow by the sprite delta (petPopupSize) so an enlarged sprite isn't cropped.
    const size = petPopupSize(mode === 'bubble' ? PET_BUBBLE : PET_EXPANDED, sc)
    return resolvePetLayout(waForFree(pet.free, sc), { corner: pet.corner, posBottom: pet.pos.bottom, free: pet.free }, expanded, MARGIN, size, sc)
  }
  const dockPet = (mode: PetSizeMode): PetVDir => {
    if (!petWin || petWin.isDestroyed()) return 'up'
    const l = petLayoutFor(mode)
    petWin.setBounds({ x: l.x, y: l.y, width: l.width, height: l.height })
    return l.vdir
  }

  // ── Pet follows the focused screen (multi-monitor) ─────────────────────────
  // When a Forge window gains focus (the user clicked it on that monitor), hop the pet to the same
  // relative position on THAT screen and leave it there. This replaces the old continuous cursor-chasing
  // (which jittered as the mouse moved). Cross-app focus on non-Forge windows isn't observable to
  // Electron, so we key off our own windows' focus. Persist `free` (writeSettings doesn't re-enter
  // onSettings) so expand/collapse and the next launch keep the new spot. Gated by pet.followCursor.
  const relocatePetToDisplay = (target: Electron.Display) => {
    if (!petWin || petWin.isDestroyed() || petMode !== 'collapsed') return
    const b = petWin.getBounds()
    const petDisp = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    if (target.id === petDisp.id) return
    const from = petClampRegion(petDisp.bounds, petDisp.workArea)
    const to = petClampRegion(target.bounds, target.workArea)
    const s = readSettings()
    const free = relocatePetToRegion(s.pet.free ?? { x: b.x, y: b.y }, from, to, clampPetScale(s.pet.scale))
    writeSettings({ ...s, pet: { ...s.pet, free } })
    dockPet(petMode)
  }
  const displayOfWindow = (win: BrowserWindow) => {
    const b = win.getBounds()
    return screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  }
  // Move the pet to the focused window's screen. Ignores focus on the pet window itself (clicking the pet
  // must not relocate it). When no eligible Forge window is focused, fall back to the cursor's screen.
  const relocatePetToFocus = (win: BrowserWindow | null) => {
    const p = readSettings().pet
    if (!p.enabled || !p.followCursor) return
    if (win && win === petWin) return
    const target = win && !win.isDestroyed()
      ? displayOfWindow(win)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    relocatePetToDisplay(target)
  }
  // Whether the MAIN window is currently focused (app in foreground). Tracked via focus/blur so the Dock-
  // activate handler can read the PRE-click state: macOS fires `activate` BEFORE the window's focus event,
  // so at activate time this flag still reflects「点击前是否在焦点」(isFocused() there is uselessly always
  // true because macOS already focused the window by then).
  let appFocused = false
  app.on('browser-window-focus', (_e, win) => {
    if (win === mainWinRef) appFocused = true
    relocatePetToFocus(win)
  })
  app.on('browser-window-blur', (_e, win) => { if (win === mainWinRef) appFocused = false })

  // Look-at-cursor: push the heading from the pet to the cursor so the idle pet turns its head. Pure gaze
  // — never moves the window (distinct from the removed follow poll). ~140ms is smooth enough and cheap;
  // sends null inside the deadzone so the renderer falls back to idle. The renderer only applies it while
  // the action is 'idle', so this is harmless during runs.
  const petGazePoll = setInterval(() => {
    const pet = readSettings().pet
    // Gate on pet.followCursor too: with it off the pet ignores the cursor entirely, so skip the native
    // cursor read + the ~7Hz IPC that would otherwise re-render the pet on every mouse move (idle drain).
    if (!petWin || petWin.isDestroyed() || petMode !== 'collapsed' || !pet.enabled || !pet.followCursor) return
    const b = petWin.getBounds()
    const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    petWin.webContents.send(CH.petLookAngle, gazeAngle(center, screen.getCursorScreenPoint()))
  }, 140)
  petGazePoll.unref?.()   // diagnostic-grade poll — never keep the process alive on quit
  app.on('before-quit', () => clearInterval(petGazePoll))

  // Follow is CLICK/FOCUS-driven ONLY (via `browser-window-focus` above): the pet hops to a screen when
  // the user actually clicks a Forge window there. The earlier continuous cursor-SCREEN poll was removed
  // on user request — merely moving the mouse onto another monitor (without clicking) should NOT drag the
  // pet along; that read as unwanted「鼠标跟随」. Trade-off (accepted): clicking a NON-Forge app on another
  // screen can't be observed by Electron, so the pet won't chase that; the next click on any Forge window
  // re-homes it. (History: blur+one-shot sample → 该跟没跟/跟错屏; cursor poll → felt like mouse-follow.)

  if (readSettings().pet.enabled) createPet()
  // On startup, join whatever window is already focused (if the toggle is on).
  relocatePetToFocus(BrowserWindow.getFocusedWindow())

  // ── Global (OS-level) keyboard shortcuts ────────────────────────────────────
  // Only the two scope==='global' actions register here (via Electron globalShortcut); every other
  // action is dispatched in the renderer while the app is focused. Re-registered whenever keybindings
  // change (onSettings). Accelerators the OS refuses are broadcast so the settings pane can flag them.
  let globalShortcutFailed: string[] = []
  const toggleMainWindow = () => {
    if (!mainWinRef || mainWinRef.isDestroyed()) return
    if (mainWinRef.isVisible() && mainWinRef.isFocused() && !mainWinRef.isMinimized()) { mainWinRef.hide(); return }
    showMainWindow()
  }
  const togglePet = () => {
    if (!petWin || petWin.isDestroyed()) return
    if (petWin.isVisible()) petWin.hide(); else petWin.showInactive()
  }
  const applyGlobalShortcuts = () => {
    const { failed } = registerGlobalShortcuts(readSettings().keybindings.overrides, {
      'toggle-main-window': toggleMainWindow,
      'toggle-pet': togglePet,
    })
    globalShortcutFailed = failed
    hub.broadcast(CH.shortcutsStatus, { failed })
  }
  applyGlobalShortcuts()
  ipcMain.handle(CH.shortcutsGetStatus, () => ({ failed: globalShortcutFailed }))

  ipcMain.handle(CH.petSetExpanded, (_e, mode: PetSizeMode) => { petMode = mode; return dockPet(mode) })
  ipcMain.handle(CH.petGetBounds, () => {
    if (!petWin || petWin.isDestroyed()) return null
    return { bounds: petWin.getBounds(), workArea: petWorkArea() }
  })
  ipcMain.handle(CH.petSetPosition, (_e, p: { x: number; y: number }) => {
    if (!petWin || petWin.isDestroyed()) return
    const b = petWin.getBounds()
    // Clamp to the display the pet is being dragged ONTO (nearest to the proposed window center), so it
    // can cross between monitors and snap to each monitor's edges — not just the primary display.
    const wa = waAtPoint(p.x + b.width / 2, p.y + b.height / 2)
    // Clamp the SPRITE (not the transparent window) to the physical-edge region so it can be dragged flush
    // to every screen edge — over the Dock, below the menu bar; the padding overflows harmlessly (it's
    // transparent + click-through).
    const { x, y } = clampPetSprite(p.x, p.y, { width: b.width, height: b.height }, wa, petScale())
    petWin.setBounds({ x, y, width: b.width, height: b.height })
  })
  // Resize-handle drag begins: pre-grow the window ONCE to the max-scale (PET_SCALE_MAX) footprint for
  // the current mode. During the drag the renderer temporarily anchors the pet from the window's
  // top-left, so the visible bottom-right handle grows toward the pointer. The live drag is pure CSS
  // (--pet-size) with ZERO setBounds per move; release sends one petSetScale and dockPet collapses the
  // transparent footprint back around the final size.
  ipcMain.handle(CH.petResizeBegin, () => {
    if (!petWin || petWin.isDestroyed()) return
    petWin.setBounds(petResizeFootprint(petLayoutFor(petMode), readSettings().pet.corner, petMaxSize(petMode)))
  })
  // Resize-handle drag → persist the clamped scale and re-bound the window for the current mode. The
  // free top-left stays stable so a bottom-right drag feels like normal direct manipulation instead of
  // the pet growing back toward the upper-left.
  ipcMain.handle(CH.petSetScale, (_e, raw: number): PetVDir => {
    const s = readSettings()
    const prev = clampPetScale(s.pet.scale)
    const next = clampPetScale(raw)
    if (next === prev) return dockPet(petMode)
    writeSettings({ ...s, pet: { ...s.pet, scale: next } })
    // Keep every window's settings snapshot fresh so a later config:set-settings (whole-object write)
    // doesn't clobber the new scale/free with a stale value (same guard as workspacesSetOrder).
    hub.broadcast(CH.settingsChanged, readSettings())
    return dockPet(petMode)
  })
  ipcMain.handle(CH.petSetIgnoreMouse, (_e, ignore: boolean) => {
    if (!petWin || petWin.isDestroyed()) return
    petWin.setIgnoreMouseEvents(ignore, { forward: true })
  })
  // Right-click the pet → native context menu. Kept minimal (关闭宠物) but a natural home for future
  // per-pet actions. togglePetEnabled flips pet.enabled → destroys the window + persists.
  ipcMain.handle(CH.petContextMenu, () => {
    if (!petWin || petWin.isDestroyed()) return
    Menu.buildFromTemplate([
      { label: '关闭宠物', click: () => togglePetEnabled() },
    ]).popup({ window: petWin })
  })
  ipcMain.handle(CH.setPetActiveWorkspace, (_e, path: string | null) => {
    activeWsPath = path || null
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send(CH.petActiveWorkspace, activeWsPath)
  })
  // sessionId 可选:宠物是因为某个会话在等确认才弹的气泡,只导航到工作区会停在当前会话上,用户还得自己找。
  ipcMain.handle(CH.petFocusWorkspace, (_e, path: string, sessionId?: string) => {
    if (mainWin.isDestroyed()) return
    mainWin.show(); mainWin.focus()
    mainWin.webContents.send(CH.navigateWorkspace, { path, sessionId })
  })

  // Custom traffic-lights drive these (the window is frameless, so there are no
  // native controls). Act on the sender's own window.
  ipcMain.handle(CH.windowMinimize, (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle(CH.windowToggleMaximize, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    w.isMaximized() ? w.unmaximize() : w.maximize()
  })
  ipcMain.handle(CH.windowClose, (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  // Initial state for the caption buttons: the window can already be maximised when the renderer
  // mounts (restored session, launched maximised), and no maximize event fires for that.
  ipcMain.handle(CH.windowIsMaximized, (e) => !!BrowserWindow.fromWebContents(e.sender)?.isMaximized())
  // transparent/vibrancy are construction-time only, so toggling 毛玻璃 needs a full restart to
  // rebuild the window. Let the settings UI trigger it directly. Force-quit past the close-action
  // guard (set quitting) so the app actually exits and relaunches instead of parking in the Dock.
  ipcMain.handle(CH.appRelaunch, () => { quitting = true; app.relaunch(); app.exit(0) })
  // The 磨砂度 the current window was actually built with, so the settings UI only prompts for a restart
  // when a level change crosses into a different vibrancy material (a genuine window rebuild) — not on
  // every blur>0. Returns a raw blurAmount; the renderer buckets it via the shared vibrancyMaterial().
  ipcMain.handle(CH.appVibrancyBaseline, () => builtWindowBlurAmount())

  const onSettings = (s: Settings) => {
    // Window transparency applies LIVE (setOpacity) — the slider updates instantly, no restart.
    applyWindowOpacity(s.appearance.windowOpacity)
    applyFontZoom(s.appearance.fontSize)
    applyAppIconSettings(s)
    if (s.pet.enabled && !petWin) createPet()
    else if (!s.pet.enabled && petWin) { petWin.close(); petWin = null }
    else if (petWin && !petWin.isDestroyed()) dockPet(petMode) // re-dock at current expand state
    // Turning the follow toggle on should take effect immediately: join the currently-focused screen.
    relocatePetToFocus(BrowserWindow.getFocusedWindow())
    // Re-register OS-level shortcuts in case the user changed a global keybinding.
    applyGlobalShortcuts()
    // Keep the Dock menu's 开关宠物 label in sync with pet.enabled (also when toggled from the UI).
    refreshDockMenu()
    // 每日 token 目标改了要立刻推给计数器(它会重算进度并广播),否则新目标要等下次重启才生效。
  }

  // Tray (right-click) + Dock context menu: 新建工作区 / 打开·关闭桌面宠物 / 退出. Rebuilt on each open so the
  // pet label reflects the current state. Menu actions the renderer owns (new-workspace) are relayed via
  // CH.menuAction and dispatched through its kbHandlers; pet + quit are handled here in the main process.
  // Fully open/close the desktop pet by flipping pet.enabled (creates or destroys the window + persists),
  // distinct from the lighter togglePet() above that only hides/shows an already-created pet.
  function togglePetEnabled(): void {
    const s = readSettings()
    const next = { ...s, pet: { ...s.pet, enabled: !s.pet.enabled } }
    writeSettings(next)
    onSettings(next)                                 // create/close the pet window per the new flag
    hub.broadcast(CH.settingsChanged, next)     // reflect the change in the open settings UI
  }
  function buildAppMenu(): Menu {
    const petEnabled = (() => { try { return readSettings().pet.enabled } catch { return true } })()
    return Menu.buildFromTemplate([
      { label: '新建工作区', click: () => { showMainWindow(); hub.broadcast(CH.menuAction, 'new-workspace') } },
      { label: petEnabled ? '关闭桌面宠物' : '打开桌面宠物', click: () => togglePetEnabled() },
      { type: 'separator' },
      { label: '退出 myFlowForge', click: () => { quitting = true; app.quit() } },
    ])
  }
  function refreshDockMenu(): void {
    if (process.platform === 'darwin') { try { app.dock?.setMenu(buildAppMenu()) } catch { /* dock unavailable */ } }
    // Windows' tray menu is owned by the Tray (setContextMenu), so it has to be rebuilt too —
    // otherwise the 打开/关闭桌面宠物 item keeps the label it had when the tray was created.
    if (process.platform === 'win32' && menuBarTray) { try { menuBarTray.setContextMenu(buildAppMenu()) } catch { /* tray gone */ } }
  }
  refreshDockMenu()  // initial Dock menu

  // OS notifications: fire only when the main window is unfocused; clicking focuses the app and
  // routes to the workspace (reuses the pet's navigateWorkspace path).
  const isMainFocused = () => !!mainWinRef && !mainWinRef.isDestroyed() && mainWinRef.isFocused()
  const routeAndFire = (n: ReturnType<typeof buildNotification>) => showOsNotification(n, () => {
    if (!mainWinRef || mainWinRef.isDestroyed()) return
    mainWinRef.show(); mainWinRef.focus()
    if (n.route.workspacePath) mainWinRef.webContents.send(CH.navigateWorkspace, { path: n.route.workspacePath })
  })
  // Test notification: fire immediately, bypassing the focus gate + config switches, so the user can tell
  // a system-permission problem (unsigned build never got macOS notification permission → nothing shows)
  // apart from the focus-gating (real notifications only fire when the app is in the background). Returns
  // whether the OS reports notification support at all.
  ipcMain.handle(CH.notifyTest, () => {
    showOsNotification(
      { title: 'myFlowForge · 测试通知', body: '如果你看到这条,系统通知工作正常。真实通知仅在 App 不在前台时才会弹出。', route: { workspacePath: '' } },
      () => { if (mainWinRef && !mainWinRef.isDestroyed()) { mainWinRef.show(); mainWinRef.focus() } },
    )
    return { supported: osNotificationsSupported() }
  })
  // 'done' comes off the chat stream — a chat reply OR a workflow's done narration both emit a chat
  // 'done', so one signal covers both without double-notifying. Sniff it as broadcasts pass through.
  const notifyChatDone = (payload: any) => {
    if (!payload || payload.type !== 'done' || !payload.workspacePath) return
    if (!shouldNotify('done', readSettings().notifications, isMainFocused())) return
    const wsName = readWorkspaceRegistry().find(w => w.path === payload.workspacePath)?.name ?? ''
    routeAndFire(buildNotification({ type: 'done', workspaceName: wsName, workspacePath: payload.workspacePath, sessionId: payload.sessionId, text: '会话已回复,点击查看' }))
  }
  // ★「有一道门等着你」那条通知。**2026-08-30 之前它根本不存在** —— 老的 notifyBridge 挂在
  //   已删掉的 orchestrator 的 `pending:add` 上,全仓库零引用,而设置里那两个开关一直摆着。
  //   现在它看的是和 botBridge / pushService 完全同一批活信号。
  const gateNotifier = createGateNotifier({
    getCfg: () => readSettings().notifications,
    isFocused: isMainFocused,
    notify: routeAndFire,
    workspaceName: (p) => readWorkspaceRegistry().find(w => w.path === p)?.name ?? '',
  })
  const broadcastWithNotify = (channel: string, payload: unknown) => {
    hub.broadcast(channel, payload)
    if (channel === CH.chatEvent) notifyChatDone(payload)
    gateNotifier(channel, payload)        // 门 → 本机系统通知(正文可以带内容,不经第三方)
    // 门 / 跑完了 → 已登记的手机(决策 7:daemon 直发 Expo,不经中转)。
    // ★只挂本机这一路:连着远程 host 时,推送该由**那台机器**发 —— 它才知道自己的设备表,
    //   而且人此刻正对着这台电脑,再往他手机上推一条纯属噪音。
    pushService.observe(channel, payload)
    botBridge.observe(channel, payload)   // mirror gate/ask/done/run2 events to the phone
  }
  // 终端(PTY)。★注册本身在 `registerIpc` 里,和别的方法一处 —— 传一个进去只是为了
  //  拿住句柄,好在退出/关窗时把 pty 收干净。`fallbackCwd` 只有桌面外壳答得上来:
  //  daemon 上没有「当前工作区」这回事。
  const termService = createTerminalService({
    fallbackCwd: () => activeWsPath,
    span: (name, fn) => perfSpan('term', name, fn),
  })
  // 唯一一处把方法表接到 Electron 上的地方。daemon 侧的 WS 网关遍历的是**同一张表** ——
  // 方法只有一份,所以不存在「本机一条路径、远程另一条路径」的漂移。
  const methodTable = registerIpc(broadcastWithNotify, buildProviderRegistry(), createElectronHost(), onSettings, termService)

  // 路由器坐在方法表前面:每一刀由本机接还是转发给远程 host,由它决定(第二期 B)。
  // ★渲染层和 preload 完全不知道有这回事 —— 它们永远只跟主进程说话。
  const router = createHostRouter({
    localTable: methodTable,
    toWindows: registry.broadcast,
    // ★远程主机推来的事件要单独补一次通知嗅探:本机那条挂在 broadcastWithNotify 上,
    //   远程事件不经过它 —— 于是「远程跑完了」这一声本来是**发不出来的**,
    //   而远程恰恰是最需要它的场景:人根本不在那台机器前面。
    //   分成两个出口是必须的:并进 toWindows 的话本机事件会各触发一次,变成每条回复弹两个通知。
    onRemoteEvent: (channel, payload) => {
      registry.broadcast(channel, payload)
      if (channel === CH.chatEvent) notifyChatDone(payload)
      // 远程那台升起来的门同样要在这块屏幕上弹一声 —— 而且远程恰恰是最需要的场景。
      // ★推送不挂这儿:那台机器有它自己的设备表,由它直发(否则同一道门会推两遍)。
      gateNotifier(channel, payload)
    },
    clientVersion: app.getVersion(),
    // 远程那台在系统提示里就显示这个名字。用机器名 —— 用户一眼认得出是哪台。
    clientLabel: hostname(),
    onStatus: (s) => registry.broadcast(CH.hostsStatusEvent, s),
    onLog: (m) => logInfo('remote', m),
    resolveUrl: async (h) => {
      // ★★配了中转就不拉隧道:走中转时 `remoteClient` 拨的是**中转**,`url` 只是个记录,
      //  连不到也不会去连。不挡的话「kind=ssh + 有中转」这种组合会白开一条 SSH 隧道
      //  (慢、可能失败、还要 cleanup),而那条隧道从头到尾没人用。
      if (h.relay) return { url: h.address }
      if (h.kind !== 'ssh') return { url: h.address }
      const { host, port } = { host: '127.0.0.1', port: Number(h.address) || 6767 }
      const t = await openSshTunnel({ target: h.sshTarget, remoteHost: host, remotePort: port, onLog: (m) => logInfo('remote', m) })
      return { url: `ws://127.0.0.1:${t.localPort}`, cleanup: () => t.close() }
    },
  })
  // ★本机核心的广播改从路由器过一道:连着远程时,本机 agent 的事件不许漏进界面(决策 2)。
  // 先摘掉启动期那路直通,否则每个事件会走两遍。
  detachDirectSink()
  hub.addSink(router.localEvent)

  for (const channel of Object.keys(methodTable)) {
    ipcMain.handle(channel, (e, ...args) => router.invoke(channel, {
      // ctx.emit = 「回给发起这次调用的那个窗口」,不是广播。窗口可能在异步 handler 跑到一半时
      // 被关掉,send 会抛;吞掉即可 —— 原先那两处 e.sender.send 本来就各自套着 try/catch。
      emit: (c, p) => { try { e.sender.send(c, p) } catch { /* window closed */ } },
      // 本机窗口发起的调用。权限门用它区分「我自己答的」和「别的设备答的」——
      // 前者不该在对话里加噪音,后者必须说清楚。
      client: { id: 'local', label: '本机' },
    }, args))
  }

  // ── 多主机管理。这些是**客户端自己的**事(这台设备认识哪些机器、现在连着谁),
  //    所以注册在这儿而不是方法表里 —— 天然不会被路由到远程。
  ipcMain.handle(CH.hostsList, () => readHosts().hosts)
  ipcMain.handle(CH.hostsUpsert, (_e, h: Parameters<typeof upsertHost>[0]) => {
    const next = upsertHost(h)
    // ★改的如果正是当前连着的这台,要把路由器里那份快照一起换掉 —— 否则标题栏上的
    //   名字/标识/显示方式不会变,看起来就是「保存了但没生效」。
    router.hostUpdated(next)
    return readHosts().hosts
  })
  ipcMain.handle(CH.hostsRemove, async (_e, id: string) => {
    if (router.current()?.id === id) await router.disconnect()
    return removeHost(id).hosts
  })
  ipcMain.handle(CH.hostsConnect, async (_e, id: string | null) => {
    if (!id) { await router.disconnect(); return router.status() }
    const h = readHosts().hosts.find((x: RemoteHost) => x.id === id)
    if (!h) throw new Error('没有这台主机')
    await router.connect(h)
    markConnected(id, Date.now())
    return router.status()
  })
  ipcMain.handle(CH.hostsDisconnect, async () => { await router.disconnect(); return router.status() })
  ipcMain.handle(CH.hostsStatus, () => router.status())
  // ── 手机端网关(决策 3:与 app 同生共死)。
  //    ★端在**这个进程里**,用的就是上面那张 methodTable 和同一条广播总线 hub ——
  //    所以手机和本机窗口面对的是**同一份核心**:同一张权限门表、同一份会话状态。
  //    另起一个 daemon.js 也能让手机连上,但那是第二个独立核心,两边互相看不见对方做了什么。
  //    这些 channel 跟 hosts:* 一样注册在这儿而不是方法表里 —— 它描述的是这台设备自己的服务,
  //    连去别的机器时不该被转发过去。
  const mobileGw = createAppGateway({
    table: methodTable,
    addSink: hub.addSink,
    version: app.getVersion(),
    onLog: (m) => logInfo('mobile', m),
    onStatus: (st) => registry.broadcast(CH.mobileStatusEvent, st),
  })
  void mobileGw.apply(readSettings().mobileGateway)
  ipcMain.handle(CH.mobileStatus, () => mobileGw.status())
  ipcMain.handle(CH.mobileApply, async (_e, cfg: Settings['mobileGateway']) => {
    // 先落盘再起 —— 起失败时开关要能弹回去,而那要靠 status().error,不是靠设置里的 enabled。
    writeSettings({ ...readSettings(), mobileGateway: cfg })
    return mobileGw.apply(cfg)
  })
  ipcMain.handle(CH.mobileRegenToken, () => mobileGw.regenToken())

  // ── 中转(第三期)。和上面那个手机端网关**不是二选一**:
  //    局域网网关 = 「同一个 wifi 里连得上」;中转 = 「NAT 后面也连得上」。
  //    在家走局域网(快、少一跳),出门走中转,同一个二维码。
  const relayCtl = createRelayController({
    table: methodTable,
    addSink: hub.addSink,
    version: app.getVersion(),
    onLog: (m) => logInfo('relay', m),
    onStatus: (st) => registry.broadcast(CH.relayStatusEvent, st),
  })
  void relayCtl.apply(readSettings().relay)
  ipcMain.handle(CH.relayStatus, () => relayCtl.status())
  ipcMain.handle(CH.relayIdentity, () => relayCtl.publicKey())
  ipcMain.handle(CH.relayApply, async (_e, cfg: Settings['relay']) => {
    // 先落盘再起 —— 起失败时开关要能弹回去,而那要靠 status().detail,不是靠设置里的 enabled。
    writeSettings({ ...readSettings(), relay: cfg })
    return relayCtl.apply(cfg)
  })

  ipcMain.handle(CH.hostsExport, (_e, includeTokens: boolean) => exportHosts({ includeTokens: !!includeTokens }))
  ipcMain.handle(CH.hostsImport, (_e, text: string) => importHosts(String(text ?? '')))

  // 成长宠物的今日 token 基线。全量扫盘只在这里跑这一次,之后靠 chatService 每轮累加。
  //
  // 为什么推到 setImmediate:scanTokenBaseline 同步遍历所有工作区的 .forge/sessions/*.jsonl 读
  // 全部消息。主窗口早在上面就创建了,在 whenReady 里直接扫会把主进程(连同 IPC)卡住,会话多的
  // 用户能直接感觉到。推后一个 tick 让就绪流程先跑完,扫盘再补上。
  //
  // 延后期间的竞态是自愈的,前提是下面这一整块必须留在同一个同步 tick 里(扫盘 → 建计数器 →
  // 装进 ref,中间不能有 await):
  //   · 空窗期结束的对话轮 → ref 还是 null,addDailyTokens 静默丢弃;但 finishOk 是先
  //     appendMessage(同步 appendFileSync)再 addDailyTokens,消息此刻已经在 jsonl 里,
  //     稍后的扫盘会把它算进基线 → 不丢。
  //   · 装好之后的对话轮 → 走累加;而基线是在 append 之前扫的 → 不重复。
  // 一旦把扫盘和 setDailyTokenCounter 拆到两个 tick,这两条就同时破了(中间 append 的既不进
  // 基线也没人累加,或者反过来两头都算)。别拆。
  setImmediate(() => {
    const settings = readSettings()
    const day = localDayKey(new Date())
    setDailyTokenCounter(createDailyTokenCounter({
      baseline: scanTokenBaseline(day),
      day,
      onChange: (s) => hub.broadcast(CH.growthSignal, s),
    }))
  })

  // ── Plugin Scheduler ────────────────────────────────────────────────────────
  const scheduler = new PluginScheduler({
    run: makeRun({ runHost: (p) => runPlugin(p) }),
    readPlugins,
    broadcast: (snap) => hub.broadcast(CH.pluginsChanged, snap),
  })
  setPluginScheduler(scheduler)
  scheduler.start()
  // ── End Plugin Scheduler ────────────────────────────────────────────────────

  // ── 卡顿监控 ────────────────────────────────────────────────────────────────
  // 只发给当前那个主窗口(原来的、或者关掉之后重建的那个),不经广播 ——
  // 卡顿提示是给正在看着屏幕的人的,序列化给宠物窗和别的窗口没有意义。
  const sendMain = (channel: string, payload: unknown) => {
    if (mainWinRef && !mainWinRef.isDestroyed()) mainWinRef.webContents.send(channel, payload)
  }

  // Perf monitor: detect main event-loop stalls, attribute to the running span, log + toast big ones.
  const stallReporter = new StallReporter({
    // The single 卡顿监控 toggle (perfDiagnostics) gates whether the monitor runs AT ALL (below), so if
    // a stall is ever reported the user opted in — always surface it (bell + the debug log). No separate
    // toast opt-in anymore (that second toggle was redundant with enabling the monitor).
    toast: (msg) => sendMain(CH.perfStall, { msg }),
    now: () => performance.now(),
  })
  // The stall monitor's 50ms sampler wakes the main event loop 20×/s forever — a real idle-power drain
  // (it alone keeps the CPU from ever quiescing / App Nap from engaging). So it's OFF unless the user
  // opts in via the 调试 pane (perfDiagnostics); a normal session never runs it.
  const perfMonitor = new EventLoopMonitor()
  if (readSettings().perfDiagnostics) perfMonitor.start((ms, active) => stallReporter.report(ms, active))

  // killAllAgentTrees:agent CLI 现在是 detached 的独立进程组(见 agents/procGroup.ts),而 execa 自带的
  // 「父进程退出时杀子进程」在 detached 下直接 return —— 不在这里补一刀,退出 app 就会把正在跑的 CLI
  // 连同它派生的 shell 命令一起留在后台。
  app.on('before-quit', () => {
    quitting = true; termService.killAll(); killAllAgentTrees(); scheduler.stop(); unregisterGlobalShortcuts()
    // ★远程连接也要收:SSH 隧道是我们自己 spawn 的子进程,不杀就变成孤儿留在系统里
    //   (每连一次留一个)。同一类坑在 agent 进程上已经栽过两次,不能在这儿再来一遍。
    //   before-quit 是同步的,所以只发出关闭指令,不 await —— 隧道进程收到 SIGTERM 就够了。
    void router.disconnect()
    // 网关也一起收:决策 3 说的「同生共死」不是修辞 —— 留一个还在听的端口给一个已经退出的
    // app,连上去只会是一堆永远不 settle 的调用。
    void mobileGw.close()
  })
  // 主窗口关掉(mac 上 app 还活着)→ 只收**本机窗口开的**那些终端。
  // ★不能用 killAll:这台机器同时也是别人的 host,连上来的客户端开的终端归它们自己,
  //   由它们那条连接断开时收(见 InvokeCtx.onClose)。
  mainWin.on('closed', () => termService.killOwner('local'))

  // Dock-icon click / re-activation. The pet window keeps the process alive, so getAllWindows()
  // is never empty — the old "create only when 0 windows" check never fired, leaving a hidden or
  // behind-other-apps main window stranded (clicking the Dock icon did nothing). Bring the existing
  // window forward, and re-assert foreground because the pet can flip the runtime back to UIElement.
  app.on('activate', () => {
    // ★★这里是那个 bug 最常现形的地方:每次点 Dock 图标 / 从别的 app 切回来都会跑一遍,
    //  而裸的 `dock.show()` 会把自定义图标刷回默认(理由见 reassertDock 上面那段)。
    reassertDock()
    // 「点击前是否在焦点」:macOS 在触发 activate 之前就已把窗口聚焦,isFocused() 恒 true 不可用;而 activate
    // 又在窗口 focus 事件【之前】触发,所以此刻 appFocused 标志仍是【点击前】的真实状态(切走别的 app 时主窗口
    // blur 已把它设 false)。点击前不在焦点(false)→ 显示并获焦、不收起;点击前在焦点(true)→ visible 时 toggle 收起。
    const action = resolveDockActivationAction({
      platform: process.platform,
      hasWindow: !!mainWinRef,
      destroyed: !!mainWinRef?.isDestroyed(),
      minimized: !!mainWinRef?.isMinimized(),
      visible: !!mainWinRef?.isVisible(),
      focused: appFocused,
    })
    if (action === 'minimize' && mainWinRef && !mainWinRef.isDestroyed()) {
      parkWindowInDock(mainWinRef, process.platform, !!menuBarTray)
      return
    }
    if (action === 'restore' || action === 'show') {
      showMainWindow()
    } else {
      // Rebuild after a real close: track it as the main window and re-wire the close behavior
      // (hide-to-Dock / quit / ask) so the rebuilt window behaves the same as the original.
      const win = createMainWindow()
      mainWinRef = win
      registry.add(win.webContents)
      wireMainClose(win)
    }
    app.focus({ steal: true })
  })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
