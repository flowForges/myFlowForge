import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PetMarketPane } from './PetMarketPane'
import type { Pet } from '@shared/types'

const page = {
  page: 1, pageSize: 30, total: 60, totalPages: 2,
  pets: [{ id: 'yuki', displayName: 'Yuki', previewUrl: 'p1', spritesheetUrl: 's1', petJsonUrl: 'j1', ownerName: 'kira' }],
}

const pet = { customPets: [] } as unknown as Pet

beforeEach(() => {
  ;(window as unknown as { forge: unknown }).forge = {
    codexMarketCatalog: vi.fn(async () => page),
    codexMarketPreview: vi.fn(async () => ({ url: 'forge-bg://x' })),
    codexMarketInstall: vi.fn(async () => ({ ok: true, pet: { id: 'codexmkt-yuki', name: 'Yuki', atlas: { path: 'codexmkt-yuki/spritesheet.webp', version: 2 } } })),
  }
})

describe('PetMarketPane', () => {
  it('lists pets with author + pagination, and installs (selects as active) on click', async () => {
    const onChange = vi.fn()
    render(<PetMarketPane pet={pet} onChange={onChange} />)
    await waitFor(() => expect(screen.getByText('Yuki')).toBeTruthy())
    expect(screen.getByText('by kira')).toBeTruthy()
    expect(screen.getByText('1 / 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const arg = onChange.mock.calls[0][0]
    expect(arg.skin).toBe('custom')
    expect(arg.activeCustomPetId).toBe('codexmkt-yuki')
    expect(arg.customPets).toHaveLength(1)
  })

  it('shows already-installed state for a pet already in customPets', async () => {
    const installedPet = { customPets: [{ id: 'codexmkt-yuki', name: 'Yuki', atlas: { path: 'x', version: 2 } }] } as unknown as Pet
    render(<PetMarketPane pet={installedPet} onChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('已安装')).toBeTruthy())
  })

  it('shows an error + retry when the catalog fails', async () => {
    ;(window as unknown as { forge: { codexMarketCatalog: unknown } }).forge.codexMarketCatalog = vi.fn(async () => ({ error: '无法连接' }))
    render(<PetMarketPane pet={pet} onChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/无法连接/)).toBeTruthy())
    expect(screen.getByText('重试')).toBeTruthy()
  })
})
