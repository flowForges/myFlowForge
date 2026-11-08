import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { MemoryItem } from '@mffai/protocol'
import Items from './Items'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'

let f: FakeForge

const item = (id: string, patch: Partial<MemoryItem> = {}): MemoryItem => ({
  id, layer: 'user', text: `text of ${id}`, ...patch,
})

beforeEach(() => {
  resetSeq()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('Items', () => {
  it('lists items for the default layer; shows text, layer, source, flags', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': { items: [item('n_a', { source: 'extract', flags: ['pii'], ts: 1700000000000 })] },
    } })
    render(<Items />)
    expect(await screen.findByText('text of n_a')).toBeInTheDocument()
    expect(screen.getByText('extract')).toBeInTheDocument()
    expect(screen.getByText('pii')).toBeInTheDocument()
    expect(f.callsOf('memory.list')).toEqual([{ layer: 'user', limit: 50 }])
  })

  it('changing the layer reloads with that layer', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': { items: [] },
    } })
    render(<Items />)
    await waitFor(() => expect(f.callsOf('memory.list')).toHaveLength(1))
    fireEvent.change(screen.getByLabelText('层'), { target: { value: 'raw' } })
    await waitFor(() => expect(f.callsOf('memory.list').at(-1)).toEqual({ layer: 'raw', limit: 50 }))
  })

  it('a search switches to memory.search with the chosen scope, and 返回列表 goes back to the list', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': { items: [item('n_a')] },
      'memory.search': { items: [item('r_1', { layer: 'raw', text: 'found it' })] },
    } })
    render(<Items />)
    await screen.findByText('text of n_a')
    fireEvent.change(screen.getByLabelText('搜索范围'), { target: { value: 'raw' } })
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'it' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(await screen.findByText('found it')).toBeInTheDocument()
    expect(screen.queryByText('text of n_a')).toBeNull()
    expect(f.callsOf('memory.search')).toEqual([{ query: 'it', layer: 'raw', limit: 50 }])
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }))
    expect(await screen.findByText('text of n_a')).toBeInTheDocument()
  })

  it('更早 pages with before, from the last item ts', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': { items: [item('n_a', { ts: 100 })] },
    } })
    render(<Items />)
    await screen.findByText('text of n_a')
    f.script({ 'memory.list': { items: [item('n_b', { ts: 50 })] } })
    fireEvent.click(screen.getByRole('button', { name: '更早' }))
    expect(await screen.findByText('text of n_b')).toBeInTheDocument()
    expect(screen.getByText('text of n_a')).toBeInTheDocument()
    expect(f.callsOf('memory.list').at(-1)).toEqual({ layer: 'user', limit: 50, before: 100 })
  })

  it('a delete_pending item from memory.health shows 删除中 and its delete button is disabled', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: ['delete_pending:n_a'] },
      'memory.list': { items: [item('n_a'), item('n_b')] },
    } })
    render(<Items />)
    await screen.findByText('text of n_a')
    const rowA = document.querySelector('[data-item="n_a"]') as HTMLElement
    const rowB = document.querySelector('[data-item="n_b"]') as HTMLElement
    expect(within(rowA).getByText('删除中')).toBeInTheDocument()
    expect(within(rowA).queryByRole('button', { name: '删除' })).toBeNull()
    expect(within(rowB).getByRole('button', { name: '删除' })).toBeInTheDocument()
  })

  it('single delete: removes the row and opens DeleteSources when sources is non-empty', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': { items: [item('n_a')] },
      'memory.delete': { ok: true, redacted: 1, sources: ['r_1'] },
      'memory.get': { id: 'r_1', layer: 'raw', text: 'the original line' },
    } })
    render(<Items />)
    await screen.findByText('text of n_a')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(screen.queryByText('text of n_a')).toBeNull())
    expect(await screen.findByText('对话里的原话 1 条')).toBeInTheDocument()
    expect(await screen.findByText('the original line')).toBeInTheDocument()
  })

  it('single delete retried after a timeout uses the same commandId, and a not-found retry counts as deleted', async () => {
    let calls = 0
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': { items: [item('n_a')] },
      'memory.delete': () => { calls += 1; return calls === 1 ? fail(-32010, 'timeout') : fail(-32602, 'not found') },
    } })
    render(<Items />)
    await screen.findByText('text of n_a')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(f.callsOf('memory.delete')).toHaveLength(1))
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    await waitFor(() => expect(screen.queryByText('text of n_a')).toBeNull())
    const sent = f.callsOf('memory.delete') as { commandId: string }[]
    expect(sent).toHaveLength(2)
    expect(sent[1].commandId).toBe(sent[0].commandId)
  })

  it('checking several rows shows 删除所选 N, and sends one memory.deleteMany call', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': { items: [item('n_a'), item('n_b'), item('n_c')] },
      'memory.deleteMany': { ok: true, redacted: 2, sources: [], gone: ['n_c'] },
    } })
    render(<Items />)
    await screen.findByText('text of n_a')
    fireEvent.click(screen.getByLabelText('选择 n_a'))
    fireEvent.click(screen.getByLabelText('选择 n_b'))
    fireEvent.click(screen.getByLabelText('选择 n_c'))
    expect(screen.getByRole('button', { name: '删除所选 3' })).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除所选 3' })) })
    expect(f.callsOf('memory.deleteMany')).toEqual([{ commandId: expect.any(String), ids: ['n_a', 'n_b', 'n_c'] }])
    await waitFor(() => expect(screen.queryByText('text of n_a')).toBeNull())
    expect(screen.queryByText('text of n_b')).toBeNull()
    expect(screen.queryByText('text of n_c')).toBeNull()
  })

  it('-32601 on memory.list shows 不支持', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': () => fail(-32601),
    } })
    render(<Items />)
    await screen.findByText('不支持')
  })

  it('memory.deleted refetches health and clears 删除中 once the problem is gone', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: ['delete_pending:n_a'] },
      'memory.list': { items: [item('n_a')] },
    } })
    render(<Items />)
    await screen.findByText('删除中')
    f.script({ 'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] } })
    await act(async () => { f.emit(ev('memory.deleted', { id: 'n_a', rawSeqs: [] })) })
    await waitFor(() => expect(screen.queryByText('删除中')).toBeNull())
  })

  it('checking a row then switching the layer clears the selection: 删除所选 disappears, not sent for an off-screen id', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': { items: [item('n_a')] },
    } })
    render(<Items />)
    await screen.findByText('text of n_a')
    fireEvent.click(screen.getByLabelText('选择 n_a'))
    expect(screen.getByRole('button', { name: '删除所选 1' })).toBeInTheDocument()
    f.script({ 'memory.list': { items: [] } })
    fireEvent.change(screen.getByLabelText('层'), { target: { value: 'raw' } })
    await waitFor(() => expect(screen.queryByText('text of n_a')).toBeNull())
    expect(screen.queryByRole('button', { name: /删除所选/ })).toBeNull()
  })

  it('checking a row then searching clears the selection', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': { items: [item('n_a')] },
      'memory.search': { items: [item('r_1', { layer: 'raw', text: 'found it' })] },
    } })
    render(<Items />)
    await screen.findByText('text of n_a')
    fireEvent.click(screen.getByLabelText('选择 n_a'))
    expect(screen.getByRole('button', { name: '删除所选 1' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'it' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await screen.findByText('found it')
    expect(screen.queryByRole('button', { name: /删除所选/ })).toBeNull()
  })

  it('a reset (event stream dropped and reconnected) clears the selection along with the list', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': { items: [item('n_a')] },
    } })
    render(<Items />)
    await screen.findByText('text of n_a')
    fireEvent.click(screen.getByLabelText('选择 n_a'))
    expect(screen.getByRole('button', { name: '删除所选 1' })).toBeInTheDocument()
    f.script({ 'memory.list': { items: [] } })
    await act(async () => { f.alert({ kind: 'reset' }) })
    await waitFor(() => expect(screen.queryByText('text of n_a')).toBeNull())
    expect(screen.queryByRole('button', { name: /删除所选/ })).toBeNull()
  })

  it('a -32603 "memory is unavailable" on the list shows 不支持, same as -32601', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': () => fail(-32603, 'memory is unavailable'),
    } })
    render(<Items />)
    await screen.findByText('不支持')
  })

  it('a -32603 "memory is unavailable" on memory.search shows 不支持', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': { items: [] },
      'memory.search': () => fail(-32603, 'memory is unavailable'),
    } })
    render(<Items />)
    await waitFor(() => expect(f.callsOf('memory.list')).toHaveLength(1))
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await screen.findByText('不支持')
  })

  it('a -32603 "memory is unavailable" on memory.deleteMany shows 不支持', async () => {
    f = installFakeForge({ calls: {
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
      'memory.list': { items: [item('n_a')] },
      'memory.deleteMany': () => fail(-32603, 'memory is unavailable'),
    } })
    render(<Items />)
    await screen.findByText('text of n_a')
    fireEvent.click(screen.getByLabelText('选择 n_a'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除所选 1' })) })
    await screen.findByText('不支持')
  })
})
