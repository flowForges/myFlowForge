import type { UpdateInfo } from '@shared/types'

export interface GithubDeps {
  fetch: (url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<any> }>
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
    const dmg = assets.find(a => typeof a?.name === 'string' && a.name.endsWith('.dmg'))
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
