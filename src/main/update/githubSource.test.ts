import { describe, it, expect } from 'vitest'
import { fetchLatestRelease } from './githubSource'

// The source now fetches the releases LIST (an array), so fake bodies are arrays of releases.
function fakeFetch(ok: boolean, body: unknown, status = ok ? 200 : 404) {
  return async () => ({ ok, status, json: async () => body })
}
const rel = (tag: string, dmgUrl: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag, body: 'notes',
  assets: [{ name: `myFlowForge-${tag.replace(/^v/, '')}.dmg`, browser_download_url: dmgUrl, size: 100 }],
  ...extra,
})

describe('fetchLatestRelease', () => {
  it('parses tag, notes, and the .dmg asset from the list', async () => {
    const RELEASE = {
      tag_name: 'v2.4.0', body: '工作流混合编排\n文件树提速',
      assets: [
        { name: 'myFlowForge-2.4.0-arm64.dmg', browser_download_url: 'https://x/dmg', size: 26000000 },
        { name: 'latest-mac.yml', browser_download_url: 'https://x/yml', size: 300 },
      ],
    }
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, [RELEASE]) })
    expect(info).toEqual({
      version: '2.4.0', notes: '工作流混合编排\n文件树提速',
      dmgUrl: 'https://x/dmg', dmgSize: 26000000, dmgName: 'myFlowForge-2.4.0-arm64.dmg',
    })
  })

  // Bug #2: pick the HIGHEST semver, not GitHub's "latest" flag / list order. Here 1.0.9 is listed
  // first (most recent created_at) but 1.0.10 is the newest version — we must return 1.0.10.
  it('picks the highest semver even when a lower version is listed first', async () => {
    const list = [rel('v1.0.9', 'https://x/9'), rel('v1.0.10', 'https://x/10'), rel('v1.0.8', 'https://x/8')]
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, list) })
    expect(info?.version).toBe('1.0.10')
    expect(info?.dmgUrl).toBe('https://x/10')
  })

  it('ignores drafts and prereleases', async () => {
    const list = [rel('v2.0.0', 'https://x/pre', { prerelease: true }), rel('v1.9.0', 'https://x/draft', { draft: true }), rel('v1.5.0', 'https://x/stable')]
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, list) })
    expect(info?.version).toBe('1.5.0')
  })

  it('returns null when there is no .dmg asset', async () => {
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, [{ tag_name: 'v2.4.0', assets: [] }]) })
    expect(info).toBeNull()
  })
  it('returns null when there are no stable releases', async () => {
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, []) })
    expect(info).toBeNull()
  })

  // Failure semantics (Bug #1): a non-ok response or a thrown fetch must THROW, not resolve null —
  // so the checker can distinguish "GitHub unreachable" from "up to date".
  it('THROWS on a non-ok response (404 / rate limit)', async () => {
    await expect(fetchLatestRelease('o/r', { fetch: fakeFetch(false, {}) })).rejects.toThrow()
  })
  it('THROWS when fetch throws (offline)', async () => {
    await expect(fetchLatestRelease('o/r', { fetch: async () => { throw new Error('offline') } })).rejects.toThrow('offline')
  })

  // With multiple per-arch dmgs attached (x64 listed FIRST), selection must follow the running CPU arch.
  const MULTI = [{
    tag_name: 'v1.0.1', body: 'notes',
    assets: [
      { name: 'myFlowForge-1.0.1.dmg', browser_download_url: 'https://x/x64', size: 165 },
      { name: 'myFlowForge-1.0.1-arm64.dmg', browser_download_url: 'https://x/arm', size: 163 },
    ],
  }]
  it('picks the arm64 dmg for an arm64 machine', async () => {
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, MULTI), arch: 'arm64' })
    expect(info?.dmgUrl).toBe('https://x/arm')
    expect(info?.dmgName).toBe('myFlowForge-1.0.1-arm64.dmg')
  })
  it('picks the x64 dmg for an x64 machine (not the first asset)', async () => {
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, MULTI), arch: 'x64' })
    expect(info?.dmgUrl).toBe('https://x/x64')
    expect(info?.dmgName).toBe('myFlowForge-1.0.1.dmg')
  })
  it('falls back to a universal dmg when no arch-specific build exists', async () => {
    const uni = [{
      tag_name: 'v1.0.1',
      assets: [{ name: 'myFlowForge-1.0.1-universal.dmg', browser_download_url: 'https://x/uni', size: 300 }],
    }]
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, uni), arch: 'arm64' })
    expect(info?.dmgUrl).toBe('https://x/uni')
  })
})
