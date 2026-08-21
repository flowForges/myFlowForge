// Windows opener detection, part 1: turn a catalog path TEMPLATE into a real path on this machine.
//
// A template looks like `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`. Two substitutions:
//
//   %VAR%  environment variable, matched case-insensitively (that's how Windows itself resolves
//          them, and `ProgramFiles(x86)` in particular is written a dozen different ways in the
//          wild). An undefined variable makes the whole candidate fail — we must never probe a
//          literal `%NOPE%\…` path.
//   *      one path segment, matched against the real directory listing. Needed because JetBrains
//          (and Toolbox) bury the executable under a version/build directory whose name we can't
//          know: `…\JetBrains\IntelliJ IDEA 2024.1\bin\idea64.exe`.
//
// Everything is injected (exists/readdir) so the whole thing is unit-testable on a Mac.

export interface WinFsProbe {
  exists: (p: string) => boolean
  // Directory entry NAMES (not full paths). May throw — callers treat that as "empty".
  readdir: (dir: string) => string[]
}

const SEP = '\\'

// Case-insensitive environment lookup, matching Windows' own semantics.
function envLookup(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const want = name.toLowerCase()
  for (const key of Object.keys(env)) if (key.toLowerCase() === want) return env[key]
  return undefined
}

// Substitute every %VAR%. Returns null if any variable is undefined.
function expandVars(template: string, env: NodeJS.ProcessEnv): string | null {
  let missing = false
  const out = template.replace(/%([^%]+)%/g, (_m, name: string) => {
    const v = envLookup(name, env)
    if (v === undefined) { missing = true; return '' }
    return v
  })
  return missing ? null : out
}

// A segment pattern → regex, matched against ONE directory entry name. `*` therefore always stays
// within a single path level for free — an entry name can't contain a separator.
function segmentMatcher(segment: string): RegExp {
  const escaped = segment.replace(/[.+?^${}()|[\]\\]/g, m => '\\' + m).replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

function safeReaddir(dir: string, fs: WinFsProbe): string[] {
  try { return fs.readdir(dir) } catch { return [] }
}

// Depth-first walk over the segments, branching at every wildcard. Returns the first fully-existing
// path. Wildcard matches are tried in DESCENDING order so the newest version wins when several are
// installed — and because it BACKTRACKS, a newer directory missing the executable (a half-removed
// install, a version that moved its binary) doesn't shadow an older one that still has it.
function walk(base: string, segments: string[], fs: WinFsProbe): string | null {
  if (segments.length === 0) return fs.exists(base) ? base : null
  const [head, ...rest] = segments
  if (!head.includes('*')) return walk(base + SEP + head, rest, fs)
  const re = segmentMatcher(head)
  const matches = safeReaddir(base, fs).filter(name => re.test(name)).sort().reverse()
  for (const name of matches) {
    const hit = walk(base + SEP + name, rest, fs)
    if (hit) return hit
  }
  return null
}

// Resolve one template to a real path on this machine, or null.
export function resolveWindowsPath(template: string, env: NodeJS.ProcessEnv, fs: WinFsProbe): string | null {
  const expanded = expandVars(template, env)
  if (expanded === null) return null
  const [root, ...segments] = expanded.split(SEP)
  return walk(root, segments, fs)
}

// Probe a candidate list in order; first one that resolves wins (catalog order = preference order).
export function resolveFirstWindowsPath(templates: string[], env: NodeJS.ProcessEnv, fs: WinFsProbe): string | null {
  for (const t of templates) {
    const hit = resolveWindowsPath(t, env, fs)
    if (hit) return hit
  }
  return null
}
