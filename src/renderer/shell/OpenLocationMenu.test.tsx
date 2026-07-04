import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { OpenLocationMenu, __resetOpenerCache } from './OpenLocationMenu'
import type { DetectedOpener } from '@shared/openers'

const APPS: DetectedOpener[] = [
  { id: 'vscode', name: 'VS Code', openMode: 'together', appPath: '/A/VS Code.app', icon: 'data:img,vs' },
  { id: 'finder', name: 'Finder', openMode: 'folder-only', appPath: '/System/Library/CoreServices/Finder.app' },
]
const target = { folder: '/ws/proj', file: '/ws/proj/a.ts' }

function stubForge(over: Record<string, unknown> = {}) {
  const detectOpeners = vi.fn().mockResolvedValue(APPS)
  const openWith = vi.fn().mockResolvedValue({ ok: true })
  ;(window as any).forge = { detectOpeners, openWith, ...over }
  return { detectOpeners, openWith }
}

beforeEach(() => { __resetOpenerCache(); (window as any).alert = vi.fn() })

describe('OpenLocationMenu', () => {
  it('shows the default opener name on the button after detect', async () => {
    stubForge()
    render(<OpenLocationMenu target={target} defaultOpenerId="vscode" onSetDefault={() => {}} />)
    await waitFor(() => expect(screen.getByText('VS Code')).toBeTruthy())
  })

  it('shows 打开位置 when no default is set', async () => {
    stubForge()
    render(<OpenLocationMenu target={target} defaultOpenerId="" onSetDefault={() => {}} />)
    await waitFor(() => expect(screen.getByText('打开位置')).toBeTruthy())
  })

  it('clicking the main button (with a default) opens the current target with it', async () => {
    const { openWith } = stubForge()
    render(<OpenLocationMenu target={target} defaultOpenerId="vscode" onSetDefault={() => {}} />)
    await waitFor(() => screen.getByText('VS Code'))
    fireEvent.click(screen.getByRole('button', { name: '用外部软件打开' }))
    await waitFor(() => expect(openWith).toHaveBeenCalledWith({ openerId: 'vscode', folder: '/ws/proj', file: '/ws/proj/a.ts' }))
  })

  it('picking from the dropdown sets it as default AND opens the target', async () => {
    const { openWith } = stubForge()
    const onSetDefault = vi.fn()
    render(<OpenLocationMenu target={target} defaultOpenerId="" onSetDefault={onSetDefault} />)
    fireEvent.click(screen.getByRole('button', { name: '选择软件' }))
    fireEvent.click(await screen.findByText('Finder'))
    expect(onSetDefault).toHaveBeenCalledWith('finder')
    await waitFor(() => expect(openWith).toHaveBeenCalledWith({ openerId: 'finder', folder: '/ws/proj', file: '/ws/proj/a.ts' }))
  })

  it('disables the main button when there is no target', async () => {
    stubForge()
    render(<OpenLocationMenu target={null} defaultOpenerId="vscode" onSetDefault={() => {}} />)
    await waitFor(() => screen.getByText('VS Code'))
    expect((screen.getByRole('button', { name: '用外部软件打开' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('lazy-refresh: a since-deleted app (removedId) is dropped from the list + cleared as default', async () => {
    const onSetDefault = vi.fn()
    stubForge({ openWith: vi.fn().mockResolvedValue({ ok: false, error: 'VS Code 已不存在,已从列表移除', removedId: 'vscode' }) })
    render(<OpenLocationMenu target={target} defaultOpenerId="vscode" onSetDefault={onSetDefault} />)
    await waitFor(() => screen.getByText('VS Code'))
    fireEvent.click(screen.getByRole('button', { name: '用外部软件打开' }))
    await waitFor(() => expect(onSetDefault).toHaveBeenCalledWith(''))
    // The button falls back to 打开位置 once its default was removed.
    await waitFor(() => expect(screen.getByText('打开位置')).toBeTruthy())
  })

  it('shows an empty state when no openers are detected', async () => {
    stubForge({ detectOpeners: vi.fn().mockResolvedValue([]) })
    render(<OpenLocationMenu target={target} defaultOpenerId="" onSetDefault={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '选择软件' }))
    expect(await screen.findByText('未检测到可用软件')).toBeTruthy()
  })
})
