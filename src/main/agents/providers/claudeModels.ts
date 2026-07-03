import { openSync, readSync, closeSync, realpathSync, statSync, existsSync as fsExistsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { execa } from 'execa'
import type { Model } from '../types'

// The claude CLI ships no `--list-models` / `claude models` command and `/model` is TUI-only.
// But the alias→real-id mapping IS baked into the compiled bundle as an object literal, e.g.
//   {haiku:"claude-haiku-4-5-20251001",sonnet:"claude-sonnet-4-6",fable:"claude-fable-5",opus:"claude-opus-4-8"}
// We recover it by scanning the binary. This is the only local source of the *real* versions a
// given claude install resolves its aliases to — everything here fails open so detection never wedges.

const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const
type Alias = (typeof ALIASES)[number]

// Matches `alias:"claude-..."` with the key optionally quoted (object shorthand or JSON).
// Global so a single content string can yield every alias; callers reset by constructing fresh.
function aliasRe(): RegExp {
  return /"?(opus|sonnet|haiku|fable)"?\s*:\s*"(claude-(?:opus|sonnet|haiku|fable)-[0-9][a-z0-9-]*)"/g
}

/**
 * Parse the alias→real-id map out of a chunk of claude bundle text. Pure. Fail-open to {}.
 * First occurrence of each alias wins (the canonical map literal appears before any aliased copies).
 */
export function parseClaudeAliasMap(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!content) return out
  const re = aliasRe()
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const alias = m[1]
    if (!out[alias]) out[alias] = m[2]
  }
  return out
}

/** Convert an alias→id map into ordered Model[] for the UI (id = the real pinned model version). */
export function aliasMapToModels(map: Record<string, string>): Model[] {
  const cap: Record<Alias, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' }
  const out: Model[] = []
  for (const a of ALIASES) {
    const id = map[a]
    if (!id) continue
    out.push({ id, label: cap[a], description: `${a} → ${id}` })
  }
  return out
}

export interface ResolveBinDeps {
  realpath?: (p: string) => string
  statSize?: (p: string) => number
  existsSync?: (p: string) => boolean
  home?: string
}

// A real claude bundle (Bun Mach-O, or npm cli.js) is large; a launcher shim/wrapper is tiny.
// Anything below this can't contain the model table, so we reject it and try the next candidate.
const MIN_BUNDLE_BYTES = 1_000_000

/**
 * Resolve a launcher path (symlink/shim/bare) to the real claude bundle file we can scan.
 * Strategy: realpath the launcher; if that's missing or too small to be the bundle, walk a list
 * of well-known install locations. Returns '' when nothing usable is found (→ fall back to static).
 */
export function resolveRealClaudeBin(launcher: string, deps: ResolveBinDeps = {}): string {
  const realpath = deps.realpath ?? realpathSync
  const statSize = deps.statSize ?? ((p: string) => statSync(p).size)
  const existsSync = deps.existsSync ?? fsExistsSync
  const home = deps.home ?? homedir()

  const candidates: string[] = []
  if (launcher) candidates.push(launcher)
  candidates.push(
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  )

  for (const c of candidates) {
    try {
      if (!existsSync(c)) continue
      const real = realpath(c)
      if (statSize(real) >= MIN_BUNDLE_BYTES) return real
    } catch { /* try next candidate */ }
  }
  return ''
}

export interface ExtractDeps {
  /** Yields the file content in chunks (injected for tests; production streams the real file). */
  readChunks?: (path: string) => Iterable<string>
}

// Longest plausible match is ~50 chars; carry this many bytes across chunk boundaries so a map
// entry split between two reads is still captured.
const CARRY = 128
const CHUNK_BYTES = 1 << 20 // 1 MiB

function* readFileChunks(path: string): Iterable<string> {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES)
    let bytes = 0
    while ((bytes = readSync(fd, buf, 0, CHUNK_BYTES, null)) > 0) {
      yield buf.toString('latin1', 0, bytes)
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Stream a (possibly huge) claude bundle and accumulate the alias→id map without loading the
 * whole file into memory. Handles matches that straddle a chunk boundary via a carry buffer.
 * Fail-open to {}.
 */
export function extractAliasMapFromFile(path: string, deps: ExtractDeps = {}): Record<string, string> {
  const readChunks = deps.readChunks ?? readFileChunks
  const out: Record<string, string> = {}
  try {
    let carry = ''
    for (const chunk of readChunks(path)) {
      const combined = carry + chunk
      const found = parseClaudeAliasMap(combined)
      for (const [a, id] of Object.entries(found)) {
        if (!out[a]) out[a] = id
      }
      // The map literal is contiguous; once all aliases are known there's nothing left to find,
      // so stop instead of scanning the remaining (hundreds of MB of) binary.
      if (Object.keys(out).length >= ALIASES.length) break
      carry = combined.slice(-CARRY)
    }
  } catch {
    return {}
  }
  return out
}

export interface ClaudeModelsLiveDeps extends ResolveBinDeps, ExtractDeps {
  /** Resolve the `claude` launcher on PATH (injected for tests). */
  which?: (env: NodeJS.ProcessEnv) => Promise<string>
}

async function defaultWhich(env: NodeJS.ProcessEnv): Promise<string> {
  try { const r = await execa('which', ['claude'], { env }); return r.stdout.trim() } catch { return '' }
}

/**
 * Discover claude's REAL locally-resolved model versions by reading its compiled bundle.
 * Resolves the binary (bare name → which → realpath → candidate fallback), scans it for the alias
 * map, and returns Model[]. Fail-open to [] so detection falls back to the static catalog.
 */
export async function readClaudeModelsLive(
  bin: string,
  env: NodeJS.ProcessEnv,
  deps: ClaudeModelsLiveDeps = {},
): Promise<Model[]> {
  const which = deps.which ?? defaultWhich
  const launcher = bin && isAbsolute(bin) ? bin : (await which(env)) || bin
  const realBin = resolveRealClaudeBin(launcher, deps)
  if (!realBin) return []
  return aliasMapToModels(extractAliasMapFromFile(realBin, deps))
}
