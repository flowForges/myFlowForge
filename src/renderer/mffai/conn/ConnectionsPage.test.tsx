import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ConnectionsPage from './ConnectionsPage'
import { installFakeForge, type FakeForge } from '../test/fakeForge'
import { tgCalls } from '../test/telegram'

let f: FakeForge

describe('ConnectionsPage', () => {
  it('defaults to 模型, with the three sub-tabs; 模型 shows the account list', async () => {
    f = installFakeForge()
    f.mffai.models.catalog.mockResolvedValue({ presets: [], models: {} })
    f.mffai.models.accounts.mockResolvedValue({ accounts: [{ id: 'a1', presetId: 'p', label: 'acc1', state: 'ok' }], secretsBackend: 'keychain' })
    render(<ConnectionsPage />)
    expect(screen.getByRole('tab', { name: '模型' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '执行器' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: 'Telegram' })).toHaveAttribute('aria-selected', 'false')
    expect(await screen.findByText('acc1')).toBeInTheDocument()
  })

  it('switches to 执行器 and shows its rows', async () => {
    f = installFakeForge({ calls: {
      'executor.list': { executors: [{ id: 'claude', installed: true, version: '1.0.0', auth: 'ok', isolation: 'own', missing: [] }] },
    } })
    f.mffai.models.catalog.mockResolvedValue({ presets: [], models: {} })
    f.mffai.models.accounts.mockResolvedValue({ accounts: [], secretsBackend: 'keychain' })
    render(<ConnectionsPage />)
    fireEvent.click(screen.getByRole('tab', { name: '执行器' }))
    expect(await screen.findByText('claude')).toBeInTheDocument()
  })

  it('switches to Telegram and shows its status, not the model list', async () => {
    f = installFakeForge({ calls: tgCalls() })
    f.mffai.models.catalog.mockResolvedValue({ presets: [], models: {} })
    f.mffai.models.accounts.mockResolvedValue({ accounts: [{ id: 'a1', presetId: 'p', label: 'acc1', state: 'ok' }], secretsBackend: 'keychain' })
    render(<ConnectionsPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Telegram' }))
    expect(await screen.findByTestId('mffai-tg-status')).toBeInTheDocument()
    expect(screen.queryByText('acc1')).toBeNull()
  })
})
