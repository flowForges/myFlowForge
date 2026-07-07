import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AgentsPane } from './AgentsPane'
import { BUILTIN_PROVIDERS } from '@shared/providerCatalog'
import type { ProviderInfo } from '@shared/types'

function makeDetected(overrides: Partial<ProviderInfo>[] = []): ProviderInfo[] {
  return BUILTIN_PROVIDERS.map(p => {
    const ov = overrides.find(o => o.id === p.id) ?? {}
    return {
      id: p.id,
      displayName: p.displayName,
      installed: false,
      models: [],
      liveModels: false,
      ...ov,
    }
  })
}

beforeEach(() => {
  ;(window as any).forge = {
    getAgentsConfig: vi.fn(async () => ({ providers: [], custom: [] })),
    detectProviders: vi.fn(async () => makeDetected()),
    pickFile: vi.fn(async () => null),
    setAgentBin: vi.fn(async () => makeDetected()),
    removeCustomAgent: vi.fn(async () => makeDetected()),
    addCustomAgent: vi.fn(async () => makeDetected()),
    refreshModels: vi.fn(async (_id: string) => ({ models: [] })),
    setModels: vi.fn(async () => []),
  }
})

describe('AgentsPane BUILTINS from catalog', () => {
  it('renders exactly 8 builtin provider rows (from catalog)', async () => {
    render(<AgentsPane />)
    for (const p of BUILTIN_PROVIDERS) {
      expect(await screen.findByText(p.displayName)).toBeInTheDocument()
    }
    expect(BUILTIN_PROVIDERS).toHaveLength(8)
  })

  it('builtin rows display the catalog displayNames', async () => {
    render(<AgentsPane />)
    expect(await screen.findByText('Claude Code')).toBeInTheDocument()
    expect(await screen.findByText('Codex')).toBeInTheDocument()
    expect(await screen.findByText('Gemini CLI')).toBeInTheDocument()
    expect(await screen.findByText('Qoder')).toBeInTheDocument()
    expect(await screen.findByText('Cursor Agent')).toBeInTheDocument()
  })
})

describe('AgentsPane progressive render (config first, detection later)', () => {
  it('renders provider rows as soon as config resolves, while detection is still pending', async () => {
    // Detection never resolves — the pane must NOT stay blank
    ;(window as any).forge.detectProviders = vi.fn(() => new Promise(() => {}))
    render(<AgentsPane />)
    expect(await screen.findByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
  })

  it('shows a 检测中… placeholder per provider while detection is pending, then fills in results', async () => {
    let resolveDetect!: (v: ProviderInfo[]) => void
    ;(window as any).forge.detectProviders = vi.fn(() => new Promise<ProviderInfo[]>(res => { resolveDetect = res }))
    render(<AgentsPane />)
    await screen.findByText('Claude Code')
    // While pending: placeholder badges, no premature 未检测 verdict
    expect(screen.getAllByText('检测中…').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('未检测')).toBeNull()
    // Resolve detection → placeholders replaced by real badges
    resolveDetect(makeDetected([{ id: 'claude', installed: true }]))
    await waitFor(() => expect(screen.queryByText('检测中…')).toBeNull())
    expect(screen.getAllByText('已检测').length).toBe(1)
    expect(screen.getAllByText('未检测').length).toBeGreaterThanOrEqual(1)
  })

  it('mount-time detection does NOT force (hits main-process cache)', async () => {
    render(<AgentsPane />)
    await screen.findByText('Claude Code')
    const firstCall = (window as any).forge.detectProviders.mock.calls[0]
    expect(firstCall[0]?.force).not.toBe(true)
  })

  it('重新检测 button calls detectProviders with force:true', async () => {
    render(<AgentsPane />)
    await screen.findByText('Claude Code')
    fireEvent.click(screen.getByText('重新检测'))
    await waitFor(() =>
      expect((window as any).forge.detectProviders).toHaveBeenCalledWith({ force: true })
    )
  })
})

describe('AgentsPane 刷新模型 button', () => {
  it('renders provider header with a dedicated meta group so long names and paths can wrap cleanly', async () => {
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([
        {
          id: 'cursor',
          installed: true,
          liveModels: true,
          version: '2026.06.15',
          binPath: '/Users/zghua/.local/bin/cursor-agent-with-a-very-long-path',
        },
      ])
    )
    const { container } = render(<AgentsPane />)

    await screen.findByText('Cursor Agent')
    const row = screen.getByText('Cursor Agent').closest('.agent-row') as HTMLElement

    expect(row.querySelector('.agent-row-title')).not.toBeNull()
    expect(row.querySelector('.agent-row-meta')).not.toBeNull()
    expect(row.querySelector('.agent-row-actions')).not.toBeNull()
    expect(container.querySelector('.agent-path')?.getAttribute('title')).toContain('cursor-agent-with-a-very-long-path')
  })

  it('shows 刷新模型 button for liveModels:true providers', async () => {
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([
        { id: 'qoder', installed: true, liveModels: true },
        { id: 'cursor', installed: true, liveModels: true },
      ])
    )
    render(<AgentsPane />)
    // Wait for providers to load
    await screen.findByText('Qoder')
    const buttons = screen.getAllByText('刷新模型')
    expect(buttons).toHaveLength(2)
  })

  it('does NOT show 刷新模型 button for liveModels:false providers', async () => {
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([
        { id: 'claude', installed: true, liveModels: false },
        { id: 'codex', installed: true, liveModels: false },
        { id: 'gemini', installed: true, liveModels: false },
      ])
    )
    render(<AgentsPane />)
    await screen.findByText('Claude Code')
    expect(screen.queryByText('刷新模型')).toBeNull()
  })

  it('clicking 刷新模型 calls window.forge.refreshModels with the provider id', async () => {
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([{ id: 'qoder', installed: true, liveModels: true }])
    )
    render(<AgentsPane />)
    await screen.findByText('Qoder')
    const btn = screen.getByText('刷新模型')
    fireEvent.click(btn)
    await waitFor(() =>
      expect((window as any).forge.refreshModels).toHaveBeenCalledWith('qoder')
    )
  })

  it('shows 刷新中… label and disables button while refreshing', async () => {
    let resolveRefresh!: (v: { models: [] }) => void
    ;(window as any).forge.refreshModels = vi.fn(
      () => new Promise<{ models: [] }>(res => { resolveRefresh = res })
    )
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([{ id: 'qoder', installed: true, liveModels: true }])
    )
    render(<AgentsPane />)
    await screen.findByText('Qoder')
    const btn = screen.getByText('刷新模型')
    fireEvent.click(btn)
    // During loading the button text changes
    expect(await screen.findByText('刷新中…')).toBeInTheDocument()
    expect(screen.getByText('刷新中…')).toBeDisabled()
    // Resolve and verify it goes back
    resolveRefresh({ models: [] })
    await waitFor(() => expect(screen.getByText('刷新模型')).toBeInTheDocument())
  })

  it('shows inline error when refreshModels returns error', async () => {
    ;(window as any).forge.refreshModels = vi.fn(async () => ({
      models: [],
      error: '刷新失败(空结果)',
    }))
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([{ id: 'qoder', installed: true, liveModels: true }])
    )
    render(<AgentsPane />)
    await screen.findByText('Qoder')
    fireEvent.click(screen.getByText('刷新模型'))
    expect(await screen.findByText('刷新失败(空结果)')).toBeInTheDocument()
  })

  it('triggers re-detect after successful refresh', async () => {
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([{ id: 'qoder', installed: true, liveModels: true }])
    )
    render(<AgentsPane />)
    await screen.findByText('Qoder')
    fireEvent.click(screen.getByText('刷新模型'))
    await waitFor(() =>
      // detectProviders should have been called: once on mount, once after refresh
      expect((window as any).forge.detectProviders).toHaveBeenCalledTimes(2)
    )
  })

  it('only shows 刷新模型 for liveModels:true in mixed scenario', async () => {
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([
        { id: 'claude', installed: true, liveModels: false },
        { id: 'qoder', installed: true, liveModels: true },
      ])
    )
    render(<AgentsPane />)
    await screen.findByText('Qoder')
    // Only one button for qoder
    const buttons = screen.getAllByText('刷新模型')
    expect(buttons).toHaveLength(1)
  })
})

describe('AgentsPane 可用模型 editable list', () => {
  it('renders detected model ids as editable rows', async () => {
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([
        { id: 'claude', installed: true, models: [{ id: 'opus', label: 'opus' }, { id: 'sonnet', label: 'sonnet' }] },
      ])
    )
    render(<AgentsPane />)
    await screen.findByText('Claude Code')
    // model id inputs should appear
    const inputs = screen.getAllByPlaceholderText('model id')
    const claudeInputs = inputs.filter(i => (i as HTMLInputElement).value === 'opus' || (i as HTMLInputElement).value === 'sonnet')
    expect(claudeInputs.length).toBeGreaterThanOrEqual(2)
  })

  it('"添加模型" button adds an empty row', async () => {
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([{ id: 'claude', installed: true, models: [{ id: 'opus', label: 'opus' }] }])
    )
    render(<AgentsPane />)
    await screen.findByText('Claude Code')
    const addBtns = screen.getAllByText('添加模型')
    // Claude's 添加模型 button
    fireEvent.click(addBtns[0])
    // One more empty model id input should appear
    const emptyInputs = screen.getAllByPlaceholderText('model id').filter(i => (i as HTMLInputElement).value === '')
    expect(emptyInputs.length).toBeGreaterThanOrEqual(1)
  })

  it('"×" button removes that model row', async () => {
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([{ id: 'claude', installed: true, models: [{ id: 'opus', label: 'opus' }, { id: 'sonnet', label: 'sonnet' }] }])
    )
    render(<AgentsPane />)
    await screen.findByText('Claude Code')
    // Both opus and sonnet inputs should be there
    const before = screen.getAllByPlaceholderText('model id').filter(i => (i as HTMLInputElement).value !== '')
    expect(before.length).toBeGreaterThanOrEqual(2)
    // Click first × button within Claude's model rows
    const delBtns = screen.getAllByTitle('删除')
    fireEvent.click(delBtns[0])
    // One fewer input with a value
    await waitFor(() => {
      const after = screen.getAllByPlaceholderText('model id').filter(i => (i as HTMLInputElement).value !== '')
      expect(after.length).toBeLessThan(before.length)
    })
  })

  it('"保存模型" calls window.forge.setModels with edited rows (filters empty id rows)', async () => {
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([{ id: 'claude', installed: true, models: [{ id: 'opus', label: 'opus' }] }])
    )
    render(<AgentsPane />)
    await screen.findByText('Claude Code')
    // Add an empty row (should be filtered on save)
    fireEvent.click(screen.getAllByText('添加模型')[0])
    // Save
    fireEvent.click(screen.getAllByText('保存模型')[0])
    await waitFor(() =>
      expect((window as any).forge.setModels).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([expect.objectContaining({ id: 'opus' })])
      )
    )
    // The empty-id row should NOT be included
    const call = (window as any).forge.setModels.mock.calls[0]
    const models: { id: string }[] = call[1]
    expect(models.every((m: { id: string }) => m.id !== '')).toBe(true)
  })

  it('"恢复默认" calls window.forge.setModels with empty array', async () => {
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([{ id: 'claude', installed: true, models: [{ id: 'opus', label: 'opus' }] }])
    )
    render(<AgentsPane />)
    await screen.findByText('Claude Code')
    fireEvent.click(screen.getAllByText('恢复默认')[0])
    await waitFor(() =>
      expect((window as any).forge.setModels).toHaveBeenCalledWith('claude', [])
    )
  })
})

describe('AgentsPane install guidance', () => {
  it('shows install + auth command for undetected builtin only', async () => {
    ;(window as any).forge.detectProviders = vi.fn(async () =>
      makeDetected([
        { id: 'claude', installed: false, installCmd: 'curl -fsSL https://claude.ai/install.sh | bash', authCmd: 'claude', installHelp: '安装后运行 claude' },
        { id: 'codex', installed: true, installCmd: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', authCmd: 'codex', installHelp: 'x' },
      ])
    )
    render(<AgentsPane />)
    await waitFor(() => screen.getByText('Claude Code'))
    // 未检测的 claude 显示安装命令
    expect(screen.getByText('curl -fsSL https://claude.ai/install.sh | bash')).toBeInTheDocument()
    expect(screen.getAllByText('复制安装命令').length).toBe(1)  // 仅 claude(codex 已检测,不显示)
  })
})
