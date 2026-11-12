#!/usr/bin/env node
// Builds the computer-use helper `forge-cu` (native/mac/forge-cu, Swift) as a universal macOS binary at
// build/native/darwin/forge-cu, which electron-builder ships as Contents/Resources/native/forge-cu
// (electron-builder.yml → mac.extraResources).
//
//   node scripts/build-cu-helper.mjs              dev: no swiftc → one line, exit 0
//   node scripts/build-cu-helper.mjs --require    dist: no swiftc / a missing arch → exit 1
//   node scripts/build-cu-helper.mjs --self-test  compile + run the pure-logic self-test (host arch).
//                                                 That binary links Core.swift only: it cannot post
//                                                 input, capture the screen or touch TCC.
//
// Non-darwin hosts do nothing (the helper is mac-only; other platforms get unsupportedDriver).
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = 'native/mac/forge-cu'
export const HELPER_SOURCES = ['main', 'Core', 'Capture', 'Input', 'Windows', 'Status', 'Exec'].map((f) => `${SRC}/${f}.swift`)
export const HELPER_OUT = 'build/native/darwin/forge-cu'
const TMP = 'build/native/tmp'
const MIN_OS = 'macos12.0'

/** Pure: the commands that build the universal helper. Paths are relative to `cwd` (= root). */
export function planSwiftBuild({ root }) {
  const slice = (arch) => `${TMP}/forge-cu-${arch}`
  const swiftc = (arch) => ({
    cmd: 'xcrun',
    args: ['swiftc', '-O', '-target', `${arch}-apple-${MIN_OS}`, ...HELPER_SOURCES, '-o', slice(arch)],
    cwd: root,
  })
  return [
    swiftc('x86_64'),
    swiftc('arm64'),
    { cmd: 'lipo', args: ['-create', slice('x86_64'), slice('arm64'), '-output', HELPER_OUT], cwd: root },
  ]
}

/** Pure: compile the self-test (Core.swift + tests/main.swift) for the host arch. */
export function planSelfTest({ root, arch = process.arch === 'arm64' ? 'arm64' : 'x86_64' }) {
  const out = `${TMP}/forge-cu-selftest`
  return [
    { cmd: 'xcrun', args: ['swiftc', '-target', `${arch}-apple-${MIN_OS}`, `${SRC}/Core.swift`, `${SRC}/tests/main.swift`, '-o', out], cwd: root },
    { cmd: out, args: [], cwd: root },
  ]
}

function run(step) {
  const r = spawnSync(step.cmd, step.args, { cwd: step.cwd, stdio: 'inherit' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${step.cmd} ${step.args[0] ?? ''} exited ${r.status}`)
}

function haveSwiftc() {
  const r = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' })
  return r.status === 0 && Boolean(r.stdout.trim())
}

function main(argv) {
  const require = argv.includes('--require')
  const selfTest = argv.includes('--self-test')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  if (process.platform !== 'darwin') return 0
  if (!haveSwiftc()) {
    if (require || selfTest) { console.error('✗ forge-cu: swiftc not found (install Xcode or the Command Line Tools)'); return 1 }
    console.log('▸ forge-cu: swiftc not found, skipped (computer use will report the helper as missing)')
    return 0
  }
  mkdirSync(join(root, TMP), { recursive: true })
  mkdirSync(join(root, dirname(HELPER_OUT)), { recursive: true })
  try {
    if (selfTest) { for (const s of planSelfTest({ root })) run(s); return 0 }
    for (const s of planSwiftBuild({ root })) run(s)
    const archs = spawnSync('lipo', ['-archs', join(root, HELPER_OUT)], { encoding: 'utf8' }).stdout?.trim().split(/\s+/) ?? []
    if (!archs.includes('x86_64') || !archs.includes('arm64')) {
      console.error(`✗ forge-cu: expected x86_64 + arm64, got "${archs.join(' ')}"`)
      return 1
    }
    console.log(`▸ forge-cu: ${HELPER_OUT} (${archs.join(' ')})`)
    return 0
  } catch (e) {
    console.error(`✗ forge-cu: ${e instanceof Error ? e.message : e}`)
    return 1
  } finally {
    rmSync(join(root, TMP), { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
