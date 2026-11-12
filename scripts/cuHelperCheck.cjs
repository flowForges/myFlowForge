// Post-build check: the packaged computer-use helper (Contents/Resources/native/forge-cu) must be present
// and carry NO entitlements (spec V13 — the app's set would make it DYLD-injectable). Ground truth is
// `codesign -d --entitlements - --xml`, run on the built .app; nothing here executes the helper.
//
//   node scripts/cuHelperCheck.cjs release/mac/myFlowForge.app release/mac-arm64/myFlowForge.app
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const HELPER_REL = 'Contents/Resources/native/forge-cu'

/** Keys of an entitlements plist dump (empty / no dump → []). */
function entitlementKeys(xml) {
  return [...String(xml).matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])
}

function checkPackagedHelper(appPath) {
  const f = join(appPath, HELPER_REL)
  if (!existsSync(f)) throw new Error(`[forge-cu] missing: ${f}`)
  const r = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', f], { encoding: 'utf8' })
  // an unsigned / linker-signed slice has no entitlements blob at all: that is the empty set too
  const keys = entitlementKeys(r.stdout)
  if (keys.length) throw new Error(`[forge-cu] ${f} carries entitlements: ${keys.join(', ')}`)
  return f
}

module.exports = { HELPER_REL, entitlementKeys, checkPackagedHelper }

if (require.main === module) {
  try {
    for (const app of process.argv.slice(2)) console.log(`  ✓ ${checkPackagedHelper(app)}: no entitlements`)
  } catch (e) {
    console.error(`✗ ${e.message}`)
    process.exit(1)
  }
}
