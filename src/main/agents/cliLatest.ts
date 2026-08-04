import { compareVersions } from '../update/version'

// "编码代理有新版" 提示(只提示,不代为更新)。各 CLI 的安装版本已由 detect.ts 探测(ProviderInfo.version);
// 这里只补"最新版"这一半 —— 从 npm registry 查各 CLI 对应包的 latest,与安装版本比对,给出是否有新版。
//
// 只覆盖 **npm 发布** 的 CLI(下表)。qoder(官方下载页)、cursor(curl 安装、版本号是日期形态)不在 npm,
// 没有可靠的"最新版"来源,故直接不查、不提示(而非瞎猜一个包名报错)。包名均已对 registry.npmjs.org 核实。
export const CLI_NPM_PACKAGE: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
  qwen: '@qwen-code/qwen-code',
  copilot: '@github/copilot',
  opencode: 'opencode-ai',
  pi: '@earendil-works/pi-coding-agent',
  kimi: '@moonshot-ai/kimi-code',
}

export interface CliUpdateInfo {
  id: string
  installed: string
  latest: string
  hasUpdate: boolean
  // The npm package the "最新版" was read from — surfaced so the UI can show `npm i -g <pkg>@latest`.
  npmPackage: string
}

// Pull the first semver core out of a --version line. Handles bare "0.50.0", "GitHub Copilot CLI 1.0.70.",
// "2.1.220 (Claude Code)", a leading "v", etc. Returns null when there's no X.Y.Z at all.
export function parseSemver(raw: string | undefined): string | null {
  if (!raw) return null
  const m = String(raw).match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

// GET registry.npmjs.org/<pkg>/latest → its `version`. The dist-tag endpoint is tiny (no full
// packument), so this is cheap. Returns null on any network/parse/HTTP failure (caller just omits the
// hint — a failed check must never break the settings pane).
export async function fetchLatestVersion(pkg: string, doFetch: FetchLike, timeoutMs = 8000): Promise<string | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const url = `https://registry.npmjs.org/${pkg.replace(/\//g, '%2F')}/latest`
    const res = await doFetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const body = await res.json() as { version?: unknown }
    return typeof body?.version === 'string' ? body.version : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

// In-memory cache of latest versions, keyed by npm package. npm publishes are infrequent and this is a
// courtesy hint, so a 6h TTL avoids hammering the registry every time the settings pane mounts.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const latestCache = new Map<string, { version: string; at: number }>()

// Compare installed vs latest for each provided CLI and return only the ones we could actually check
// (known npm package + parseable installed version + successful latest fetch). `now`/cache make it
// deterministic in tests. Latest fetches run in parallel; cache hits skip the network entirely.
export async function checkCliUpdates(
  installed: { id: string; version?: string }[],
  doFetch: FetchLike,
  now: number,
): Promise<CliUpdateInfo[]> {
  const out = await Promise.all(installed.map(async ({ id, version }): Promise<CliUpdateInfo | null> => {
    const pkg = CLI_NPM_PACKAGE[id]
    const cur = parseSemver(version)
    if (!pkg || !cur) return null
    const cached = latestCache.get(pkg)
    let latest: string | null
    if (cached && now - cached.at < CACHE_TTL_MS) {
      latest = cached.version
    } else {
      latest = await fetchLatestVersion(pkg, doFetch)
      if (latest) latestCache.set(pkg, { version: latest, at: now })
    }
    const latestCore = parseSemver(latest ?? undefined)
    if (!latestCore) return null
    return { id, installed: cur, latest: latestCore, hasUpdate: compareVersions(latestCore, cur) === 1, npmPackage: pkg }
  }))
  return out.filter((x): x is CliUpdateInfo => x !== null)
}

// Test seam: clear the module-level cache so cases don't leak into each other.
export function __clearLatestCacheForTest(): void {
  latestCache.clear()
}
