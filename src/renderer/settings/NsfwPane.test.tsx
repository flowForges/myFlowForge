import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { NsfwPane, __resetNsfwGalleryMemo } from './NsfwPane'
import type { Pet } from '@shared/types'
import type { NsfwBg } from '@shared/nsfw'

const bg: NsfwBg = { id: 'b1', name: '暗夜', desc: 'd' }
const pet = {} as unknown as Pet

function mockForge(over: Record<string, unknown> = {}) {
  ;(window as unknown as { forge: Record<string, unknown> }).forge = {
    // design E: gallery returns catalog + already-cached previews; missing ones arrive via onNsfwPreview.
    nsfwGallery: vi.fn().mockResolvedValue({ pets: [], backgrounds: [bg], previews: {} }),
    onNsfwPreview: vi.fn(() => () => {}),
    nsfwInstallBg: vi.fn().mockResolvedValue({ url: 'forge-bg://full/b1' }),
    nsfwBgExists: vi.fn().mockResolvedValue({ exists: true }),
    ...over,
  }
}

beforeEach(() => { __resetNsfwGalleryMemo(); mockForge() })

const noop = () => {}
const renderPane = (onChangeAppearance: (p: unknown) => void, nsfwInstalled: Record<string, string> = {}) =>
  render(<NsfwPane pet={pet} nsfwInstalled={nsfwInstalled} onChangePet={noop} onChangeAppearance={onChangeAppearance as never} onSetInstalled={noop} onDisable={noop} />)

// An NSFW background is not a built-in wallpaper. Applying one must clear appearance.bgWallpaperId,
// otherwise the wallpaper gallery keeps the previously-selected built-in tile highlighted even though
// the real background is now the NSFW image (the "回到外观旧主题仍选中" bug).
describe('NsfwPane gallery (design E) + progressive previews + 限流', () => {
  it('renders gallery items; a streamed thumbnail fills in via onNsfwPreview; 刷新 cools down after a fetch', async () => {
    let previewCb: ((e: { key: string; url: string }) => void) | null = null
    const nsfwGallery = vi.fn().mockResolvedValue({ pets: [], backgrounds: [bg], previews: {} })
    const onNsfwPreview = vi.fn((cb: (e: { key: string; url: string }) => void) => { previewCb = cb; return () => {} })
    mockForge({ nsfwGallery, onNsfwPreview })
    renderPane(vi.fn())
    await screen.findByText('暗夜')
    await waitFor(() => expect(nsfwGallery).toHaveBeenCalledTimes(1))
    expect(document.querySelector('.nsfw-thumb img')).toBeNull()          // no thumbnail yet (still streaming)
    act(() => previewCb?.({ key: 'bg:b1', url: 'forge-bg://img/b1' }))     // a streamed thumbnail arrives
    await waitFor(() => expect(document.querySelector('.nsfw-thumb img')).not.toBeNull())
    const refresh = screen.getByRole('button', { name: /刷新/ }) as HTMLButtonElement
    await waitFor(() => expect(refresh.disabled).toBe(true))
    expect(refresh.textContent).toMatch(/刷新 \(\d+s\)/)
  })

  it('rate-limited (429) surfaces a "刷新太频繁" message instead of wiping the gallery', async () => {
    mockForge({ nsfwGallery: vi.fn().mockResolvedValue({ error: '刷新太频繁,请稍后再试', rateLimited: true }) })
    renderPane(vi.fn())
    await screen.findByText('刷新太频繁,请稍后再试')
  })
})

describe('NsfwPane applying a background clears the wallpaper-gallery highlight', () => {
  it('first install: writes bgImage/bgScope AND bgWallpaperId:""', async () => {
    const onChangeAppearance = vi.fn()
    renderPane(onChangeAppearance)
    fireEvent.click(await screen.findByText('安装'))
    await waitFor(() => expect(onChangeAppearance).toHaveBeenCalled())
    expect(onChangeAppearance).toHaveBeenCalledWith(
      expect.objectContaining({ bgImage: 'forge-bg://full/b1', bgScope: 'app', bgWallpaperId: '' }),
    )
  })

  it('already-installed (stored file exists): re-apply still writes bgWallpaperId:""', async () => {
    const onChangeAppearance = vi.fn()
    renderPane(onChangeAppearance, { 'bg:b1': 'forge-bg://stored/b1' })
    fireEvent.click(await screen.findByText('设置'))
    await waitFor(() => expect(onChangeAppearance).toHaveBeenCalled())
    expect(onChangeAppearance).toHaveBeenCalledWith(
      expect.objectContaining({ bgImage: 'forge-bg://stored/b1', bgScope: 'app', bgWallpaperId: '' }),
    )
  })
})
