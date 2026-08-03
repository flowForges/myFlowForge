// electron-builder afterPack hook: ad-hoc code-sign the packaged macOS .app.
//
// Why: the build ships with `identity: null` (no paid Developer ID). A *fully unsigned* macOS app is
// never registered with the notification daemon (usernoted) — it gets no permission prompt, never shows
// up in System Settings → 通知, and every banner silently no-ops. An **ad-hoc** signature (`codesign
// --sign -`) gives the bundle a stable code-signing identity (a cdhash), which is enough for macOS to
// register it and let notifications work on this machine. It does NOT remove the Gatekeeper
// "unidentified developer / damaged" warning (that needs a real Developer ID + notarization) — it only
// fixes local notifications.
//
// afterPack (not afterSign): with `identity: null` electron-builder skips its signing step entirely, so
// afterSign may never fire. afterPack runs right after the .app is assembled and before the dmg is
// built, so the dmg packages the already-ad-hoc-signed app.

const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { existsSync } = require('node:fs')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = join(context.appOutDir, appName)
  if (!existsSync(appPath)) {
    console.warn(`[afterPack] .app not found at ${appPath}; skipping ad-hoc sign`)
    return
  }
  // --force: replace any existing signature. --deep: also sign nested helpers/frameworks (Electron
  // Helper apps, node-pty spawn-helper, forgeMcp, etc.). --sign -: ad-hoc identity (no certificate).
  // --timestamp=none: ad-hoc signatures can't be timestamped by Apple's TSA.
  console.log(`[afterPack] ad-hoc signing ${appName} (fixes macOS notifications on unsigned builds)…`)
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' })
    // Verify the signature took (ad-hoc is valid-on-disk; Gatekeeper assessment still fails, expected).
    execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' })
    console.log('[afterPack] ad-hoc signature applied.')
  } catch (e) {
    // Don't fail the whole build if codesign is unavailable — just warn (notifications stay broken).
    console.warn(`[afterPack] ad-hoc sign failed: ${e && e.message ? e.message : e}`)
  }
}
