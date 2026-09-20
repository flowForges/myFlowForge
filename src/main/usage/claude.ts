import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { HttpClient, StatusbarUsage } from './types'
import { normalizeWindow } from './normalize'

export function normalizeClaude(raw: unknown, nowMs: number): StatusbarUsage {
  const o = (raw ?? {}) as Record<string, unknown>
  const window5h = normalizeWindow(o.five_hour, nowMs)
  const weekly = normalizeWindow(o.seven_day ?? o.seven_day_sonnet, nowMs)
  return { ...(window5h ? { window5h } : {}), ...(weekly ? { weekly } : {}), label: 'Claude' }
}

interface TokenDeps {
  runSecurity?: () => string
  readCredFile?: (path: string) => string
  platform?: string
  home?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Claude Code's login token, read from wherever that platform keeps it.
 *
 * macOS      — the Keychain (`Claude Code-credentials`); first read prompts for authorisation.
 * Windows    — `%USERPROFILE%\.claude\.credentials.json`
 * Linux      — `~/.claude/.credentials.json` (mode 0600)
 *
 * Off macOS there is no Keychain, so Claude Code writes a plain file — with the SAME JSON payload
 * the Keychain entry holds, which is why one parser covers both. `CLAUDE_CONFIG_DIR` moves that
 * file, and it is honoured on exactly the platforms that use the file.
 *
 * Every failure collapses to 「Claude 未登录」on purpose: the raw value must never reach the UI or
 * the logs, since it IS the credential.
 */
export function readClaudeToken(deps: TokenDeps = {}): string {
  const platform = deps.platform ?? process.platform
  let raw: string
  try {
    raw = platform === 'darwin' ? readFromKeychain(deps) : readFromCredentialsFile(deps, platform)
  } catch {
    throw new Error('Claude 未登录')
  }
  let j: { claudeAiOauth?: { accessToken?: string } }
  try {
    j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }
  } catch {
    throw new Error('Claude 未登录')
  }
  const token = j.claudeAiOauth?.accessToken
  if (!token) throw new Error('Claude 未登录')
  return token
}

function readFromKeychain(deps: TokenDeps): string {
  const run = deps.runSecurity ?? (() =>
    execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' }))
  return run()
}

function readFromCredentialsFile(deps: TokenDeps, platform: string): string {
  // Join with the TARGET platform's rules rather than the host's, so the path is right whichever
  // machine computes it — the same reason every other platform seam here takes `platform` explicitly.
  const path = platform === 'win32' ? win32 : posix
  const env = deps.env ?? process.env
  const dir = env.CLAUDE_CONFIG_DIR || path.join(deps.home ?? homedir(), '.claude')
  const read = deps.readCredFile ?? ((p: string) => readFileSync(p, 'utf8'))
  return read(path.join(dir, '.credentials.json'))
}

export async function fetchClaudeUsage(http: HttpClient, deps?: TokenDeps, cred?: string): Promise<StatusbarUsage> {
  // A user-pasted token (设置→插件→凭据) overrides the keychain auto-read.
  const token = cred?.trim() || readClaudeToken(deps)
  const raw = await http.getJson('https://api.anthropic.com/api/oauth/usage', {
    authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
  })
  return normalizeClaude(raw, Date.now())
}
