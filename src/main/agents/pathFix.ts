import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

// A GUI app launched from Finder/Dock inherits launchd's minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) — NOT the user's login-shell PATH. So the agent CLIs
// (`claude`/`codex`) and `which` aren't found, and every run/chat fails to spawn them.
// (In `electron-vite dev` this never bites because the process is launched from the terminal,
// which already exports the full PATH.) We resolve the login shell's PATH and merge in the
// usual install locations, de-duplicated, so child processes can find the CLIs.

const FALLBACK_DIRS = (home: string) => [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(home, '.local', 'bin'),
  join(home, '.bun', 'bin'),
  join(home, '.deno', 'bin'),
  join(home, '.npm-global', 'bin'),
  join(home, 'node_modules', '.bin'),
]

/** Pure merge: shell PATH (may be '') + current PATH + fallback dirs, de-duped, order-preserving. */
export function mergePath(currentPath: string, shellPath: string, home: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of [shellPath, currentPath, ...FALLBACK_DIRS(home)]) {
    for (const dir of part.split(':')) {
      if (dir && !seen.has(dir)) { seen.add(dir); out.push(dir) }
    }
  }
  return out.join(':')
}

/** Ask the login shell for its PATH. Returns '' on any failure (caller falls back to dirs). */
function readShellPath(shell: string): string {
  try {
    return execSync(`${shell} -ilc 'echo -n "$PATH"'`, { timeout: 3000, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/**
 * Compute the fixed PATH for a packaged macOS/Linux app, or `undefined` when no fix is needed
 * (Windows, or not packaged — dev already has the right PATH). Apply the result to
 * `process.env.PATH` before any agent is spawned.
 */
export function fixExecPath(opts: {
  packaged: boolean
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  readShell?: (shell: string) => string
}): string | undefined {
  if (!opts.packaged || opts.platform === 'win32') return undefined
  const read = opts.readShell ?? readShellPath
  const shellPath = read(opts.env.SHELL || '/bin/zsh')
  return mergePath(opts.env.PATH ?? '', shellPath, homedir())
}
