import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SessionImportPane } from './SessionImportPane'

const scan = vi.fn(); const run = vi.fn(); const read = vi.fn(); const list = vi.fn(); const lastScan = vi.fn(); const coverage = vi.fn(); const cont = vi.fn()
beforeEach(() => {
  scan.mockResolvedValue({ scannedAt: 1, groups: [
    { cwd: '/other/proj', wsPath: '/other/proj', matched: false, sessions: [
      { source: 'claude', externalId: 'a', cwd: '/other/proj', title: '重构登录', startedAt: 1, lastTs: 2, messageCount: 4, filePaths: ['/f'], hasBody: true },
      { source: 'cursor', externalId: 'cu', cwd: '/other/proj', title: 'cursor 会话', startedAt: 1, lastTs: 1, messageCount: 2, filePaths: ['/c'], hasBody: true },
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
  cont.mockResolvedValue({ ok: true, wsPath: '/other/proj', sessionId: 's-9', created: true, wsAdded: true })
  ;(globalThis as any).window.forge = { sessionImportScan: scan, sessionImportRun: run, sessionImportRead: read, sessionImportList: list, sessionImportLastScan: lastScan, sessionImportCoverage: coverage, sessionImportContinue: cont }
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
  it('claude / codex rows offer 在 myFlowForge 继续 (also inside an existing workspace); qoder only when it can be continued', async () => {
    render(<SessionImportPane />)
    fireEvent.click(screen.getByRole('button', { name: /扫描/ }))
    await screen.findByText('重构登录')
    expect(screen.getAllByRole('button', { name: '在 myFlowForge 继续' })).toHaveLength(1)
    fireEvent.click(screen.getByText(/已在工作区中/))
    await screen.findByText('已在工作区的会话')
    // codex row in the matched group gets it too; the qoder row (not continuable) gets nothing
    expect(screen.getAllByRole('button', { name: '在 myFlowForge 继续' })).toHaveLength(2)
  })
  it('a continuable qoder session offers the button too', async () => {
    scan.mockResolvedValue({ scannedAt: 1, groups: [{ cwd: '/q', wsPath: '/q', matched: false, sessions: [
      { source: 'qoder', externalId: 'q1', cwd: '/q', title: 'qoder 会话', startedAt: 1, lastTs: 1, messageCount: 0, filePaths: [], hasBody: false, continuable: true },
    ] }] })
    render(<SessionImportPane />)
    fireEvent.click(screen.getByRole('button', { name: /扫描/ }))
    await screen.findByText('qoder 会话')
    expect(screen.getByRole('button', { name: '在 myFlowForge 继续' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '导入' })).toBeNull()
  })
  it('在 myFlowForge 继续 takes the session over and opens it', async () => {
    const onOpenSession = vi.fn()
    run.mockClear()
    render(<SessionImportPane onOpenSession={onOpenSession} />)
    fireEvent.click(screen.getByRole('button', { name: /扫描/ }))
    await screen.findByText('重构登录')
    fireEvent.click(screen.getByRole('button', { name: '在 myFlowForge 继续' }))
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('/other/proj', 's-9'))
    expect(cont).toHaveBeenCalledWith(expect.objectContaining({ source: 'claude', externalId: 'a' }))
    expect(run).not.toHaveBeenCalled()
  })
  it('a failed takeover says so on the row and opens nothing', async () => {
    cont.mockResolvedValue({ ok: false, error: '找不到这个会话的记录' })
    const onOpenSession = vi.fn()
    render(<SessionImportPane onOpenSession={onOpenSession} />)
    fireEvent.click(screen.getByRole('button', { name: /扫描/ }))
    await screen.findByText('重构登录')
    fireEvent.click(screen.getByRole('button', { name: '在 myFlowForge 继续' }))
    expect(await screen.findByText('找不到这个会话的记录')).toBeInTheDocument()
    expect(onOpenSession).not.toHaveBeenCalled()
  })
})
