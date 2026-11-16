// Post-build check (build-mac-all.sh / build-mac-test.sh, right after `npm run build`). 1.3.0-cu.1 shipped a shared
// chunk that resolved forgeMcp.js from its own __dirname (out/main/chunks/), so the forge MCP server died with
// MODULE_NOT_FOUND every turn. Fails when an entry is missing, when a chunk resolves an entry from __dirname, or when
// shared code lands outside CHUNK_DIR (src/main/agents/mainEntry.ts MAIN_CHUNK_DIR, the only name mainEntryPath knows).
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')

const ENTRIES = ['forgeMcp.js', 'agentShim.js']
const TOP = new Set(['index.js', 'daemon.js', ...ENTRIES])
const CHUNK_DIR = 'chunks'
const BAD = /\b(?:join|resolve)\(\s*__dirname\s*,\s*['"`](?:forgeMcp|agentShim)\.js['"`]/

function jsFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? jsFiles(p) : n.endsWith('.js') ? [p] : []
  })
}

/** Problems found under `outMain` (out/main); [] = good. */
function checkMainEntries(outMain) {
  const problems = []
  for (const e of ENTRIES) if (!existsSync(join(outMain, e))) problems.push(`missing ${e}`)
  for (const f of jsFiles(outMain)) {
    const rel = relative(outMain, f)
    const inChunks = rel.startsWith(CHUNK_DIR + '/')
    if (!inChunks && !TOP.has(rel)) problems.push(`shared code outside ${CHUNK_DIR}/: ${rel}`)
    if (inChunks && BAD.test(readFileSync(f, 'utf8'))) problems.push(`${rel} resolves a main entry from its own __dirname`)
  }
  return problems
}

module.exports = { checkMainEntries, ENTRIES, CHUNK_DIR }

if (require.main === module) {
  const dir = process.argv[2] || 'out/main'
  const p = checkMainEntries(dir)
  if (p.length) { for (const x of p) console.error(`✗ ${x}`); process.exit(1) }
  console.log(`  ✓ ${dir}: ${ENTRIES.join(', ')} present, no chunk resolves them from __dirname`)
}
