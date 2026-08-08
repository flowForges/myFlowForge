import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WallpaperGallery } from './WallpaperGallery'
import type { WallpaperItem } from '@shared/wallpaper'

const fj: WallpaperItem = { id: 'fj01', cat: '风景游戏', name: '【风景游戏】圣剑光辉', url: 'u/fj01', thumb: 't/fj01', desc: 'd1' }
const cm: WallpaperItem = { id: 'cm01', cat: '纯美', name: '【纯美】银发少女', url: 'u/cm01', thumb: 't/cm01', desc: 'd2' }

function mockForge(over: Partial<Record<string, unknown>> = {}) {
  ;(window as unknown as { forge: Record<string, unknown> }).forge = {
    wallpaperCatalog: vi.fn().mockResolvedValue({ wallpapers: [fj, cm] }),
    wallpaperPreview: vi.fn().mockImplementation((w: WallpaperItem) => Promise.resolve({ url: 'forge-bg://img/' + w.id })),
    wallpaperInstall: vi.fn().mockResolvedValue({ url: 'forge-bg://img/full' }),
    ...over,
  }
}

beforeEach(() => mockForge())

describe('WallpaperGallery', () => {
  it('lists wallpapers grouped by category', async () => {
    const { container } = render(<WallpaperGallery current="" onApply={() => {}} />)
    // 分类名现在同时出现在 chip 和分组标题里,所以按 .wp-group-h 取,别用 getByText(会撞上)。
    await waitFor(() => expect(container.querySelectorAll('.wp-group-h').length).toBe(2))
    expect([...container.querySelectorAll('.wp-group-h')].map(e => e.textContent)).toEqual(['风景游戏', '纯美'])
    expect(screen.getByText('【风景游戏】圣剑光辉')).toBeTruthy()
    expect(screen.getByText('【纯美】银发少女')).toBeTruthy()
  })

  // 壁纸到两三百张之后,把所有分类堆着滚太长 —— chips 让「我要看风景」一步到位。
  describe('分类页签', () => {
    const chip = (c: HTMLElement, name: string) =>
      [...c.querySelectorAll('.wp-cat')].find(e => e.textContent?.startsWith(name)) as HTMLElement

    it('每个分类一个 chip,带数量;另有「全部」', async () => {
      const { container } = render(<WallpaperGallery current="" onApply={() => {}} />)
      await waitFor(() => expect(container.querySelectorAll('.wp-cat').length).toBe(3))
      expect(chip(container, '全部').textContent).toContain('2')
      expect(chip(container, '风景游戏').textContent).toContain('1')
    })

    it('★ 选一类后只剩那一类,别的不再渲染', async () => {
      const { container } = render(<WallpaperGallery current="" onApply={() => {}} />)
      await waitFor(() => expect(container.querySelectorAll('.wp-cat').length).toBe(3))
      fireEvent.click(chip(container, '风景游戏'))
      expect(screen.getByText('【风景游戏】圣剑光辉')).toBeTruthy()
      expect(screen.queryByText('【纯美】银发少女')).toBeNull()
    })

    it('选中一类时不再顶一个同名分组标题(chip 已经写着)', async () => {
      const { container } = render(<WallpaperGallery current="" onApply={() => {}} />)
      await waitFor(() => expect(container.querySelectorAll('.wp-cat').length).toBe(3))
      fireEvent.click(chip(container, '纯美'))
      expect(container.querySelectorAll('.wp-group-h').length).toBe(0)
    })

    it('点「全部」回到分组视图', async () => {
      const { container } = render(<WallpaperGallery current="" onApply={() => {}} />)
      await waitFor(() => expect(container.querySelectorAll('.wp-cat').length).toBe(3))
      fireEvent.click(chip(container, '纯美'))
      fireEvent.click(chip(container, '全部'))
      expect(container.querySelectorAll('.wp-group-h').length).toBe(2)
      expect(screen.getByText('【风景游戏】圣剑光辉')).toBeTruthy()
    })
  })

  it('clicking a tile installs and reports the forge-bg url + id', async () => {
    const onApply = vi.fn()
    render(<WallpaperGallery current="" onApply={onApply} />)
    const tile = await screen.findByText('【风景游戏】圣剑光辉')
    fireEvent.click(tile)
    await waitFor(() => expect(onApply).toHaveBeenCalledWith('forge-bg://img/full', 'fj01'))
    expect((window as unknown as { forge: { wallpaperInstall: ReturnType<typeof vi.fn> } }).forge.wallpaperInstall).toHaveBeenCalledWith(fj)
  })

  it('highlights the currently applied wallpaper', async () => {
    const { container } = render(<WallpaperGallery current="cm01" onApply={() => {}} />)
    await screen.findByText('【纯美】银发少女')
    const on = container.querySelectorAll('.wp-tile.on')
    expect(on.length).toBe(1)
    expect(on[0].textContent).toContain('银发少女')
  })

  it('shows an error when the catalog fails', async () => {
    mockForge({ wallpaperCatalog: vi.fn().mockResolvedValue({ error: '无法连接壁纸服务' }) })
    render(<WallpaperGallery current="" onApply={() => {}} />)
    await waitFor(() => expect(screen.getByText('无法连接壁纸服务')).toBeTruthy())
  })
})
