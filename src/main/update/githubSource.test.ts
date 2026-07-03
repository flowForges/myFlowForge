import { describe, it, expect } from 'vitest'
import { fetchLatestRelease } from './githubSource'

function fakeFetch(ok: boolean, body: unknown) {
  return async () => ({ ok, json: async () => body })
}

const RELEASE = {
  tag_name: 'v2.4.0',
  body: '工作流混合编排\n文件树提速',
  assets: [
    { name: 'myFlowForge-2.4.0-arm64.dmg', browser_download_url: 'https://x/dmg', size: 26000000 },
    { name: 'latest-mac.yml', browser_download_url: 'https://x/yml', size: 300 },
  ],
}

describe('fetchLatestRelease', () => {
  it('parses tag, notes, and the .dmg asset', async () => {
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, RELEASE) })
    expect(info).toEqual({
      version: '2.4.0',
      notes: '工作流混合编排\n文件树提速',
      dmgUrl: 'https://x/dmg',
      dmgSize: 26000000,
      dmgName: 'myFlowForge-2.4.0-arm64.dmg',
    })
  })
  it('returns null when there is no .dmg asset', async () => {
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(true, { tag_name: 'v2.4.0', assets: [] }) })
    expect(info).toBeNull()
  })
  it('returns null on a non-ok response (404 / rate limit)', async () => {
    const info = await fetchLatestRelease('o/r', { fetch: fakeFetch(false, {}) })
    expect(info).toBeNull()
  })
  it('returns null when fetch throws (offline)', async () => {
    const info = await fetchLatestRelease('o/r', { fetch: async () => { throw new Error('offline') } })
    expect(info).toBeNull()
  })
})
