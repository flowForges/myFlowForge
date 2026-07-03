// src/renderer/views/InstallBanner.test.tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { InstallBanner } from './InstallBanner'

describe('InstallBanner', () => {
  it('renders when zero builtins detected', async () => {
    ;(window as any).forge = { detectProviders: async () => ([
      { id: 'claude', displayName: 'Claude Code', installed: false, models: [], installCmd: 'curl x', authCmd: 'claude' },
      { id: 'codex', displayName: 'Codex', installed: false, models: [], installCmd: 'curl y', authCmd: 'codex' },
    ]) }
    render(<InstallBanner onGoSettings={() => {}} />)
    await waitFor(() => screen.getByText('本机未检测到任何编码代理'))
    expect(screen.getByText('curl x')).toBeInTheDocument()
  })
  it('renders nothing when at least one detected', async () => {
    ;(window as any).forge = { detectProviders: async () => ([
      { id: 'claude', displayName: 'Claude Code', installed: true, models: [] },
    ]) }
    const { container } = render(<InstallBanner onGoSettings={() => {}} />)
    await waitFor(() => expect(container.querySelector('.install-banner')).toBeNull())
  })
})
