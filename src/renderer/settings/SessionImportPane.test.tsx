import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SessionImportPane } from './SessionImportPane'

const scan = vi.fn(); const run = vi.fn(); const read = vi.fn(); const list = vi.fn(); const lastScan = vi.fn(); const coverage = vi.fn()
beforeEach(() => {
  scan.mockResolvedValue({ scannedAt: 1, groups: [
    { cwd: '/other/proj', wsPath: '/other/proj', matched: false, sessions: [
      { source: 'claude', externalId: 'a', cwd: '/other/proj', title: '重构登录', startedAt: 1, lastTs: 2, messageCount: 4, filePaths: ['/f'], hasBody: true },
    ] },
    { cwd: '/q', wsPath: '/q', matched: true, sessions: [
      { source: 'qoder', externalId: 'q1', cwd: '/q', title: '历史会话(无可读正文)', startedAt: 1, lastTs: 1, messageCount: 0, filePaths: [], hasBody: false },
      { source: 'codex', externalId: 'q2', cwd: '/q', title: '已在工作区的会话', startedAt: 1, lastTs: 2, messageCount: 3, filePaths: [], hasBody: true },
    ] },
  ] })
  run.mockResolvedValue({ index: { version: 1, scannedAt: 2, sessions: [] }, gitRepos: [] })
  read.mockResolvedValue([{ who: 'user', text: 'hi there', ts: '' }])
  list.mockResolvedValue({ version: 1, scannedAt: 0, sessions: [] })
  lastScan.mockResolvedValue(null)
  coverage.mockResolvedValue({ supported: [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }], unsupported: [{ id: 'gemini', label: 'Gemini CLI', reason: '会话记录存储在云端，暂不支持本地导入' }] })
  ;(globalThis as any).window.forge = { sessionImportScan: scan, sessionImportRun: run, sessionImportRead: read, sessionImportList: list, sessionImportLastScan: lastScan, sessionImportCoverage: coverage }
})

describe('SessionImportPane', () => {
  it('scans and renders new groups; tucks already-workspace groups under a collapsed section', async () => {
    render(<SessionImportPane />)
    fireEvent.click(screen.getByRole('button', { name: /扫描/ }))
    expect(await screen.findByText('重构登录')).toBeInTheDocument()
    expect(screen.getByText('＋新建轻量工作区')).toBeInTheDocument()
    // matched group is collapsed by default — its tag isn't shown until expanded
    expect(screen.queryByText('✓已是工作区')).toBeNull()
    expect(screen.getByText(/已在工作区中/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/已在工作区中/))
    expect(screen.getByText('✓已是工作区')).toBeInTheDocument()
  })
  it('imports a session group', async () => {
    render(<SessionImportPane />)
    fireEvent.click(screen.getByRole('button', { name: /扫描/ }))
    await screen.findByText('重构登录')
    fireEvent.click(screen.getAllByRole('button', { name: '导入全部' })[0])
    await waitFor(() => expect(run).toHaveBeenCalled())
  })
  it('does not offer import buttons for already-in-workspace (matched) groups', async () => {
    render(<SessionImportPane />)
    fireEvent.click(screen.getByRole('button', { name: /扫描/ }))
    await screen.findByText('重构登录')
    // Before expanding: only the new (importable) group is visible → exactly one of each button.
    expect(screen.getAllByRole('button', { name: '导入全部' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '导入' })).toHaveLength(1)
    // Expand the matched section: its sessions become visible but must NOT add import buttons.
    fireEvent.click(screen.getByText(/已在工作区中/))
    await screen.findByText('✓已是工作区')
    expect(screen.getByText('已在工作区的会话')).toBeInTheDocument()  // session row still browsable
    expect(screen.getAllByRole('button', { name: '导入全部' })).toHaveLength(1)  // no matched 导入全部
    expect(screen.getAllByRole('button', { name: '导入' })).toHaveLength(1)      // no matched per-session 导入
  })
  it('shows provider coverage notice on mount', async () => {
    render(<SessionImportPane />)
    expect(await screen.findByText(/已支持导入/)).toBeInTheDocument()
    expect(screen.getByText(/Gemini CLI/)).toBeInTheDocument()
    expect(screen.getByText(/会话记录存储在云端/)).toBeInTheDocument()
  })
  it('opens read-only viewer on session click', async () => {
    render(<SessionImportPane />)
    fireEvent.click(screen.getByRole('button', { name: /扫描/ }))
    fireEvent.click(await screen.findByText('重构登录'))
    expect(await screen.findByText('hi there')).toBeInTheDocument()
  })
})
