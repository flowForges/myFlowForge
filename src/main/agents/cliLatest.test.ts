import { describe, it, expect, beforeEach } from 'vitest'
import { parseSemver, fetchLatestVersion, checkCliUpdates, __clearLatestCacheForTest } from './cliLatest'

beforeEach(() => __clearLatestCacheForTest())

const okJson = (version: unknown) => async () =>
  ({ ok: true, json: async () => ({ version }) } as unknown as Response)

describe('parseSemver', () => {
  it('extracts X.Y.Z from varied --version output', () => {
    expect(parseSemver('0.50.0')).toBe('0.50.0')
    expect(parseSemver('GitHub Copilot CLI 1.0.70.')).toBe('1.0.70')
    expect(parseSemver('2.1.220 (Claude Code)')).toBe('2.1.220')
    expect(parseSemver('v1.2.3')).toBe('1.2.3')
  })
  it('returns null when there is no semver', () => {
    expect(parseSemver(undefined)).toBe(null)
    expect(parseSemver('🚀 启动 Claude...')).toBe(null)
  })
  it('a date-form version still parses (harmless — such CLIs lack an npm package and are skipped)', () => {
    expect(parseSemver('2026.06.15-18-00-12')).toBe('2026.06.15') // cursor-agent
  })
})

describe('fetchLatestVersion', () => {
  it('returns the version on ok, null on !ok', async () => {
    expect(await fetchLatestVersion('@google/gemini-cli', okJson('0.53.1'))).toBe('0.53.1')
    expect(await fetchLatestVersion('x', async () => ({ ok: false } as Response))).toBe(null)
  })
  it('url-encodes the scoped package slash', async () => {
    let seen = ''
    await fetchLatestVersion('@openai/codex', async (url) => { seen = url; return { ok: true, json: async () => ({ version: '1.0.0' }) } as unknown as Response })
    expect(seen).toContain('@openai%2Fcodex/latest')
  })
  it('never throws — a network error resolves to null', async () => {
    expect(await fetchLatestVersion('x', async () => { throw new Error('offline') })).toBe(null)
  })
})

describe('checkCliUpdates', () => {
  it('flags an update when latest > installed', async () => {
    const res = await checkCliUpdates([{ id: 'gemini', version: '0.50.0' }], okJson('0.53.1'), 1000)
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ id: 'gemini', installed: '0.50.0', latest: '0.53.1', hasUpdate: true, npmPackage: '@google/gemini-cli' })
  })
  it('does not flag when installed equals latest', async () => {
    const res = await checkCliUpdates([{ id: 'gemini', version: '0.53.1' }], okJson('0.53.1'), 1)
    expect(res[0].hasUpdate).toBe(false)
  })
  it('skips CLIs with no known npm package (qoder/cursor)', async () => {
    const res = await checkCliUpdates([{ id: 'qoder', version: '1.0.29' }, { id: 'cursor', version: '2026.06.15' }], okJson('9.9.9'), 1)
    expect(res).toEqual([])
  })
  it('skips CLIs whose installed version is unparseable', async () => {
    const res = await checkCliUpdates([{ id: 'codex', version: '🚀 启动 Codex...' }], okJson('1.0.0'), 1)
    expect(res).toEqual([])
  })
  it('omits a CLI when the latest fetch fails', async () => {
    const res = await checkCliUpdates([{ id: 'gemini', version: '0.50.0' }], async () => ({ ok: false } as Response), 1)
    expect(res).toEqual([])
  })
})
