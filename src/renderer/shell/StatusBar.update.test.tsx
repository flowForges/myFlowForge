import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StatusBar } from './StatusBar'

const base = { branch: 'main', providers: [] as any[] }

describe('StatusBar terminal toggle', () => {
  it('renders the 终端 toggle and calls onToggleTerminal on click', () => {
    const onToggleTerminal = vi.fn()
    render(<StatusBar {...base} sbTerm={{ open: false, onToggle: onToggleTerminal }} />)
    fireEvent.click(screen.getByTitle('终端 (⌃`)'))
    expect(onToggleTerminal).toHaveBeenCalledTimes(1)
  })
})

describe('StatusBar update bits', () => {
  it('shows the current version and triggers a check on click', () => {
    const onCheck = vi.fn()
    render(<StatusBar {...base} update={{ currentVersion: '1.0.0', hasUpdate: false, checking: false, uptodate: false, onCheck, onOpenUpgrade: () => {} }} />)
    const ver = screen.getByText('Forge v1.0.0')
    fireEvent.click(ver)
    expect(onCheck).toHaveBeenCalled()
  })
  it('shows 检查中… while checking', () => {
    render(<StatusBar {...base} update={{ currentVersion: '1.0.0', hasUpdate: false, checking: true, uptodate: false, onCheck: () => {}, onOpenUpgrade: () => {} }} />)
    expect(screen.getByText('检查中…')).toBeTruthy()
  })
  it('shows the update pill and opens the modal on click', () => {
    const onOpenUpgrade = vi.fn()
    const { container } = render(<StatusBar {...base} update={{ currentVersion: '1.0.0', hasUpdate: true, updateVersion: '2.4.0', checking: false, uptodate: false, onCheck: () => {}, onOpenUpgrade }} />)
    const pill = container.querySelector('.sb-update') as HTMLElement
    expect(pill.textContent).toContain('新版本 v2.4.0')
    fireEvent.click(pill)
    expect(onOpenUpgrade).toHaveBeenCalled()
  })
})
