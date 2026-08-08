import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 下架名单必须对**所有历史版本**立刻生效:壁纸目录钉在 tag 上(每批打新 tag,老版本看不到新壁纸),
// 而「某张图有版权问题」不能等发版。名单单独放在分支上,URL 永不变更。

let sysDir: string
vi.mock('../config/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/paths')>()
  return { ...actual, sysFile: (n: string) => join(sysDir, n) }
})

const { wallpaperBlocklist, __resetWallpaperBlocklistCache } = await import('./wallpaperBlocklist')
const { WALLPAPER_EXCLUDED_IDS } = await import('@shared/wallpaper')

const ok = (blocked: string[]) => (async () => ({ ok: true, status: 200, json: async () => ({ blocked }) })) as never
const fail = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as never
const boom = (async () => { throw new Error('offline') }) as never

beforeEach(() => { sysDir = mkdtempSync(join(tmpdir(), 'wpbl-')); __resetWallpaperBlocklistCache() })

describe('壁纸下架名单', () => {
  it('远程名单与编译进包的基础名单取并集', async () => {
    const ids = await wallpaperBlocklist(ok(['fj77']))
    expect(ids.has('fj77')).toBe(true)
    for (const base of WALLPAPER_EXCLUDED_IDS) expect(ids.has(base)).toBe(true)
  })

  it('★ 下架会粘住:见过一次之后,断网也不会让它重新出现', async () => {
    await wallpaperBlocklist(ok(['fj77']))
    __resetWallpaperBlocklistCache()
    const ids = await wallpaperBlocklist(boom)     // 拉不到了
    expect(ids.has('fj77')).toBe(true)             // 仍然被挡着
  })

  it('★ 远程把 id 删掉也不会复活(粘住是单向的 —— 宁可误挡,不能漏出)', async () => {
    await wallpaperBlocklist(ok(['fj77']))
    __resetWallpaperBlocklistCache()
    const ids = await wallpaperBlocklist(ok([]))   // 远程清空了
    expect(ids.has('fj77')).toBe(true)
  })

  it('从没拉到过时 fail-open:只剩基础名单,画廊不会被清空', async () => {
    const ids = await wallpaperBlocklist(fail)
    expect(ids.size).toBe(WALLPAPER_EXCLUDED_IDS.size)
  })

  it('60s 内不重复打 CDN', async () => {
    const spy = vi.fn(ok(['fj77']))
    await wallpaperBlocklist(spy as never, 1_000)
    await wallpaperBlocklist(spy as never, 30_000)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('畸形响应不炸(blocked 不是数组 / 元素不是字符串)', async () => {
    const weird = (async () => ({ ok: true, status: 200, json: async () => ({ blocked: 'nope' }) })) as never
    await expect(wallpaperBlocklist(weird)).resolves.toBeInstanceOf(Set)
    __resetWallpaperBlocklistCache()
    const mixed = (async () => ({ ok: true, status: 200, json: async () => ({ blocked: [1, null, ' fj9 '] }) })) as never
    const ids = await wallpaperBlocklist(mixed)
    expect(ids.has('fj9')).toBe(true)              // 首尾空白被清掉
  })
})
