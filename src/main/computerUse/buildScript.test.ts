import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Packaging of the forge-cu helper (Review Focus 18 file rows, 22). Pure: reads files and calls the
// pure planner. Nothing here compiles, spawns or runs the helper.
const ROOT = resolve(__dirname, '../../..')
const SRC_DIR = 'native/mac/forge-cu'
const OUT = 'build/native/darwin/forge-cu'

type Step = { cmd: string; args: string[]; cwd?: string }
async function planner(): Promise<{ planSwiftBuild: (o: { root: string }) => Step[]; HELPER_SOURCES: string[] }> {
  return import(pathToFileURL(join(ROOT, 'scripts/build-cu-helper.mjs')).href)
}

describe('planSwiftBuild', () => {
  it('two xcrun swiftc -O steps (x86_64, arm64, macOS 12) then one lipo -create into build/native/darwin/forge-cu', async () => {
    const { planSwiftBuild } = await planner()
    const plan = planSwiftBuild({ root: ROOT })
    expect(plan).toHaveLength(3)
    const [x, a, l] = plan
    for (const [s, arch] of [[x, 'x86_64'], [a, 'arm64']] as const) {
      expect(s.cmd).toBe('xcrun')
      expect(s.args.slice(0, 4)).toEqual(['swiftc', '-O', '-target', `${arch}-apple-macos12.0`])
      expect(s.args.at(-2)).toBe('-o')
    }
    const tmpX = x.args.at(-1)!, tmpA = a.args.at(-1)!
    expect(tmpX).not.toBe(tmpA)
    // temp slices must not land in the shipped dir (extraResources copies build/native/darwin)
    expect(tmpX.startsWith('build/native/darwin/')).toBe(false)
    expect(tmpA.startsWith('build/native/darwin/')).toBe(false)
    expect(l).toEqual({ cmd: 'lipo', args: ['-create', tmpX, tmpA, '-output', OUT], cwd: ROOT })
    expect(x.cwd).toBe(ROOT)
  })

  it('compiles every helper source, including Exec.swift and the caller check, and no test harness', async () => {
    const { planSwiftBuild, HELPER_SOURCES } = await planner()
    const [x, a] = planSwiftBuild({ root: ROOT })
    const sources = x.args.slice(4, -2)
    expect(a.args.slice(4, -2)).toEqual(sources)
    expect(sources).toEqual(HELPER_SOURCES)
    for (const f of ['main', 'Capture', 'Input', 'Windows', 'Status', 'Exec', 'Core']) {
      expect(sources).toContain(`${SRC_DIR}/${f}.swift`)
    }
    expect(sources.some((s) => s.includes('/tests/'))).toBe(false)
    for (const s of sources) expect(existsSync(join(ROOT, s)), s).toBe(true)
    // V4 caller check lives in the compiled sources: exit code 2 on a wrong parent, proc_pidpath for the bundle rule
    const all = sources.map((s) => readFileSync(join(ROOT, s), 'utf8')).join('\n')
    expect(all).toMatch(/exit\(2\)/)
    expect(all).toMatch(/proc_pidpath/)
    expect(all).toMatch(/getppid\(\)/)
    expect(all).toMatch(/responsibility_spawnattrs_setdisclaim/)
    expect(all).toMatch(/POSIX_SPAWN_SETEXEC/)
    expect(all).toMatch(/SIGUSR1/)
  })

  it('the helper links only the allowed system frameworks', async () => {
    const { HELPER_SOURCES } = await planner()
    const allowed = new Set(['Foundation', 'CoreGraphics', 'ScreenCaptureKit', 'ApplicationServices', 'AppKit', 'Carbon', 'ImageIO'])
    for (const s of HELPER_SOURCES) {
      for (const m of readFileSync(join(ROOT, s), 'utf8').matchAll(/^\s*import\s+(\w+)/gm)) {
        expect(allowed.has(m[1]), `${s} imports ${m[1]}`).toBe(true)
      }
    }
  })
})

describe('packaging wiring', () => {
  it('electron-builder.yml maps build/native/darwin → native (forge-cu only) under mac.extraResources', () => {
    const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
    const mac = yml.split(/^mac:\s*$/m)[1]?.split(/^\S/m)[0] ?? ''
    const er = mac.split(/^ {2}extraResources:\s*$/m)[1]?.split(/^ {2}\S/m)[0] ?? ''
    expect(er).toMatch(/-\s+from:\s*build\/native\/darwin\s*\n\s+to:\s*native\s*\n\s+filter:\s*\n\s+-\s*"?forge-cu"?/)
    // the top-level list is untouched (V14)
    const top = yml.split(/^mac:\s*$/m)[0]
    for (const f of ['resources/example-plugins', 'build/app-icons', 'assets/pet-packs']) expect(top).toContain(`from: ${f}`)
  })

  it('.gitignore ignores build/native/', () => {
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim())).toContain('build/native/')
  })

  it('build-mac-all.sh builds the helper with --require right after npm run build', () => {
    const sh = readFileSync(join(ROOT, 'scripts/build-mac-all.sh'), 'utf8').split('\n').map((l) => l.trim())
    const b = sh.indexOf('npm run build')
    const h = sh.indexOf('node scripts/build-cu-helper.mjs --require')
    expect(b).toBeGreaterThan(-1)
    expect(h).toBeGreaterThan(b)
    expect(sh.slice(b + 1, h).some((l) => l.startsWith('npx electron-builder'))).toBe(false)
    // (16) after packaging, the shipped helper is checked to carry no entitlements
    expect(sh).toContain('node scripts/cuHelperCheck.cjs release/mac/myFlowForge.app release/mac-arm64/myFlowForge.app')
  })

  it('package.json has build:cu-helper', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['build:cu-helper']).toBe('node scripts/build-cu-helper.mjs')
  })

  it('build/entitlements.cu.plist is an empty <dict/> (V13)', () => {
    const p = readFileSync(join(ROOT, 'build/entitlements.cu.plist'), 'utf8')
    expect(p).toMatch(/<plist version="1\.0">\s*<dict\/>\s*<\/plist>/)
    expect(p).not.toMatch(/<key>/)
  })
})

describe('build-mac-test.sh (side-by-side test package, Review Focus 18)', () => {
  const sh = () => readFileSync(join(ROOT, 'scripts/build-mac-test.sh'), 'utf8')
  const lines = () => sh().split('\n').map((l) => l.trim())

  it('exists, is wired as dist:mac-test, and has valid shell syntax', async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['dist:mac-test']).toBe('bash scripts/build-mac-test.sh')
    const { spawnSync } = await import('node:child_process')
    expect(spawnSync('bash', ['-n', join(ROOT, 'scripts/build-mac-test.sh')]).status).toBe(0)
  })

  it('builds the forge-cu helper with --require right after npm run build', () => {
    const l = lines()
    const b = l.indexOf('npm run build')
    const h = l.indexOf('node scripts/build-cu-helper.mjs --require')
    expect(b).toBeGreaterThan(-1)
    expect(h).toBeGreaterThan(b)
    expect(l.slice(b + 1, h).some((x) => x.startsWith('npx electron-builder'))).toBe(false)
  })

  it('checks the packaged forge-cu: lipo -archs, no entitlements, bundle id com.zghua.myflowforge.test', () => {
    const s = sh()
    expect(s).toContain('lipo -archs "${APP}/Contents/Resources/native/forge-cu"')
    expect(s).toMatch(/node scripts\/cuHelperCheck\.cjs "\$\{APP\}"/)
    expect(s).toContain('com.zghua.myflowforge.test')
    expect(s).toContain('-c.appId=com.zghua.myflowforge.test')
  })

  it('has no leftovers from the other branch', () => {
    expect(sh()).not.toMatch(/mff-ai|mffai/i)
  })

  it('keeps signing, version and arch options; ad-hoc by default', () => {
    const s = sh()
    for (const k of ['MFF_TEST_SIGN', 'MFF_TEST_VERSION', 'MFF_TEST_ARCHS']) expect(s).toContain(k)
    expect(s).toMatch(/unset APPLE_SIGN_IDENTITY/)
  })
})
