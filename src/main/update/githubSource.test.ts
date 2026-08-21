import { describe, it, expect } from 'vitest'
import { fetchLatestRelease } from './githubSource'

// The source now fetches the releases LIST (an array), so fake bodies are arrays of releases.
function fakeFetch(ok: boolean, body: unknown, status = ok ? 200 : 404) {
  return async () => ({ ok, status, json: async () => body })
}
const rel = (tag: string, url: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag, body: 'notes',
  assets: [{ name: `myFlowForge-${tag.replace(/^v/, '')}.dmg`, browser_download_url: url, size: 100 }],
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
      assetUrl: 'https://x/dmg', assetSize: 26000000, assetName: 'myFlowForge-2.4.0-arm64.dmg',
    })
  })

  // Bug #2: pick the HIGHEST semver, not GitHub's "latest" flag / list order. Here 1.0.9 is listed
  // first (most recent created_at) but 1.0.10 is the newest version — we must return 1.0.10.
  it('picks the highest semver even when a lower version is listed first', async () => {
    const list = [rel('v1.0.9', 'https://x/9'), rel('v1.0.10', 'https://x/10'), rel('v1.0.8', 'https://x/8')]
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, list) })
    expect(info?.version).toBe('1.0.10')
    expect(info?.assetUrl).toBe('https://x/10')
  })

  it('ignores drafts and prereleases', async () => {
    const list = [rel('v2.0.0', 'https://x/pre', { prerelease: true }), rel('v1.9.0', 'https://x/draft', { draft: true }), rel('v1.5.0', 'https://x/stable')]
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, list) })
    expect(info?.version).toBe('1.5.0')
  })

  it('returns null when there is no installable asset', async () => {
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
    await expect(fetchLatestRelease('o/r', { fetch: fakeFetch(false, {}), attempts: 1 })).rejects.toThrow()
  })
  it('THROWS when fetch throws (offline)', async () => {
    await expect(fetchLatestRelease('o/r', { fetch: async () => { throw new Error('offline') }, attempts: 1 })).rejects.toThrow('offline')
  })
  it('RETRIES a transient failure and succeeds (does not falsely report 检查失败)', async () => {
    let calls = 0
    const rel = { tag_name: 'v2.4.0', body: 'n', assets: [{ name: 'myFlowForge-2.4.0.dmg', browser_download_url: 'u', size: 1 }] }
    const flaky = async () => {
      calls++
      if (calls < 3) throw new Error('transient')
      return { ok: true, json: async () => [rel] }
    }
    const info = await fetchLatestRelease('o/r', { fetch: flaky as any, retryDelayMs: 0 })
    expect(calls).toBe(3)
    expect(info?.version).toBe('2.4.0')
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
    expect(info?.assetUrl).toBe('https://x/arm')
    expect(info?.assetName).toBe('myFlowForge-1.0.1-arm64.dmg')
  })
  it('picks the x64 dmg for an x64 machine (not the first asset)', async () => {
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, MULTI), arch: 'x64' })
    expect(info?.assetUrl).toBe('https://x/x64')
    expect(info?.assetName).toBe('myFlowForge-1.0.1.dmg')
  })
  it('falls back to a universal dmg when no arch-specific build exists', async () => {
    const uni = [{
      tag_name: 'v1.0.1',
      assets: [{ name: 'myFlowForge-1.0.1-universal.dmg', browser_download_url: 'https://x/uni', size: 300 }],
    }]
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, uni), arch: 'arm64' })
    expect(info?.assetUrl).toBe('https://x/uni')
  })

  // ── Windows ────────────────────────────────────────────────────────────────────────────────
  // A release carries BOTH platforms' artifacts. Picking by extension is not optional: handing a
  // Windows user a .dmg (or a Mac user a .exe) is a download that can never install.
  const BOTH = [{
    tag_name: 'v1.2.0', body: 'notes',
    assets: [
      { name: 'myFlowForge-1.2.0-arm64.dmg', browser_download_url: 'https://x/mac-arm', size: 163 },
      { name: 'myFlowForge-1.2.0.dmg', browser_download_url: 'https://x/mac-x64', size: 165 },
      { name: 'myFlowForge-1.2.0-x64-setup.exe', browser_download_url: 'https://x/win-x64', size: 90 },
      { name: 'myFlowForge-1.2.0-arm64-setup.exe', browser_download_url: 'https://x/win-arm', size: 88 },
      { name: 'myFlowForge-1.2.0-x64-setup.exe.blockmap', browser_download_url: 'https://x/blockmap', size: 2 },
      { name: 'latest.yml', browser_download_url: 'https://x/yml', size: 300 },
    ],
  }]

  it('picks the x64 Windows installer on an x64 PC', async () => {
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, BOTH), platform: 'win32', arch: 'x64' })
    expect(info?.assetUrl).toBe('https://x/win-x64')
  })
  it('picks the arm64 Windows installer on an arm64 PC', async () => {
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, BOTH), platform: 'win32', arch: 'arm64' })
    expect(info?.assetUrl).toBe('https://x/win-arm')
  })
  it('never hands a Windows machine a .dmg', async () => {
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, BOTH), platform: 'win32', arch: 'x64' })
    expect(info?.assetName).toMatch(/\.exe$/)
  })
  it('never hands a Mac an .exe', async () => {
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, BOTH), platform: 'darwin', arch: 'arm64' })
    expect(info?.assetName).toBe('myFlowForge-1.2.0-arm64.dmg')
  })
  it('ignores the .blockmap sidecar electron-builder ships next to the installer', async () => {
    const only = [{ tag_name: 'v1.2.0', assets: [
      { name: 'myFlowForge-1.2.0-x64-setup.exe.blockmap', browser_download_url: 'https://x/bm', size: 2 },
      { name: 'myFlowForge-1.2.0-x64-setup.exe', browser_download_url: 'https://x/exe', size: 90 },
    ] }]
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, only), platform: 'win32', arch: 'x64' })
    expect(info?.assetUrl).toBe('https://x/exe')
  })
  it('returns null on Windows when the release only shipped macOS artifacts', async () => {
    const macOnly = [{ tag_name: 'v1.2.0', assets: [{ name: 'a-1.2.0.dmg', browser_download_url: 'https://x/d', size: 1 }] }]
    expect(await fetchLatestRelease('o/r', { fetch: fakeFetch(true, macOnly), platform: 'win32', arch: 'x64' })).toBeNull()
  })
  it('falls back to a lone unsuffixed installer when no arch matches', async () => {
    const one = [{ tag_name: 'v1.2.0', assets: [{ name: 'myFlowForge Setup 1.2.0.exe', browser_download_url: 'https://x/setup', size: 90 }] }]
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, one), platform: 'win32', arch: 'arm64' })
    expect(info?.assetUrl).toBe('https://x/setup')
  })
})
