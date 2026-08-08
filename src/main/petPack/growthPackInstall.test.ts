import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { growthPackInstall, petPackCatalog, type PetPackFetch } from './petPackService'
import type { GrowthPackItem } from '@shared/petPack'

// 成长宠物必须能从宠物库下载 —— 否则换一台电脑装完包,成长宠物只能靠「选本地文件夹」,而新机器上
// 根本没有那个文件夹。这组用例守的就是这条链路。

const BASE = 'https://cdn.example/gh/pet-packs@v1/growth/tree'
const ITEM: GrowthPackItem = {
  kind: 'growth', id: 'tree', name: '成长树', base: BASE,
  manifest: `${BASE}/pet.json`, thumb: `${BASE}/0.png`,
  stages: [{ from: 0, sheet: '0.png' }, { from: 16000, sheet: '1.png' }],
}
const MANIFEST = {
  kind: 'growth', signal: 'dailyTokens', id: 'tree', name: '成长树',
  atlas: { cols: 6, cellW: 100, cellH: 100 },
  actions: { idle: { row: 0, durations: [200, 200] } },
  stages: [{ from: 0, name: '种子', sheet: '0.png' }, { from: 16000, name: '发芽', sheet: '1.png' }],
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
function fetchOf(overrides: Record<string, unknown> = {}): PetPackFetch {
  return (async (url: string) => {
    if (url in overrides) return overrides[url] as never
    if (url.endsWith('pet.json')) return { ok: true, status: 200, json: async () => MANIFEST, arrayBuffer: async () => PNG, headers: { get: () => 'application/json' } }
    return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => PNG.buffer.slice(0), headers: { get: () => 'image/png' } }
  }) as unknown as PetPackFetch
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gp-')); vi.restoreAllMocks() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('growthPackInstall', () => {
  it('★ 下载 pet.json + 各阶段图,产出带 growth 清单的 CustomPet', async () => {
    const r = await growthPackInstall('pack-tree', ITEM, fetchOf())
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.pet.id).toBe('pack-tree')
    expect(r.pet.name).toBe('成长树')
    expect(r.pet.growth?.stages).toHaveLength(2)
    // sheet 必须被换成落盘后的本地相对路径,而不是留着远程文件名
    expect(r.pet.growth?.stages[0].sheet).not.toBe('0.png')
    expect(r.pet.growth?.stages.map(s => s.from)).toEqual([0, 16000])
    expect(r.pet.growth?.atlas.cols).toBe(6)
  })

  it('★ 远程包不享受任何校验豁免:老的 at 写法照样被拒', async () => {
    const old = { ...MANIFEST, stages: [{ at: 0, sheet: '0.png' }] }
    const r = await growthPackInstall('pack-tree', ITEM, fetchOf({ [`${BASE}/pet.json`]: { ok: true, status: 200, json: async () => old, headers: { get: () => 'application/json' } } }))
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('from')
  })

  it('pet.json 取不到时给出可读错误,不抛', async () => {
    const r = await growthPackInstall('pack-tree', ITEM, fetchOf({ [`${BASE}/pet.json`]: { ok: false, status: 404, json: async () => ({}), headers: { get: () => null } } }))
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('404')
  })

  it('某个阶段图缺失时指名是第几阶段', async () => {
    const r = await growthPackInstall('pack-tree', ITEM, fetchOf({ [`${BASE}/1.png`]: { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => PNG, headers: { get: () => null } } }))
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('阶段 2')
  })
})

describe('petPackCatalog 读 growth 节', () => {
  const cat = (body: unknown): PetPackFetch => (async () => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => PNG, headers: { get: () => 'application/json' } })) as unknown as PetPackFetch

  it('带 growth 的目录被解析出来', async () => {
    const r = await petPackCatalog(cat({ pets: [], growth: [ITEM] }))
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.growth?.map(g => g.id)).toEqual(['tree'])
  })

  it('★ 老目录没有 growth 节时只是没得下,不能让整个宠物库报错', async () => {
    const r = await petPackCatalog(cat({ pets: [] }))
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.growth).toEqual([])
  })

  it('形状不对的成长条目被过滤掉(kind/stages 缺失)', async () => {
    const r = await petPackCatalog(cat({ pets: [], growth: [{ id: 'x', name: 'x' }, { ...ITEM, stages: [] }] }))
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.growth).toEqual([])
  })
})
