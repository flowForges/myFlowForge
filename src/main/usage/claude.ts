import { execFileSync } from 'node:child_process'
import type { HttpClient, StatusbarUsage } from './types'
import { normalizeWindow } from './normalize'

export function normalizeClaude(raw: unknown, nowMs: number): StatusbarUsage {
  const o = (raw ?? {}) as Record<string, unknown>
  const window5h = normalizeWindow(o.five_hour, nowMs)
  const weekly = normalizeWindow(o.seven_day ?? o.seven_day_sonnet, nowMs)
  return { ...(window5h ? { window5h } : {}), ...(weekly ? { weekly } : {}), label: 'Claude' }
}

interface TokenDeps { runSecurity?: () => string; platform?: string }

export function readClaudeToken(deps: TokenDeps = {}): string {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin') throw new Error('Claude 仅支持 macOS 钥匙串读取')
  const run = deps.runSecurity ?? (() =>
    execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' }))
  let raw: string
  try {
    raw = run()
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

export async function fetchClaudeUsage(http: HttpClient, deps?: TokenDeps, cred?: string): Promise<StatusbarUsage> {
  // A user-pasted token (设置→插件→凭据) overrides the keychain auto-read.
  const token = cred?.trim() || readClaudeToken(deps)
  const raw = await http.getJson('https://api.anthropic.com/api/oauth/usage', {
    authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
  })
  return normalizeClaude(raw, Date.now())
}
