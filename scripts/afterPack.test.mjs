import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = '68b9bbf2'
const { entitlementsFor } = require('./afterPack.cjs')

const APP = '/tmp/release/mac-arm64/myFlowForge.app'

/**
 * forge-cu (computer use) must be signed with the EMPTY entitlements (spec V13): the app's set carries
 * allow-dyld-environment-variables + disable-library-validation, which would make the helper that owns
 * the user's Accessibility / Screen Recording grant DYLD-injectable. Every other naked Mach-O keeps the
 * app's entitlements — node-pty's spawn-helper in particular must not change.
 */
describe('afterPack · entitlementsFor', () => {
  it('Resources/native/forge-cu → build/entitlements.cu.plist', () => {
    expect(entitlementsFor(`${APP}/Contents/Resources/native/forge-cu`)).toBe('build/entitlements.cu.plist')
  })

  it('spawn-helper and any other naked binary keep build/entitlements.mac.plist', () => {
    for (const p of [
      `${APP}/Contents/Resources/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`,
      `${APP}/Contents/Resources/app/node_modules/x/bin/forge-cu`, // same name, wrong place
      `${APP}/Contents/Resources/native/forge-cu-old`,
      `${APP}/Contents/Resources/native/other`,
    ]) expect(entitlementsFor(p), p).toBe('build/entitlements.mac.plist')
  })

  it('the hook passes the choice through signBinary(f, identity, { entitlements })', () => {
    const src = readFileSync(join(ROOT, 'scripts/afterPack.cjs'), 'utf8')
    expect(src).toMatch(/signBinary\(f, plan\.identity, \{ entitlements: entitlementsFor\(f\) \}\)/)
  })
})

/** Lines of `b` that are not in an LCS with `a` (added or changed), plus lines of `a` that were dropped. */
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n')
  const dp = Array.from({ length: A.length + 1 }, () => new Int32Array(B.length + 1))
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) {
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const added = [], removed = []
  let i = 0, j = 0
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { i++; j++ } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(A[i++]); else added.push(B[j++])
  }
  while (i < A.length) removed.push(A[i++])
  while (j < B.length) added.push(B[j++])
  return { added, removed }
}

describe(`signing scripts vs ${BASE} (spec V13 / F34)`, () => {
  const old = (p) => execFileSync('git', ['show', `${BASE}:${p}`], { cwd: ROOT, encoding: 'utf8' })

  it('macSigning.cjs is byte-identical', () => {
    expect(readFileSync(join(ROOT, 'scripts/macSigning.cjs'), 'utf8')).toBe(old('scripts/macSigning.cjs'))
  })

  it('afterPack.cjs differs only by the forge-cu entitlements choice', () => {
    const { added, removed } = lineDiff(old('scripts/afterPack.cjs'), readFileSync(join(ROOT, 'scripts/afterPack.cjs'), 'utf8'))
    expect(removed).toEqual([
      "const { signingPlan, machOFilesUnder, signBinary } = require('./macSigning.cjs')",
      '    signBinary(f, plan.identity)',
    ])
    const allowed = /entitlements|forge-cu|^\s*(\/\/.*)?$|^\s*[{}()]*\s*$/i
    expect(added.filter((l) => !allowed.test(l))).toEqual([])
  })
})
