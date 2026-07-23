import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, session, Tray } from 'electron'
import { registerGlobalShortcuts, unregisterGlobalShortcuts } from './shortcuts/globalShortcuts'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createMainWindow } from './windows/mainWindow'
import { createPetWindow, resolvePetLayout, MARGIN, clampPetSprite, petClampRegion } from './windows/petWindow'
import { parkWindowInDock, resolveCloseAction, resolveDockActivationAction } from './windows/closeBehavior'
import { relocatePetToRegion, PET_EXPANDED, PET_BUBBLE, petCollapsedSize, petPopupSize, clampPetScale, petMaxSize, petResizeFootprint } from '@shared/petGeometry'
import type { PetVDir, PetSizeMode } from '@shared/petGeometry'
import { WindowRegistry } from './windows/windowRegistry'
import { registerIpc } from './ipc/handlers'
import { showOsNotification, osNotificationsSupported } from './notify/osNotify'
import { shouldNotify, buildNotification } from './notify/notifier'
import { gazeAngle } from '@shared/petGaze'
import { CH } from './ipc/channels'
import { buildProviderRegistry } from './agents/registry'
import { readSettings, writeSettings, readWorkspaceRegistry } from './config/store'
import { fixExecPath } from './agents/pathFix'
import type { Settings } from './config/schema'
import { TerminalManager } from './terminal/terminalManager'
import { TermBatcher } from './terminal/termBatch'
import { makeCwdProbe } from './terminal/cwdProbe'
import { parseOsc7, abbreviateHome } from './terminal/cwdTrack'
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
import { registerFontScheme, handleFontProtocol } from './appearance/fontProtocol'
import { join } from 'node:path'
import { resolveDockIconPath, resolveMenuBarIconPath } from './appIcon'
import { DEFAULT_BUILTIN_PET_ID, hasAllBuiltinPets, mergeBuiltinPets } from '@shared/builtinPets'
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

app.whenReady().then(() => {
  if (!gotInstanceLock) return // a second instance is already quitting — don't build any windows
  const iconPathEnv = () => ({ resourcesPath: process.resourcesPath, appPath: app.getAppPath(), isPackaged: app.isPackaged })
  const applyDockIcon = (iconId: Settings['appIcon']['dockIcon']) => {
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
  if (process.platform === 'darwin') {
    app.setActivationPolicy('regular')
    app.dock?.show().catch(() => { /* dock unavailable — nothing to do */ })
    try { applyDockIcon(readSettings().appIcon.dockIcon) } catch { /* settings/icon unavailable — bundle icon remains */ }
  }

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
    // Pets slimmed to one bundled built-in (white-catgirl); the rest are downloadable. An existing user
    // whose active pet was a now-removed built-in (e.g. builtin-china-dragon) would point at a pet no
    // longer in the list → fall back to white-catgirl. They can re-download the old one from the gallery.
    const wantActive = hadBuiltinPets ? pet.activeCustomPetId : `builtin-${DEFAULT_BUILTIN_PET_ID}`
    const activeMissing = !mergedCustomPets.some(p => p.id === wantActive)
    const activeCustomPetId = activeMissing ? `builtin-${DEFAULT_BUILTIN_PET_ID}` : wantActive
    const nextPet = {
      ...pet,
      skin: hadBuiltinPets ? pet.skin : 'custom',
      customPets: mergedCustomPets,
      activeCustomPetId,
    }
    if (migrated > 0 || !hadBuiltinPets || builtinsRefreshed || activeMissing) {
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
    const keep = new Set([bgRelFromUrl(a.bgImage), bgRelFromUrl(a.homeBgImage)].filter((r): r is string => !!r))
    const removed = gcBackgrounds(keep)
    if (removed > 0) logInfo('appearance', `已清理 ${removed} 张无引用的背景图`)
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
  // Live-stream debug log entries to any open renderer (the Settings · 调试日志 pane).
  setAppLogEventSink((e) => registry.broadcast(CH.appLogEvent, e))
  const mainWin = createMainWindow()
  mainWinRef = mainWin
  registry.add(mainWin.webContents)

  const showMainWindow = () => {
    if (!mainWinRef || mainWinRef.isDestroyed()) return
    if (mainWinRef.isMinimized()) mainWinRef.restore()
    mainWinRef.show()
    mainWinRef.focus()
    app.focus({ steal: true })
  }
  const applyMenuBarIcon = (show: boolean) => {
    if (process.platform !== 'darwin') return
    if (!show) {
      menuBarTray?.destroy()
      menuBarTray = null
      return
    }
    if (menuBarTray) return
    const image = nativeImage.createFromPath(resolveMenuBarIconPath(iconPathEnv()))
    if (image.isEmpty()) return
    const trayImage = image.resize({ width: 18, height: 18 })
    trayImage.setTemplateImage(true)
    menuBarTray = new Tray(trayImage)
    menuBarTray.setToolTip('FlowForge')
    // Left-click opens the app; right-click drops the context menu (新建工作区 / 开关宠物 / 退出).
    menuBarTray.on('click', showMainWindow)
    menuBarTray.on('right-click', () => menuBarTray?.popUpContextMenu(buildAppMenu()))
  }
  const applyAppIconSettings = (settings: Settings) => {
    applyDockIcon(settings.appIcon.dockIcon)
    applyMenuBarIcon(settings.appIcon.showMenuBar)
  }
  applyAppIconSettings(readSettings())
  // Once the window is up, make sure the app is the foreground one (owns the menu bar) AND that the
  // Dock icon is showing — re-assert both here because the pet window can flip the runtime back to
  // UIElement after the initial call.
  mainWin.once('ready-to-show', () => {
    app.focus({ steal: true })
    if (process.platform === 'darwin') app.dock?.show().catch(() => {})
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
      if (action === 'hide') { parkWindowInDock(win); return }
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
          registry.broadcast(CH.settingsChanged, readSettings())
        }
        if (response === 0) { parkWindowInDock(win); return }
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
    registry.broadcast(CH.shortcutsStatus, { failed })
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
    registry.broadcast(CH.settingsChanged, readSettings())
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
  ipcMain.handle(CH.petFocusWorkspace, (_e, path: string) => {
    if (mainWin.isDestroyed()) return
    mainWin.show(); mainWin.focus()
    mainWin.webContents.send(CH.navigateWorkspace, { path })
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
  // transparent/vibrancy are construction-time only, so toggling 毛玻璃 needs a full restart to
  // rebuild the window. Let the settings UI trigger it directly. Force-quit past the close-action
  // guard (set quitting) so the app actually exits and relaunches instead of parking in the Dock.
  ipcMain.handle(CH.appRelaunch, () => { quitting = true; app.relaunch(); app.exit(0) })

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
    registry.broadcast(CH.settingsChanged, next)     // reflect the change in the open settings UI
  }
  function buildAppMenu(): Menu {
    const petEnabled = (() => { try { return readSettings().pet.enabled } catch { return true } })()
    return Menu.buildFromTemplate([
      { label: '新建工作区', click: () => { showMainWindow(); registry.broadcast(CH.menuAction, 'new-workspace') } },
      { label: petEnabled ? '关闭桌面宠物' : '打开桌面宠物', click: () => togglePetEnabled() },
      { type: 'separator' },
      { label: '退出 myFlowForge', click: () => { quitting = true; app.quit() } },
    ])
  }
  function refreshDockMenu(): void {
    if (process.platform === 'darwin') { try { app.dock?.setMenu(buildAppMenu()) } catch { /* dock unavailable */ } }
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
  const broadcastWithNotify = (channel: string, payload: unknown) => {
    registry.broadcast(channel, payload)
    if (channel === CH.chatEvent) notifyChatDone(payload)
  }
  registerIpc(broadcastWithNotify, buildProviderRegistry(), onSettings)

  // ── Plugin Scheduler ────────────────────────────────────────────────────────
  const scheduler = new PluginScheduler({
    run: makeRun({ runHost: (p) => runPlugin(p) }),
    readPlugins,
    broadcast: (snap) => registry.broadcast(CH.pluginsChanged, snap),
  })
  setPluginScheduler(scheduler)
  scheduler.start()
  // ── End Plugin Scheduler ────────────────────────────────────────────────────

  // ── Terminal PTY bridge ─────────────────────────────────────────────────────
  const lsofExec = (pid: number) => new Promise<string>((res, rej) =>
    execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], (e, out) => e ? rej(e) : res(out)))

  const cwdProbes = new Map<string, (pid: number) => Promise<void>>()
  const cwdTimers = new Map<string, NodeJS.Timeout>()
  const lastOscCwd = new Map<string, string>()
  const termHome = homedir()

  // node-pty is a native module — import lazily to avoid load-time crash in test env
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePty = require('node-pty') as typeof import('node-pty')

  // Send only to the current main window (original or rebuilt-after-close). Used for high-frequency
  // terminal events so they don't get needlessly serialized to the pet / other windows.
  const sendMain = (channel: string, payload: unknown) => {
    if (mainWinRef && !mainWinRef.isDestroyed()) mainWinRef.webContents.send(channel, payload)
  }

  // Perf monitor: detect main event-loop stalls, attribute to the running span, log + toast big ones.
  const stallReporter = new StallReporter({
    // Opt-in: only pop the stall as a bell notification when the user enabled it in the 调试 pane.
    // Stalls are always logged (StallReporter.report → logWarn) so the debug log stays complete.
    toast: (msg) => { if (readSettings().perfStallToast) sendMain(CH.perfStall, { msg }) },
    now: () => performance.now(),
  })
  // The stall monitor's 50ms sampler wakes the main event loop 20×/s forever — a real idle-power drain
  // (it alone keeps the CPU from ever quiescing / App Nap from engaging). So it's OFF unless the user
  // opts in via the 调试 pane (perfDiagnostics); a normal session never runs it.
  const perfMonitor = new EventLoopMonitor()
  if (readSettings().perfDiagnostics) perfMonitor.start((ms, active) => stallReporter.report(ms, active))

  // Assigned just below (after scheduleCwd is defined). The pty onData closure references it, but that
  // only fires asynchronously once a terminal is spawned, long after this synchronous setup completes.
  let termBatcher: TermBatcher
  const termManager = new TerminalManager({
    spawn: (shell, args, o) =>
      nodePty.spawn(shell, args, {
        name: 'xterm-256color',
        cwd: o.cwd,
        env: o.env as Record<string, string>,
        cols: o.cols,
        rows: o.rows,
      }),
    onData: (termId, data) => {
      // Terminal data is high-frequency (keystroke echo + prompt redraw, and thousands of chunks/sec
      // under a build/log flood). Coalesce chunks in a short window before crossing IPC — one send
      // per chunk saturated the main event loop, janking heavy output AND delaying keystroke echo
      // (it waited behind the flood). Batching also lets us parse OSC7/cwd once per blob, not per chunk.
      termBatcher.push(termId, data)
    },
    onExit: (termId, e) => {
      termBatcher.flush(termId)   // emit any buffered trailing output before the exit event
      cwdProbes.delete(termId)
      const t = cwdTimers.get(termId)
      if (t !== undefined) { clearTimeout(t); cwdTimers.delete(termId) }
      lastOscCwd.delete(termId)
      sendMain(CH.termExit, { termId, ...e })
    },
    exists: existsSync,
  })

  const scheduleCwd = (termId: string) => {
    const probe = cwdProbes.get(termId)
    const pid = termManager.pidOf(termId)
    if (!probe || pid === undefined) return
    clearTimeout(cwdTimers.get(termId))
    cwdTimers.set(termId, setTimeout(() => void probe(pid), 150))
  }

  // Coalesce PTY output → one IPC send per short window (instead of one per chunk), and parse the
  // cwd OSC once per coalesced blob. A full OSC7 sequence is more likely intact in a coalesced blob
  // than split across raw chunks, so cwd tracking gets slightly more reliable too.
  termBatcher = new TermBatcher({
    flush: (termId, data) => perfSpan('term', 'flush', () => {
      sendMain(CH.termData, { termId, data })
      const osc = parseOsc7(data)
      if (osc) {
        const abbr = abbreviateHome(osc, termHome)
        if (abbr !== lastOscCwd.get(termId)) { lastOscCwd.set(termId, abbr); sendMain(CH.termCwd, { termId, cwd: abbr }) }
      } else {
        scheduleCwd(termId)
      }
    }),
  })

  ipcMain.handle(CH.termCreate, (_e, opts: { termId: string; cwd?: string; cols: number; rows: number }) => {
    try {
      // Prefer the requested cwd; else fall back to the active workspace (so a terminal opened while
      // a workspace is focused lands there, not at ~); else home.
      const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd
        : activeWsPath && existsSync(activeWsPath) ? activeWsPath
        : homedir()
      termManager.create({ termId: opts.termId, cwd, cols: opts.cols || 80, rows: opts.rows || 24 })
      cwdProbes.set(
        opts.termId,
        makeCwdProbe({
          exec: lsofExec,
          home: homedir(),
          onCwd: c => sendMain(CH.termCwd, { termId: opts.termId, cwd: c }),
        }),
      )
      scheduleCwd(opts.termId)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.on(CH.termWrite, (_e, p: { termId: string; data: string }) => {
    termManager.write(p.termId, p.data)
  })

  ipcMain.on(CH.termResize, (_e, p: { termId: string; cols: number; rows: number }) => {
    termManager.resize(p.termId, p.cols, p.rows)
  })

  ipcMain.on(CH.termKill, (_e, p: { termId: string }) => {
    cwdProbes.delete(p.termId)
    const t = cwdTimers.get(p.termId)
    if (t !== undefined) { clearTimeout(t); cwdTimers.delete(p.termId) }
    lastOscCwd.delete(p.termId)
    termManager.kill(p.termId)
  })

  app.on('before-quit', () => { quitting = true; termManager.killAll(); scheduler.stop(); unregisterGlobalShortcuts() })
  mainWin.on('closed', () => termManager.killAll())
  // ── End terminal PTY bridge ─────────────────────────────────────────────────

  // Dock-icon click / re-activation. The pet window keeps the process alive, so getAllWindows()
  // is never empty — the old "create only when 0 windows" check never fired, leaving a hidden or
  // behind-other-apps main window stranded (clicking the Dock icon did nothing). Bring the existing
  // window forward, and re-assert foreground because the pet can flip the runtime back to UIElement.
  app.on('activate', () => {
    if (process.platform === 'darwin') {
      app.setActivationPolicy('regular')
      app.dock?.show().catch(() => {})
    }
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
      parkWindowInDock(mainWinRef)
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
