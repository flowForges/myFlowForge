import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { entitlementKeys, checkPackagedHelper, HELPER_REL } = require('./cuHelperCheck.cjs')
const { entitlementsFor } = require('./afterPack.cjs')

// (16) the packaged forge-cu must carry NO entitlements (spec V13). `codesign -d --entitlements -` is
// the ground truth; these rows run it on ad-hoc signed temp copies. Nothing here executes the helper.
describe('cuHelperCheck', () => {
  it('entitlementKeys reads the keys of a codesign --xml dump', () => {
    expect(entitlementKeys('<?xml version="1.0"?><plist version="1.0"><dict/></plist>')).toEqual([])
    expect(entitlementKeys('')).toEqual([])
    expect(entitlementKeys('<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>'))
      .toEqual(['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation'])
  })

  it('HELPER_REL is where electron-builder puts it', () => {
    expect(HELPER_REL).toBe('Contents/Resources/native/forge-cu')
  })

  const built = join(ROOT, 'build/native/darwin/forge-cu')
  const canSign = process.platform === 'darwin' && existsSync(built)
  it.skipIf(!canSign)('a copy signed the way afterPack signs it passes; one signed with the app entitlements fails', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cu-ent-'))
    try {
      const app = join(tmp, 'X.app')
      const dest = join(app, HELPER_REL)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(built, dest)
      const sign = (ent) => execFileSync('codesign', ['--force', '--options', 'runtime', '--entitlements', join(ROOT, ent), '--sign', '-', dest], { stdio: 'pipe' })
      sign(entitlementsFor(dest))
      expect(() => checkPackagedHelper(app)).not.toThrow()
      sign('build/entitlements.mac.plist')
      expect(() => checkPackagedHelper(app)).toThrow(/allow-dyld-environment-variables/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('a missing helper fails the check', () => {
    expect(() => checkPackagedHelper(join(tmpdir(), 'nope.app'))).toThrow(/missing/)
  })
})
