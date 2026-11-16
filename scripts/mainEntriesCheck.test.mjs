import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { checkMainEntries, ENTRIES, CHUNK_DIR } = require('./mainEntriesCheck.cjs')

// 1.3.0-cu.1 shipped a chunk that resolved forgeMcp.js from its own __dirname (out/main/chunks/), so the forge MCP
// server died with MODULE_NOT_FOUND every turn. This runs after `npm run build`, before anything is packaged.
let out
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'mff-out-main-'))
  for (const e of ['index.js', 'daemon.js', ...ENTRIES]) writeFileSync(join(out, e), '"use strict";\n')
  mkdirSync(join(out, CHUNK_DIR))
  writeFileSync(join(out, CHUNK_DIR, 'core-abc.js'), 'const e = mainEntryPath(__dirname, "forgeMcp.js");\n')
})
afterEach(() => rmSync(out, { recursive: true, force: true }))

describe('mainEntriesCheck', () => {
  it('a good tree passes', () => {
    expect(checkMainEntries(out)).toEqual([])
  })
  it.each([
    'join(__dirname, "forgeMcp.js")',
    "path.join(__dirname, 'agentShim.js')",
    'node_path.join(__dirname,`forgeMcp.js`)',
    'resolve(__dirname, "agentShim.js")',
  ])('a chunk resolving an entry from its own __dirname fails: %s', (code) => {
    writeFileSync(join(out, CHUNK_DIR, 'bad-1.js'), `x(${code})\n`)
    expect(checkMainEntries(out).join('\n')).toMatch(/bad-1\.js/)
  })
  it.each(ENTRIES)('a missing out/main/%s fails', (e) => {
    rmSync(join(out, e))
    expect(checkMainEntries(out).join('\n')).toContain(e)
  })
  it('a shared chunk outside the chunk directory fails (mainEntryPath only knows that one name)', () => {
    mkdirSync(join(out, 'assets'))
    writeFileSync(join(out, 'assets', 'core-x.js'), '\n')
    expect(checkMainEntries(out).join('\n')).toMatch(/assets/)
  })
  it('CHUNK_DIR is the name the vite config and mainEntryPath use', () => {
    expect(readFileSync(join(ROOT, 'src/main/agents/mainEntry.ts'), 'utf8')).toContain(`export const MAIN_CHUNK_DIR = '${CHUNK_DIR}'`)
    expect(readFileSync(join(ROOT, 'electron.vite.config.ts'), 'utf8')).toMatch(/chunkFileNames: `\$\{MAIN_CHUNK_DIR\}\/\[name\]-\[hash\]\.js`/)
  })
  it.each(['build-mac-all.sh', 'build-mac-test.sh'])('%s runs the check right after npm run build', (f) => {
    const l = readFileSync(join(ROOT, 'scripts', f), 'utf8').split('\n').map((x) => x.trim())
    const b = l.indexOf('npm run build')
    const c = l.indexOf('node scripts/mainEntriesCheck.cjs out/main')
    expect(b).toBeGreaterThan(-1)
    expect(c).toBeGreaterThan(b)
    expect(l.slice(b + 1, c).some((x) => x.startsWith('npx electron-builder'))).toBe(false)
  })
})
