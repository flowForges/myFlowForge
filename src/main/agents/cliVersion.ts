import { execa } from 'execa'

/**
 * Extract a semver-ish version from a CLI's `--version` output.
 * Some agent CLIs (claude/codex) are wrappers that print a proxy/banner line to stdout BEFORE the
 * real version, so we take the LAST version-looking token, not the first.
 * Returns '' when nothing matches.
 */
export function parseCliVersion(stdout: string): string {
  const matches = stdout.match(/\d+\.\d+(?:\.\d+)?/g)
  return matches && matches.length ? matches[matches.length - 1] : ''
}

/** Run `<bin> --version` (fail-open) and parse the version string. '' on any failure. */
export async function getCliVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (!bin) return ''
  try {
    const { stdout, stderr } = await execa(bin, ['--version'], { env, reject: false })
    return parseCliVersion(`${stdout ?? ''}\n${stderr ?? ''}`)
  } catch {
    return ''
  }
}

export interface CliProbe { installed: boolean; version: string }

/**
 * Single-spawn probe: run `<bin> --version` ONCE and derive both "is it installed"
 * (command exits 0) and the parsed version. Providers' detect() and getCliVersion()
 * each used to spawn their own `--version` — claude/codex are slow node wrappers, so
 * detection paid the cold-start cost twice per CLI. Fail-open to not-installed.
 */
export async function probeCli(bin: string, env: NodeJS.ProcessEnv): Promise<CliProbe> {
  if (!bin) return { installed: false, version: '' }
  try {
    const r = await execa(bin, ['--version'], { env, reject: false })
    const installed = !r.failed && r.exitCode === 0
    return { installed, version: installed ? parseCliVersion(`${r.stdout ?? ''}\n${r.stderr ?? ''}`) : '' }
  } catch {
    return { installed: false, version: '' }
  }
}
