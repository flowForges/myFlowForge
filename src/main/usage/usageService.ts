import type { InstalledPlugin } from '../plugins/pluginSchema'
import type { PluginRunResult } from '../plugins/pluginHost'
import type { HttpClient, StatusbarUsage } from './types'
import { makeHttp } from './http'
import { readSettings } from '../config/store'
import { fetchCodexUsage } from './codex'
import { fetchClaudeUsage } from './claude'
import { fetchGeminiUsage } from './gemini'
import { fetchCursorUsage } from './cursor'
import { fetchQoderUsage } from './qoder'

export function isNativeUsage(p: InstalledPlugin): boolean {
  return p.type === 'statusbar-usage' && p.native === true
}

type Fetcher = (http: HttpClient, cred?: string) => Promise<StatusbarUsage>

export const DEFAULT_FETCHERS: Record<string, Fetcher> = {
  codex: (http, cred) => fetchCodexUsage(http, undefined, cred),
  claude: (http, cred) => fetchClaudeUsage(http, undefined, cred),
  gemini: (http, cred) => fetchGeminiUsage(http, undefined, cred),
  // Auto-read via sqlite is stubbed; a user-pasted cookie (cred) bypasses it and works directly.
  cursor: (http, cred) => fetchCursorUsage(http, { runSqlite: () => { throw new Error('需要 sqlite 支持') } }, cred),
  qoder: (_http, cred) => fetchQoderUsage(cred),
}

// Strip token-shaped substrings from any error before it reaches the UI/logs.
function sanitize(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg
    .replace(/Bearer\S*/gi, '***')
    .replace(/sk-[A-Za-z0-9_-]+/g, '***')
    .replace(/[A-Za-z0-9_-]{40,}/g, '***')
}

// Turn raw HTTP/network errors into actionable Chinese hints (after sanitizing tokens).
function friendly(msg: string): string {
  if (/HTTP 40[13]/.test(msg)) return '登录已过期或无权限，请在对应工具重新登录后刷新'
  if (/HTTP 429/.test(msg)) return '请求过于频繁（429），稍后再试'
  if (/HTTP 5\d\d/.test(msg)) return `服务暂时不可用（${msg.match(/HTTP 5\d\d/)?.[0] ?? '5xx'}），稍后再试`
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|aborted|timeout|UND_ERR|network/i.test(msg)) {
    return '网络无法连接：若需代理请在 设置→终端代理 填写后重试'
  }
  return msg
}

export async function runUsagePlugin(
  p: InstalledPlugin,
  deps?: { http?: HttpClient; fetchers?: Record<string, Fetcher> },
): Promise<PluginRunResult> {
  const fetchers = deps?.fetchers ?? DEFAULT_FETCHERS
  // Build the default client with the app's configured proxy so calls survive proxy-only networks.
  const http = deps?.http ?? makeHttp(fetch, 10_000, readSettings().termProxy)
  const fetcher = p.provider ? fetchers[p.provider] : undefined
  if (!fetcher) return { ok: false, error: `不支持的 provider: ${p.provider ?? '?'}` }
  // A user-pasted credential overrides the provider's auto-read source.
  const cred = p.provider ? readSettings().pluginCreds?.[p.provider] : undefined
  try {
    const data = await fetcher(http, cred)
    return { ok: true, type: 'statusbar-usage', data }
  } catch (e) {
    return { ok: false, error: friendly(sanitize(e)) }
  }
}

type RunFn = (p: InstalledPlugin) => Promise<PluginRunResult>

export function makeRun(deps: { runUsage?: RunFn; runHost: RunFn }): RunFn {
  const runUsage = deps.runUsage ?? ((p) => runUsagePlugin(p))
  return (p) => (isNativeUsage(p) ? runUsage(p) : deps.runHost(p))
}
