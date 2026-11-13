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
    expect(at('configureDisclaim({ launcher: () => resolveHelperPath(app.isPackaged), enabled: () => cuRuntime?.disclaimEnabled() === true })'))
      .toBeLessThan(at('app.whenReady().then('))
  })

  it('events reach the local sink only: the shell gets registry.broadcast, never hub.broadcast / router.localEvent (V2)', () => {
    expect(SRC).toContain('localBroadcast: registry.broadcast,')
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

  it('the startup probe runs (it does nothing unless provisioned)', () => {
    expect(SRC).toContain('void cuRuntime.startup()')
  })
})
