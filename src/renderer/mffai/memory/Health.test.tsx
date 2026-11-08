import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MemoryHealth } from '@mffai/protocol'
import { Health } from './Health'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'

let f: FakeForge

const health = (patch: Partial<MemoryHealth> = {}): MemoryHealth => ({
  dbBytes: 1024, rawRows: 10, noteRows: 5, cursorLag: 0, pendingProposals: 2, problems: [], ...patch,
})

beforeEach(() => {
  resetSeq()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('Health', () => {
  it('shows db size, rows, cursorLag, pending proposals and last consolidation formatted as a local date+time', async () => {
    f = installFakeForge({ calls: { 'memory.health': health({ lastConsolidation: '2026-11-01T09:30:00.000Z' }) } })
    render(<Health />)
    expect(await screen.findByText('1024')).toBeInTheDocument()
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    const expected = new Date('2026-11-01T09:30:00.000Z').toLocaleString()
    expect(screen.getByText(expected)).toBeInTheDocument()
  })

  it('a date-only lastConsolidation (the real shape: localDate() in consolidate.ts) formats as a local date, not shifted by timezone parsing', async () => {
    f = installFakeForge({ calls: { 'memory.health': health({ lastConsolidation: '2026-11-01' }) } })
    render(<Health />)
    await screen.findByText('1024')
    const expected = new Date(2026, 10, 1).toLocaleDateString()
    expect(screen.getByText(expected)).toBeInTheDocument()
  })

  it('shows the budget bars as value / limit for tokens and usd', async () => {
    f = installFakeForge({ calls: { 'memory.health': health({ budget: { tokens: 100, usd: 1, tokensLimit: 1000, usdLimit: 10 } }) } })
    render(<Health />)
    expect(await screen.findByText('100 / 1000')).toBeInTheDocument()
    expect(screen.getByText('1 / 10')).toBeInTheDocument()
  })

  it('a file_over_cap problem renders as a CodeChip with the full code', async () => {
    f = installFakeForge({ calls: { 'memory.health': health({ problems: ['file_over_cap:MEMORY.md (12000>10000)'] }) } })
    render(<Health />)
    expect(await screen.findByText('file_over_cap:MEMORY.md (12000>10000)')).toBeInTheDocument()
  })

  it('a delete_stuck problem shows 删除卡住 with a 重试 button that re-sends memory.delete with the same id', async () => {
    f = installFakeForge({ calls: {
      'memory.health': health({ problems: ['delete_stuck:n_x'] }),
      'memory.delete': { ok: true, redacted: 1, sources: [] },
    } })
    render(<Health />)
    expect(await screen.findByText('删除卡住')).toBeInTheDocument()
    expect(screen.getByText('n_x')).toBeInTheDocument()
    f.script({ 'memory.health': health({ problems: [] }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    expect(f.callsOf('memory.delete')).toEqual([{ commandId: expect.any(String), id: 'n_x' }])
    await waitFor(() => expect(screen.queryByText('删除卡住')).toBeNull())
  })

  it('立即整理 calls memory.consolidate, spins while pending, and shows the result counts', async () => {
    let resolve!: (v: { extracted: number; promoted: number; proposed: number }) => void
    f = installFakeForge({ calls: { 'memory.health': health() } })
    f.script({ 'memory.consolidate': () => new Promise((r) => { resolve = r }) })
    render(<Health />)
    const btn = await screen.findByRole('button', { name: '立即整理' })
    fireEvent.click(btn)
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    await screen.findByText('整理中')
    await act(async () => { resolve({ extracted: 3, promoted: 2, proposed: 1 }) })
    expect(await screen.findByText('提取 3 · 写入 2 · 提议 1')).toBeInTheDocument()
    expect(screen.queryByText('整理中')).toBeNull()
  })

  it('a memory.consolidated event updates the last result even without clicking 立即整理', async () => {
    f = installFakeForge({ calls: { 'memory.health': health() } })
    render(<Health />)
    await screen.findByRole('button', { name: '立即整理' })
    await act(async () => { f.emit(ev('memory.consolidated', { extracted: 5, promoted: 4, proposed: 1 })) })
    expect(await screen.findByText('提取 5 · 写入 4 · 提议 1')).toBeInTheDocument()
  })

  it('a failed consolidate shows 失败', async () => {
    f = installFakeForge({ calls: { 'memory.health': health(), 'memory.consolidate': () => fail(-32603, 'boom') } })
    render(<Health />)
    const btn = await screen.findByRole('button', { name: '立即整理' })
    await act(async () => { fireEvent.click(btn) })
    expect(screen.getByText('失败')).toBeInTheDocument()
  })

  it('-32601 shows 不支持', async () => {
    f = installFakeForge({ calls: { 'memory.health': () => fail(-32601) } })
    render(<Health />)
    await screen.findByText('不支持')
  })

  it('a -32603 "memory is unavailable" on memory.health shows 不支持, same as -32601', async () => {
    f = installFakeForge({ calls: { 'memory.health': () => fail(-32603, 'memory is unavailable') } })
    render(<Health />)
    await screen.findByText('不支持')
  })

  it('a -32603 "memory is unavailable" on memory.consolidate shows 不支持', async () => {
    f = installFakeForge({ calls: { 'memory.health': health(), 'memory.consolidate': () => fail(-32603, 'memory is unavailable') } })
    render(<Health />)
    const btn = await screen.findByRole('button', { name: '立即整理' })
    await act(async () => { fireEvent.click(btn) })
    expect(screen.getByText('不支持')).toBeInTheDocument()
  })

  it('a delete_stuck retry that comes back -32602 not found counts as done: the row clears, no 失败', async () => {
    f = installFakeForge({ calls: {
      'memory.health': health({ problems: ['delete_stuck:n_x'] }),
      'memory.delete': () => fail(-32602, 'not found'),
    } })
    render(<Health />)
    await screen.findByText('删除卡住')
    f.script({ 'memory.health': health({ problems: [] }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    await waitFor(() => expect(screen.queryByText('删除卡住')).toBeNull())
    expect(screen.queryByText('失败')).toBeNull()
  })

  it('立即整理 stays spinning across a remount (the in-flight call is not forgotten, so a second click cannot double-trigger it)', async () => {
    let resolve!: (v: { extracted: number; promoted: number; proposed: number }) => void
    f = installFakeForge({ calls: { 'memory.health': health() } })
    f.script({ 'memory.consolidate': () => new Promise((r) => { resolve = r }) })
    const { unmount } = render(<Health />)
    const btn = await screen.findByRole('button', { name: '立即整理' })
    fireEvent.click(btn)
    await screen.findByText('整理中')
    unmount()
    render(<Health />)
    const btn2 = await screen.findByRole('button', { name: '立即整理' }) as HTMLButtonElement
    expect(btn2.disabled).toBe(true)
    await screen.findByText('整理中')
    await act(async () => { resolve({ extracted: 7, promoted: 6, proposed: 1 }) })
    expect(await screen.findByText('提取 7 · 写入 6 · 提议 1')).toBeInTheDocument()
    expect(f.callsOf('memory.consolidate')).toHaveLength(1)
  })
})
