import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app' } }))

// mock pluginStore 以聚焦 catalog 逻辑
const readPlugins = vi.fn()
const writeJsonMock = vi.fn()
vi.mock('./pluginStore', () => ({
  readPlugins: () => readPlugins(),
}))
vi.mock('../config/store', () => ({
  readJson: vi.fn(() => ({ plugins: [] })),
  writeJson: (...args: unknown[]) => writeJsonMock(...args),
}))
vi.mock('../config/paths', () => ({
  pluginsFile: () => '/tmp/test-plugins.json',
}))

import { listCatalog, installOfficial, OFFICIAL_PROVIDERS } from './officialCatalog'
import { PET_MARKET_PLUGIN_ID } from '@shared/codexPetMarket'

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'forge-official-catalog-'))
  readPlugins.mockReturnValue([])
  writeJsonMock.mockReturnValue(undefined)
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('officialCatalog', () => {
  it('lists 5 official providers + the pet-market feature, none labelled 示例', async () => {
    const c = await listCatalog()
    expect(c.filter(e => e.provider).map(e => e.provider).sort()).toEqual(['claude', 'codex', 'cursor', 'gemini', 'qoder'])
    expect(c.some(e => e.id === PET_MARKET_PLUGIN_ID && e.type === 'pet-market')).toBe(true)
    expect(c.every(e => e.available)).toBe(true)
    expect(c.some(e => /示例/.test(e.name) || /示例/.test(e.description))).toBe(false)
    expect(c.every(e => e.id.startsWith('forge-official-'))).toBe(true)
  })

  it('OFFICIAL_PROVIDERS has the 5 providers', () => {
    expect(OFFICIAL_PROVIDERS.length).toBe(5)
  })

  it('listCatalog 标记已安装项', async () => {
    readPlugins.mockReturnValue([{ id: 'forge-official-codex-usage' }])
    const c = await listCatalog()
    const codex = c.find(e => e.id === 'forge-official-codex-usage')!
    expect(codex.installed).toBe(true)
    const claude = c.find(e => e.id === 'forge-official-claude-usage')!
    expect(claude.installed).toBe(false)
  })

  it('远程下架名单:隐藏未安装的被下架项,保留已安装的', async () => {
    const { __resetPluginBlocklistCache } = await import('./blocklist')
    __resetPluginBlocklistCache()
    // codex 已安装、qoder 未安装;下架名单同时列出两者。
    readPlugins.mockReturnValue([{ id: 'forge-official-codex-usage' }])
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ blocked: ['forge-official-codex-usage', 'forge-official-qoder-usage'] }),
    }))
    const c = await listCatalog(fetchImpl)
    // 已安装的 codex 仍在;未安装且被下架的 qoder 被隐藏。
    expect(c.some(e => e.id === 'forge-official-codex-usage')).toBe(true)
    expect(c.some(e => e.id === 'forge-official-qoder-usage')).toBe(false)
    // 未被下架的照常显示。
    expect(c.some(e => e.id === 'forge-official-claude-usage')).toBe(true)
  })

  it('远程下架名单:拉取失败时 fail-open,照常显示全部', async () => {
    const { __resetPluginBlocklistCache } = await import('./blocklist')
    __resetPluginBlocklistCache()
    const fetchImpl = vi.fn(async () => { throw new Error('offline') })
    const c = await listCatalog(fetchImpl)
    expect(c.some(e => e.id === 'forge-official-qoder-usage')).toBe(true)
  })

  it('installOfficial 写入带 native:true 的记录', () => {
    const r = installOfficial('forge-official-codex-usage')
    expect(r.ok).toBe(true)
    expect(writeJsonMock).toHaveBeenCalledOnce()
    const written = writeJsonMock.mock.calls[0][1] as { plugins: unknown[] }
    const plugin = written.plugins.find((p: any) => p.id === 'forge-official-codex-usage') as any
    expect(plugin).toBeDefined()
    expect(plugin.native).toBe(true)
    expect(plugin.entry).toBe('native')
    expect(plugin.dir).toBe('')
    expect(plugin.provider).toBe('codex')
  })

  it('installOfficial 未知 id 返回错误', () => {
    const r = installOfficial('nope')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/未知/)
  })
})
