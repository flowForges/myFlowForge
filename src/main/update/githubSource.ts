import type { UpdateInfo } from '@shared/types'
import { compareVersions } from './version'

export interface GithubDeps {
  fetch: (url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<any> }>
  // Running CPU arch ('arm64' | 'x64'), used to pick the matching per-arch .dmg when a
  // release ships more than one. Omit to fall back to the first .dmg (single-arch releases).
  arch?: string
  // Transient-failure hardening: a flaky proxy / GitHub blip shouldn't immediately read as 检查失败.
  // Retry a few times with backoff, each attempt bounded by a timeout so a hung proxy can't wedge it.
  attempts?: number       // default 3
  retryDelayMs?: number   // default 500 (× attempt)
  timeoutMs?: number      // default 8000 per attempt
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Fetch the releases list with retry + per-attempt timeout. Throws the last error only after all
// attempts fail (so the caller still sees "check failed"); a single transient blip now self-recovers.
async function fetchReleases(repo: string, deps: GithubDeps): Promise<{ ok: boolean; json: () => Promise<any> }> {
  const attempts = deps.attempts ?? 3
  const timeoutMs = deps.timeoutMs ?? 8000
  const retryDelayMs = deps.retryDelayMs ?? 500
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await deps.fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'myFlowForge' },
        signal: ac.signal,
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`github releases HTTP ${(res as any).status ?? 'error'}`)
      return res
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      if (i < attempts - 1) await sleep(retryDelayMs * (i + 1))
    }
  }
  throw lastErr
}

// Pick the .dmg that matches the machine's arch. Releases may ship an x64 build (no arch
// suffix), an arm64 build (`-arm64`), and/or a universal build (`-universal`). Falling back
// to the first .dmg would hand ~half of users a package for the wrong CPU.
function pickDmg(assets: any[], arch?: string): any | null {
  const dmgs = assets.filter(a => typeof a?.name === 'string' && a.name.endsWith('.dmg'))
  if (dmgs.length === 0) return null
  if (arch) {
    const low = (a: any) => String(a.name).toLowerCase()
    const arm = dmgs.find(a => low(a).includes('arm64'))
    const uni = dmgs.find(a => low(a).includes('universal'))
    const x64 = dmgs.find(a => low(a).includes('x64'))
      ?? dmgs.find(a => !low(a).includes('arm64') && !low(a).includes('universal'))
    const match = arch === 'arm64' ? (arm ?? uni ?? x64) : (x64 ?? uni ?? arm)
    if (match) return match
  }
  return dmgs[0]
}

// Fetch the newest release. We list ALL releases and pick the highest SEMVER ourselves rather than
// trusting GitHub's `/releases/latest` — that endpoint returns whichever release carries the "Latest"
// flag (assigned by created_at / make_latest), which can lag or point at a non-newest tag right after
// a publish. Computing max-semver makes "is there a newer version than mine" deterministic.
//
// Failure semantics (important): this THROWS on a network error or non-2xx (GitHub unreachable — very
// common behind a firewall/without a proxy). It returns null only when GitHub answered fine but there
// is no usable release/dmg. Callers must distinguish these: a throw is "check failed", null is "no
// update" — otherwise an unreachable GitHub gets silently reported to the user as "已是最新".
export async function fetchLatestRelease(repo: string, deps: GithubDeps): Promise<UpdateInfo | null> {
  const res = await fetchReleases(repo, deps)
  const list = await res.json()
  const releases: any[] = Array.isArray(list) ? list : []
  // Only stable, published releases are update candidates.
  const stable = releases.filter(r => r && !r.draft && !r.prerelease && String(r.tag_name ?? '').trim())
  if (stable.length === 0) return null
  // Highest semver wins (not first-in-list / not GitHub's "latest" flag).
  const newest = stable.reduce((best, r) =>
    compareVersions(String(r.tag_name), String(best.tag_name)) === 1 ? r : best)
  const version = String(newest.tag_name ?? '').replace(/^v/i, '')
  if (!version) return null
  const assets: any[] = Array.isArray(newest.assets) ? newest.assets : []
  const dmg = pickDmg(assets, deps.arch)
  if (!dmg) return null
  return {
    version,
    notes: String(newest.body ?? ''),
    dmgUrl: String(dmg.browser_download_url ?? ''),
    dmgSize: Number(dmg.size ?? 0),
    dmgName: String(dmg.name ?? ''),
  }
}
