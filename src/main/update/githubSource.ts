import type { UpdateInfo } from '@shared/types'

export interface GithubDeps {
  fetch: (url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<any> }>
  // Running CPU arch ('arm64' | 'x64'), used to pick the matching per-arch .dmg when a
  // release ships more than one. Omit to fall back to the first .dmg (single-arch releases).
  arch?: string
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

export async function fetchLatestRelease(repo: string, deps: GithubDeps): Promise<UpdateInfo | null> {
  try {
    const res = await deps.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'myFlowForge' },
    })
    if (!res.ok) return null
    const j = await res.json()
    const version = String(j?.tag_name ?? '').replace(/^v/i, '')
    if (!version) return null
    const assets: any[] = Array.isArray(j?.assets) ? j.assets : []
    const dmg = pickDmg(assets, deps.arch)
    if (!dmg) return null
    return {
      version,
      notes: String(j?.body ?? ''),
      dmgUrl: String(dmg.browser_download_url ?? ''),
      dmgSize: Number(dmg.size ?? 0),
      dmgName: String(dmg.name ?? ''),
    }
  } catch {
    return null
  }
}
