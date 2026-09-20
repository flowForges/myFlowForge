import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'

const pexec = promisify(execFile)

// Windows opener detection, part 2: the registry fallback for apps installed somewhere we don't
// guess. `App Paths` is the canonical place an installer registers its executable — it's what makes
// `Win+R → code` work — so it finds custom install locations that no path template can cover.
//
// Read-only: we only ever `reg query`. Nothing here writes to the registry.

// Hives in probe order. Per-user installers (VS Code "User Setup", Cursor, JetBrains Toolbox) write
// to HKCU; system-wide installers write to HKLM.
const HIVES = ['HKCU', 'HKLM'] as const
const APP_PATHS = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'

// Runs one `reg query`. Injected so detection is testable off Windows.
export type RegQuery = (key: string) => Promise<string>

// Pull the value out of `reg.exe query … /ve` output. The layout is
//   <blank>
//   HKEY_…\App Paths\Code.exe
//       (Default)    REG_SZ    C:\Program Files\Microsoft VS Code\Code.exe
// The value is everything after the type token — it contains spaces, so it can't be split on
// whitespace. Some installers wrap it in quotes.
export function parseAppPathValue(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /\s(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line)
    if (!m) continue
    const value = m[2].trim().replace(/^"(.*)"$/, '$1').trim()
    if (value) return value
  }
  return null
}

// Look up an executable's registered full path, or null. `exists` guards against a stale entry left
// behind by an uninstall — launching that would just error out in the user's face.
export async function queryAppPath(
  exeName: string,
  reg: RegQuery = defaultRegQuery,
  exists: (p: string) => boolean = existsSync,
): Promise<string | null> {
  for (const hive of HIVES) {
    let out: string
    // reg.exe exits non-zero for a missing key, and doesn't exist at all off Windows.
    try { out = await reg(`${hive}\\${APP_PATHS}\\${exeName}`) } catch { continue }
    const value = parseAppPathValue(out)
    if (value && exists(value)) return value
  }
  return null
}

const defaultRegQuery: RegQuery = async (key) => {
  const { stdout } = await pexec('reg', ['query', key, '/ve'])
  return stdout
}
