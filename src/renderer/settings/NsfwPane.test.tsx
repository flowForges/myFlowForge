import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NsfwPane } from './NsfwPane'
import type { Pet } from '@shared/types'
import type { NsfwBg } from '@shared/nsfw'

const bg: NsfwBg = { id: 'b1', name: '暗夜', desc: 'd' }
const pet = {} as unknown as Pet

function mockForge(over: Record<string, unknown> = {}) {
  ;(window as unknown as { forge: Record<string, unknown> }).forge = {
    nsfwCatalog: vi.fn().mockResolvedValue({ pets: [], backgrounds: [bg] }),
    nsfwPreview: vi.fn().mockResolvedValue({ url: 'forge-bg://p/b1' }),
    nsfwInstallBg: vi.fn().mockResolvedValue({ url: 'forge-bg://full/b1' }),
    nsfwBgExists: vi.fn().mockResolvedValue({ exists: true }),
    ...over,
  }
}

beforeEach(() => mockForge())

const noop = () => {}
const renderPane = (onChangeAppearance: (p: unknown) => void, nsfwInstalled: Record<string, string> = {}) =>
  render(<NsfwPane pet={pet} nsfwInstalled={nsfwInstalled} onChangePet={noop} onChangeAppearance={onChangeAppearance as never} onSetInstalled={noop} onDisable={noop} />)

// An NSFW background is not a built-in wallpaper. Applying one must clear appearance.bgWallpaperId,
// otherwise the wallpaper gallery keeps the previously-selected built-in tile highlighted even though
// the real background is now the NSFW image (the "回到外观旧主题仍选中" bug).
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
