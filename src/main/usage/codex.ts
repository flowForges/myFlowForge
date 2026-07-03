import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { HttpClient, StatusbarUsage } from './types'
import { normalizeWindow } from './normalize'
import { fetchCodexUsageViaRpc, type RpcDeps } from './codexRpc'

export function normalizeCodex(raw: unknown, nowMs: number): StatusbarUsage {
  const rl = (raw as { rate_limit?: Record<string, unknown> } | null)?.rate_limit ?? {}
  const window5h = normalizeWindow(rl.primary_window ?? rl.primary, nowMs)
  const weekly = normalizeWindow(rl.secondary_window ?? rl.secondary, nowMs)
  return { ...(window5h ? { window5h } : {}), ...(weekly ? { weekly } : {}), label: 'Codex' }
}

interface TokenDeps { readFile?: (p: string) => string; home?: string; codexHome?: string }

export function readCodexToken(deps: TokenDeps = {}): string {
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'))
  const dir = deps.codexHome ?? join(deps.home ?? homedir(), '.codex')
  let raw: string
  try {
    raw = readFile(join(dir, 'auth.json'))
  } catch {
    throw new Error('Codex 未登录')
  }
  let j: { tokens?: { access_token?: string }; access_token?: string }
  try {
    j = JSON.parse(raw) as { tokens?: { access_token?: string }; access_token?: string }
  } catch {
    throw new Error('Codex 未登录')
  }
  const token = j.tokens?.access_token ?? j.access_token
  if (!token) throw new Error('Codex 未登录')
  return token
}

interface CodexRpcDeps { fetchRpc?: (deps?: RpcDeps) => Promise<StatusbarUsage> }

export async function fetchCodexUsage(http: HttpClient, deps?: TokenDeps, cred?: string, rpc?: CodexRpcDeps): Promise<StatusbarUsage> {
  // Prefer the local CLI's own numbers (`codex app-server` JSON-RPC — the same
  // data source the codex statusbar renders) over the reverse-engineered wham
  // backend, whose field names drift. A user-pasted token (设置→插件→凭据)
  // implies the local login is unusable, so it goes straight to HTTP.
  const pasted = cred?.trim()
  if (!pasted) {
    try {
      return await (rpc?.fetchRpc ?? fetchCodexUsageViaRpc)()
    } catch {
      // Fall through to the wham HTTP endpoint below.
    }
  }
  const token = pasted || readCodexToken(deps)
  const raw = await http.getJson('https://chatgpt.com/backend-api/wham/usage', {
    authorization: `Bearer ${token}`,
  })
  return normalizeCodex(raw, Date.now())
}
