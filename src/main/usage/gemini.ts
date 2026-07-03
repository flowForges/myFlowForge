import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { HttpClient, StatusbarUsage } from './types'
import { normalizeWindow } from './normalize'

export function normalizeGemini(raw: unknown, nowMs: number): StatusbarUsage {
  const buckets = (raw as { quotaBuckets?: unknown[] } | null)?.quotaBuckets ?? []
  const first = Array.isArray(buckets) ? buckets[0] : undefined
  const window5h = normalizeWindow(first, nowMs)
  return { ...(window5h ? { window5h } : {}), label: 'Gemini' }
}

interface TokenDeps { readFile?: (p: string) => string; home?: string }

export function readGeminiToken(deps: TokenDeps = {}): string {
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'))
  let raw: string
  try {
    raw = readFile(join(deps.home ?? homedir(), '.gemini', 'oauth_creds.json'))
  } catch {
    throw new Error('Gemini 未登录')
  }
  let j: { access_token?: string }
  try {
    j = JSON.parse(raw) as { access_token?: string }
  } catch {
    throw new Error('Gemini 未登录')
  }
  if (!j.access_token) throw new Error('Gemini 未登录')
  return j.access_token
}

export async function fetchGeminiUsage(http: HttpClient, deps?: TokenDeps, cred?: string): Promise<StatusbarUsage> {
  // A user-pasted token (设置→插件→凭据) overrides the ~/.gemini/oauth_creds.json auto-read.
  const token = cred?.trim() || readGeminiToken(deps)
  const raw = await http.postJson(
    'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
    { authorization: `Bearer ${token}` },
    {},
  )
  return normalizeGemini(raw, Date.now())
}
