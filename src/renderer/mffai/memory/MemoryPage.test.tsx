import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import MemoryPage from './MemoryPage'
import { fail, installFakeForge, RUNNING_STATE, type CallTable, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'

let f: FakeForge

const baseCalls = (patch: CallTable = {}): CallTable => ({
  'memory.health': { dbBytes: 1, rawRows: 1, noteRows: 1, cursorLag: 0, pendingProposals: 0, problems: [] },
  'memory.file.get': { content: '', hash: 'h0', cap: 2000 },
  'memory.list': { items: [] },
  'memory.proposals.list': { items: [] },
  'memory.habits.list': { items: [] },
  'memory.changes': { items: [] },
  ...patch,
})

beforeEach(() => {
  resetSeq()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('MemoryPage', () => {
  it('shows the six tabs and the profile tab (USER.md/MEMORY.md) by default', async () => {
    f = installFakeForge({ calls: baseCalls() })
    render(<MemoryPage />)
    await screen.findByLabelText('USER.md')
    expect(screen.getByLabelText('MEMORY.md')).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['档案', '待确认', '条目', '习惯', '变更', '状态'])
  })

  it('lists distinct topic files from memory.list {layer:topic} as extra editors', async () => {
    f = installFakeForge({ calls: baseCalls({
      'memory.list': (p: { layer?: string }) => p.layer === 'topic'
        ? { items: [
            { id: 'n_1', layer: 'topic', text: 'a', file: 'topics/work.md' },
            { id: 'n_2', layer: 'topic', text: 'b', file: 'topics/work.md' },
            { id: 'n_3', layer: 'topic', text: 'c', file: 'topics/home.md' },
          ] }
        : { items: [] },
    }) })
    render(<MemoryPage />)
    await screen.findByLabelText('USER.md')
    expect(await screen.findByLabelText('topics/home.md')).toBeInTheDocument()
    expect(screen.getByLabelText('topics/work.md')).toBeInTheDocument()
    expect(screen.getAllByTestId(/^mffai-file-/)).toHaveLength(4)
  })

  it('switching tabs renders each subpage', async () => {
    f = installFakeForge({ calls: baseCalls({
      'memory.habits.list': { items: [{ id: 'h1', kind: 'routine', weekday: 1, hour: 9, cwd: '/repo', status: 'detected' }] },
    }) })
    render(<MemoryPage />)
    await screen.findByLabelText('USER.md')
    fireEvent.click(screen.getByRole('tab', { name: '习惯' }))
    expect(await screen.findByText('周一 9 点 · /repo')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '待确认' }))
    fireEvent.click(screen.getByRole('tab', { name: '条目' }))
    fireEvent.click(screen.getByRole('tab', { name: '变更' }))
    fireEvent.click(screen.getByRole('tab', { name: '状态' }))
    expect(await screen.findByRole('button', { name: '立即整理' })).toBeInTheDocument()
  })

  it('a full-cap proposal approval jumps to the profile tab', async () => {
    f = installFakeForge({ calls: baseCalls({
      'memory.proposals.list': { items: [{
        id: 'p1', target: 'USER.md', op: 'add', text: 'x', evidence: [], source: 'extract', flags: [], status: 'pending', createdAt: 1,
      }] },
      'memory.proposals.decide': () => fail(-32602, 'full'),
    }) })
    render(<MemoryPage />)
    await screen.findByLabelText('USER.md')
    fireEvent.click(screen.getByRole('tab', { name: '待确认' }))
    await screen.findByText('USER.md', { selector: '.mffai-badge' })
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    fireEvent.click(await screen.findByRole('button', { name: '去编辑' }))
    expect(screen.getByRole('tab', { name: '档案', selected: true })).toBeInTheDocument()
    expect(await screen.findByLabelText('USER.md')).toBeInTheDocument()
  })

  it('shows the files directory path with a copy button in the profile tab, from mffai.state().roots', async () => {
    f = installFakeForge({ calls: baseCalls(), state: { ...RUNNING_STATE, roots: { data: '/d/mff-ai', worktrees: '/w', imWorktrees: '/im', plugins: '/p', keychain: 'k' } } })
    render(<MemoryPage />)
    expect(await screen.findByText('/d/mff-ai/plugins/memory-default/files')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /复制/ })).toBeInTheDocument()
  })

  it('-32601 on memory.health shows 记忆不可用 with the plugin error from status', async () => {
    f = installFakeForge({ calls: {
      'memory.health': () => fail(-32601),
      status: { state: 'running', uptimeMs: 1, rssMb: 1, version: '0.1.0', plugins: [{ id: 'memory-default', state: 'failed', error: 'sessions service missing' }] },
    } })
    render(<MemoryPage />)
    await screen.findByText('记忆不可用')
    expect(await screen.findByText('sessions service missing')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('a non-32601 failure on memory.health still renders the normal tabbed page', async () => {
    f = installFakeForge({ calls: baseCalls({ 'memory.health': () => fail(-32603, 'boom') }) })
    render(<MemoryPage />)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(6))
  })

  it('switching away from the profile tab and back keeps an unsaved edit (the editor stays mounted, just hidden)', async () => {
    f = installFakeForge({ calls: baseCalls() })
    render(<MemoryPage />)
    const box = await screen.findByLabelText('USER.md')
    fireEvent.change(box, { target: { value: 'unsaved draft' } })
    fireEvent.click(screen.getByRole('tab', { name: '条目' }))
    expect(screen.getByLabelText('USER.md')).toHaveValue('unsaved draft')
    fireEvent.click(screen.getByRole('tab', { name: '档案' }))
    expect(screen.getByLabelText('USER.md')).toHaveValue('unsaved draft')
    const userEditor = screen.getByTestId('mffai-file-USER.md')
    expect(within(userEditor).getByRole('button', { name: '保存' })).not.toBeDisabled()
  })

  it('the gate flipping to unavailable after being ok (plugin.failed) keeps the dirty draft, now read-only, with a 记忆不可用 banner', async () => {
    f = installFakeForge({ calls: baseCalls() })
    render(<MemoryPage />)
    const box = await screen.findByLabelText('USER.md')
    fireEvent.change(box, { target: { value: 'unsaved draft' } })
    f.script({
      'memory.health': () => fail(-32601),
      status: { state: 'running', uptimeMs: 1, rssMb: 1, version: '0.1.0', plugins: [{ id: 'memory-default', state: 'failed', error: 'crashed' }] },
    })
    await act(async () => { f.emit(ev('plugin.failed', { id: 'memory-default', error: 'crashed' })) })
    await screen.findByText('记忆不可用')
    await screen.findByText('crashed')
    expect(screen.getAllByRole('tab')).toHaveLength(6)
    expect(screen.getByLabelText('USER.md')).toHaveValue('unsaved draft')
    expect(screen.getByLabelText('USER.md')).toBeDisabled()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })
})
