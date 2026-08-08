import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { BackgroundPane } from './BackgroundPane'
import type { Appearance } from '@shared/types'
import type { WallpaperItem } from '@shared/wallpaper'

// 壁纸库是**无上限增长**的(目前 251 张,还在加);背景范围/可见度/纵向位置/首页背景这几块是固定行数。
// 图库一旦排在页首,后面所有控件都得翻过整个图库才够得着 —— 用户实测「底部的设置划不到」。
// 这个顺序不是审美,是可达性:钉死「设置在前、图库在后」,以后谁再把 <WallpaperGallery /> 挪回顶上就红。

const wp: WallpaperItem = { id: 'fj01', cat: '风景', name: '【风景】圣剑光辉', url: 'u/fj01', thumb: 't/fj01', desc: 'd' }

beforeEach(() => {
  ;(window as unknown as { forge: Record<string, unknown> }).forge = {
    wallpaperCatalog: vi.fn().mockResolvedValue({ wallpapers: [wp] }),
    wallpaperPreview: vi.fn().mockResolvedValue({ url: 'forge-bg://img/fj01' }),
    wallpaperInstall: vi.fn().mockResolvedValue({ url: 'forge-bg://img/full' }),
    pickBgImage: vi.fn(),
  }
})

// 选中一张壁纸的状态 —— 背景范围/可见度/纵向位置只有 bgImage 非空时才渲染,而这几行正是划不到的重灾区。
const applied: Appearance = { bgImage: 'forge-bg://img/full', bgScope: 'app', bgOpacity: 0.35, bgWallpaperId: 'fj01' } as Appearance

describe('BackgroundPane 版面顺序', () => {
  const renderPane = () => render(<BackgroundPane appearance={applied} onChange={() => {}} />)
  // 取「设置块」与「壁纸库」两个锚点在 DOM 里的先后。compareDocumentPosition 比对 innerHTML 索引更稳。
  const order = (container: HTMLElement) => {
    const groups = [...container.querySelectorAll('.set-group')]
    const settings = groups.find(g => g.querySelector('h4')?.textContent === '背景图')!
    const gallery = groups.find(g => g.querySelector('h4')?.textContent === '内置壁纸')!
    expect(settings).toBeTruthy()
    expect(gallery).toBeTruthy()
    return settings.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING ? 'gallery-after' : 'gallery-before'
  }

  it('★ 壁纸库排在背景设置之后 —— 否则设置项被 251 张图挤到滚不到的地方', async () => {
    const { container } = renderPane()
    await waitFor(() => expect(container.querySelector('.wp-tile')).toBeTruthy())
    expect(order(container)).toBe('gallery-after')
  })

  it('划不到的那几行(背景范围 / 可见度 / 纵向位置)全在壁纸库之前', async () => {
    const { container } = renderPane()
    await waitFor(() => expect(container.querySelector('.wp-tile')).toBeTruthy())
    const gallery = [...container.querySelectorAll('.set-group')].find(g => g.querySelector('h4')?.textContent === '内置壁纸')!
    for (const label of ['背景范围', '背景可见度', '纵向位置', '首页背景图']) {
      const row = [...container.querySelectorAll('.set-row .t')].find(e => e.textContent === label)
      expect(row, `缺少设置行:${label}`).toBeTruthy()
      expect(row!.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING, `${label} 落到了壁纸库后面`).toBeTruthy()
    }
  })
})
