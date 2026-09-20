import { execa } from 'execa'

// "Where is this CLI installed?" — one place, because the answer is a different program per platform.
// POSIX has `which`; Windows has `where`, and `which` simply does not exist there, so every provider
// probe used to fail and every CLI showed as not installed.

export type BinLookupRun = (
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; exitCode?: number | undefined }>

export function lookupCommand(platform: NodeJS.Platform): 'which' | 'where' {
  return platform === 'win32' ? 'where' : 'which'
}

// Windows extensions the shell will actually execute, best first. An npm global install lays down
// three files side by side — an extensionless shell script (for Git Bash), a `.cmd` and a `.ps1` —
// and `where` prints all of them. Only the .cmd is runnable by Windows itself, so taking the first
// line can hand back a file that cannot be executed.
const WIN_RUNNABLE = ['.exe', '.cmd', '.bat', '.com']

export function pickBinPath(stdout: string, platform: NodeJS.Platform): string | null {
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (platform !== 'win32') return lines[0] ?? null
  // where.exe writes its "not found" message to stdout in some shells, not stderr.
  const paths = lines.filter(l => !l.startsWith('INFO:') && !l.startsWith('ERROR:'))
  for (const ext of WIN_RUNNABLE) {
    const hit = paths.find(p => p.toLowerCase().endsWith(ext))
    if (hit) return hit
  }
  return paths[0] ?? null
}

const defaultRun: BinLookupRun = (cmd, args, opts) => execa(cmd, args, { ...opts, reject: true })

// Absolute path of `bin` on PATH, or null. Never throws — `which`/`where` exit non-zero when the
// command isn't found, and execa turns that into a rejection.
export async function lookupBin(
  bin: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  run: BinLookupRun = defaultRun,
): Promise<string | null> {
  try {
    const r = await run(lookupCommand(platform), [bin], { env })
    if (r.exitCode !== undefined && r.exitCode !== 0) return null
    return pickBinPath(r.stdout, platform)
  } catch {
    return null
  }
}
