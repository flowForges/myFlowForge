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
  it('lists 5 official providers, none labelled 示例', () => {
    const c = listCatalog()
    expect(c.map(e => e.provider).sort()).toEqual(['claude', 'codex', 'cursor', 'gemini', 'qoder'])
    expect(c.every(e => e.available)).toBe(true)
    expect(c.some(e => /示例/.test(e.name) || /示例/.test(e.description))).toBe(false)
    expect(c.every(e => e.id.startsWith('forge-official-'))).toBe(true)
  })

  it('OFFICIAL_PROVIDERS has the 5 providers', () => {
    expect(OFFICIAL_PROVIDERS.length).toBe(5)
  })

  it('listCatalog 标记已安装项', () => {
    readPlugins.mockReturnValue([{ id: 'forge-official-codex-usage' }])
    const c = listCatalog()
    const codex = c.find(e => e.id === 'forge-official-codex-usage')!
    expect(codex.installed).toBe(true)
    const claude = c.find(e => e.id === 'forge-official-claude-usage')!
    expect(claude.installed).toBe(false)
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
