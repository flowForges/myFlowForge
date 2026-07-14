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
    render(<WallpaperGallery current="" onApply={() => {}} />)
    await waitFor(() => expect(screen.getByText('风景游戏')).toBeTruthy())
    expect(screen.getByText('纯美')).toBeTruthy()
    expect(screen.getByText('【风景游戏】圣剑光辉')).toBeTruthy()
    expect(screen.getByText('【纯美】银发少女')).toBeTruthy()
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
