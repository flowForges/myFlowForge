import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * index.ts can't be loaded in a test (it boots Electron), so its computer-use wiring is pinned by reading the source,
 * the way terminalPreload.test.ts pins the preload. The behaviour behind each line is tested in runtime / shell /
 * cuOverlay tests; this only proves index.ts plugs them in as required.
 */
const SRC = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
const at = (needle: string) => { const i = SRC.indexOf(needle); expect(i, needle).toBeGreaterThanOrEqual(0); return i }

describe('index.ts computer-use wiring', () => {
  it('configureDisclaim runs at module load, before app.whenReady and so before any agent spawn, with the runtime as its switch', () => {
    expect(SRC).toContain('const configureCuDisclaim = () => configureDisclaim({ launcher: () => resolveHelperPath(app.isPackaged), enabled: () => cuRuntime?.disclaimEnabled() === true })')
    expect(at('\nconfigureCuDisclaim()\n')).toBeLessThan(at('app.whenReady().then('))
    // I-4: an explicit disclaim:false from the helper reconfigures (drops the latch) for plain spawns
    expect(SRC).toContain('onDisclaimUnavailable: configureCuDisclaim,')
  })

  it('events reach the main window only: not the pet (I-1), never hub.broadcast / router.localEvent (V2)', () => {
    const sink = SRC.slice(at('    localBroadcast: (channel, payload) => {'), at('    overlay: cuOverlay,'))
    expect(sink).toContain('mainWinRef.webContents.send(channel, payload)')
    expect(sink).not.toMatch(/registry|petWin|hub/)
    expect(SRC).toContain('emit: (e) => cuShell?.emit(e),')
    expect(SRC).not.toMatch(/(hub\.broadcast|broadcastWithNotify|router\.localEvent)\(CH\.cuEvent/)
    expect(SRC).not.toMatch(/CH\.cuOverlayState/)
  })

  it('the host gets the runtime getter; the service gets chatStop as stopTurn and the real driver factory', () => {
    expect(SRC).toContain('createElectronHost({ computerUse: () => cuRuntime?.host() })')
    expect(SRC).toMatch(/stopTurn: \(k\) => \{ void Promise\.resolve\(methodTableRef\?\.\[CH\.chatStop\]\?\.\(NOOP_CTX, k\)\)/)
    // split so noRealDriver.test.ts doesn't read this needle as a driver built without a spawn
    expect(SRC).toContain('makeDriver: () => ' + 'createDriver' + '(process.platform, { helperPath: cuHelperPath, ownerPid: process.pid,')
    expect(SRC).toContain('startBridge: startCuBridge,')
  })

  it('powerMonitor lock events, the stop hotkey and the tray are wired (Review Focus 12)', () => {
    expect(SRC).toContain("attachPowerMonitor(powerMonitor, () => cuRuntime?.onLock())")
    expect(SRC).toContain('...(cuShell?.shortcutHandlers() ?? {}),')
    expect(SRC).toContain('stopAll: () => cuRuntime?.stopAll(),')
    expect(SRC).toContain('...cuTrayMenuItems(cuShell?.active() ?? false, () => cuRuntime?.stopAll()),')
    expect(SRC).toContain('menuBarTray?.setTitle(cuTrayTitle(active))')
  })

  it('the OS notification goes through osNotify with the shell-built title and body only (Review Focus 10)', () => {
    expect(SRC).toContain("notify: (n, onClick) => showOsNotification({ title: n.title, body: n.body, route: { workspacePath: '' } }, onClick),")
    expect(SRC).toContain("shouldNotify: () => shouldNotify('confirm', readSettings().notifications, isMainFocused()),")
  })

  it('quit disposes the helper and the socket in the existing before-quit cleanup', () => {
    const quit = SRC.slice(at("app.on('before-quit', () => {\n    // ★共商"))
    expect(quit.slice(0, quit.indexOf('\n  })'))).toContain('void cuRuntime?.dispose()')
  })

  it('I-1: the startup latch reads both grants in process, without a prompt (isTrustedAccessibilityClient(false))', () => {
    expect(SRC).toContain("screenGranted: () => process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'granted',")
    expect(SRC).toContain("axGranted: () => process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false),")
    expect(SRC).not.toMatch(/isTrustedAccessibilityClient\(true\)/)
  })

  it('the startup probe runs (it does nothing unless provisioned)', () => {
    expect(SRC).toContain('void cuRuntime.startup()')
  })

  it('I-1: every method-table channel passes the sender check (main window or overlay) before the router', () => {
    expect(SRC).toContain('ipcMain.handle(channel, (e, ...args) => cuSenderAllowed(channel, e.sender.id, () => [mainWinRef?.webContents.id, cuOverlay.webContentsId()])')
    expect(SRC).toContain(': NOT_LOCAL)')
  })

  it('I-2: before-quit turns every session off and sweeps the token files before disposing', () => {
    const quit = SRC.slice(at("app.on('before-quit', () => {\n    // ★共商"))
    const body = quit.slice(0, quit.indexOf('\n  })'))
    expect(body.indexOf('cuRuntime?.quit()')).toBeGreaterThan(0)
    expect(body.indexOf('cuRuntime?.quit()')).toBeLessThan(body.indexOf('void cuRuntime?.dispose()'))
  })

  it('I-3: the startup latch is Screen Recording granted to the app; M-8: settings changes drop the cache; M-3: hotkey failure reaches the overlay', () => {
    expect(SRC).toContain("screenGranted: () => process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'granted',")
    expect(SRC).not.toMatch(/isTrustedAccessibilityClient\((true)?\)/)   // I-1 adds the no-prompt form only
    expect(SRC).toContain('cuRuntime?.settingsChanged()')
    expect(SRC).toContain("cuShell?.setHotkeyFailed(failed.includes('computer-use-stop'))")
  })
})
