import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const ALLOW = new Set([
  'src/main/computerUse/helperDriver.test.ts',
  'src/main/computerUse/noRealDriver.test.ts',
  'scripts/buildScript.test.mjs',
  'src/main/computerUse/buildScript.test.ts',
  'src/main/agents/procGroup.disclaim.test.ts',
  'scripts/afterPack.test.mjs',
  'scripts/cuHelperCheck.test.mjs', // codesigns temp copies of the helper; never runs it
])

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git' || n === 'out' || n === 'dist') continue
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** Text of a call's argument list starting right after `name(`, balanced parens. */
export function callArgs(src: string, name: string): string[] {
  const res: string[] = []
  const re = new RegExp(`(?<![\\w.])${name}\\s*\\(`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 1, i = re.lastIndex
    while (i < src.length && depth > 0) { const ch = src[i++]; if (ch === '(') depth++; else if (ch === ')') depth--; }
    res.push(src.slice(re.lastIndex, i - 1))
  }
  return res
}

/** Violations found in one test file's source. */
export function scanTestSource(rel: string, src: string): string[] {
  const bad: string[] = []
  if (!ALLOW.has(rel)) {
    for (const fn of ['helperDriver', 'createDriver']) {
      for (const a of callArgs(src, fn)) {
        if (!/\bspawn\b/.test(a)) bad.push(`${rel}: ${fn}( without spawn:`)
      }
    }
    for (const fn of ['spawn', 'execa', 'execFile', 'execFileSync', 'execSync', 'spawnSync']) {
      for (const a of callArgs(src, fn)) {
        if (/forge-cu|native\/darwin/.test(a)) bad.push(`${rel}: ${fn}( mentions the helper`)
      }
    }
  }
  return bad
}

describe('no real driver is reachable from tests', () => {
  it('no test builds helperDriver without an injected spawn or runs the helper binary', () => {
    const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))]
      .filter((f) => /\.test\.(ts|tsx|mjs)$/.test(f))
    // (13) the walk must really have found the tree, or an empty scan passes vacuously
    expect(files.length).toBeGreaterThan(100)
    expect(files.map((f) => relative(ROOT, f))).toContain('src/main/computerUse/helperDriver.test.ts')
    const bad = files.flatMap((f) => scanTestSource(relative(ROOT, f), readFileSync(f, 'utf8')))
    expect(bad).toEqual([])
  })

  it('plant: a test that builds helperDriver() without spawn is flagged', () => {
    const planted = `import { helperDriver } from './helperDriver'\nconst d = helperDriver({ helperPath: () => '/x', ownerPid: 1 })\n`
    expect(scanTestSource('src/main/computerUse/planted.test.ts', planted)).toHaveLength(1)
    const ok = `const d = helperDriver({ helperPath: () => '/x', ownerPid: 1, spawn })\n`
    expect(scanTestSource('src/main/computerUse/ok.test.ts', ok)).toEqual([])
    expect(scanTestSource('src/main/x/planted.test.ts', `const d = createDriver('darwin', { helperPath: () => '/x', ownerPid: 1 })`)).toHaveLength(1)
    expect(scanTestSource('src/main/x/ok.test.ts', `const d = createDriver('darwin', { helperPath: () => '/x', ownerPid: 1, spawn })`)).toEqual([])
  })

  it('plant: spawning or execa-ing the helper path is flagged outside the allowlist', () => {
    expect(scanTestSource('a.test.ts', `execa('build/native/darwin/forge-cu', ['status'])`)).toHaveLength(1)
    expect(scanTestSource('a.test.ts', `spawn(join(root, 'forge-cu'), [])`)).toHaveLength(1)
    expect(scanTestSource('src/main/computerUse/helperDriver.test.ts', `spawn('/x/forge-cu', [])`)).toEqual([])
  })
})
