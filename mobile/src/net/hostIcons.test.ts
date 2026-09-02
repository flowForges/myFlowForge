import { describe, it, expect } from 'vitest'
import { HOST_ICONS, DEFAULT_HOST_ICON, currentHostIcon, isBuiltinHostIcon } from './hostIcons'

describe('主机图标名单', () => {
  it('★和 hosts.ts 的默认值是同一个 —— 两处各写一个,新建的主机在选择器里会「一个都没选中」', async () => {
    const hosts = await import('./hosts')
    expect(DEFAULT_HOST_ICON).toBe(hosts.DEFAULT_HOST_ICON)
  })

  it('★默认那一枚必须在名单里,否则它永远高亮不了', () => {
    expect(HOST_ICONS.some((o) => o.icon === DEFAULT_HOST_ICON)).toBe(true)
  })

  it('★没有重名的图标 —— 两格长得一模一样,点哪个都对,但选中态会同时亮两个', () => {
    expect(new Set(HOST_ICONS.map((o) => o.icon)).size).toBe(HOST_ICONS.length)
  })

  it('★一行放得下:不超过 6 个(390pt 宽下每格 ~44pt)', () => {
    expect(HOST_ICONS.length).toBeLessThanOrEqual(6)
  })

  it('每一格都有中文/短标签,不留空', () => {
    for (const o of HOST_ICONS) expect(o.label.trim()).not.toBe('')
  })
})

describe('当前选中哪一枚', () => {
  it('★空串(老记录、扫码进来的)算默认那一枚 —— 屏幕上画的就是它', () => {
    expect(currentHostIcon('')).toBe(DEFAULT_HOST_ICON)
    expect(isBuiltinHostIcon('')).toBe(true)
  })

  it('选过的就是选过的', () => {
    expect(currentHostIcon('🐧')).toBe('🐧')
    expect(isBuiltinHostIcon('🐧')).toBe(true)
  })

  it('★名单外的图标原样返回,不硬掰成默认 —— 那可能是更新版 app 写的,掰了就是替人改数据', () => {
    expect(currentHostIcon('🦄')).toBe('🦄')
    expect(isBuiltinHostIcon('🦄')).toBe(false)
  })
})
