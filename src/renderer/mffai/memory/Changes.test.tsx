import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { MemoryChange } from '@mffai/protocol'
import { Changes } from './Changes'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'

let f: FakeForge

const change = (id: string, patch: Partial<MemoryChange> = {}): MemoryChange => ({
  ts: 1700000000000, id, op: 'update', source: 'user', ...patch,
})

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

describe('Changes', () => {
  it('lists changes: file, op, source; collapsed by default', async () => {
    f = installFakeForge({ calls: { 'memory.changes': { items: [change('c1', { file: 'MEMORY.md', before: 'old', after: 'new' })] } } })
    render(<Changes />)
    expect(await screen.findByText('MEMORY.md')).toBeInTheDocument()
    expect(screen.getByText('update')).toBeInTheDocument()
    expect(screen.getByText('user')).toBeInTheDocument()
    expect(screen.queryByText('old')).toBeNull()
    expect(screen.queryByText('new')).toBeNull()
  })

  it('expanding a row shows before/after; collapsing hides it again', async () => {
    f = installFakeForge({ calls: { 'memory.changes': { items: [change('c1', { file: 'MEMORY.md', before: 'old text', after: 'new text' })] } } })
    render(<Changes />)
    const btn = await screen.findByRole('button', { expanded: false })
    fireEvent.click(btn)
    expect(await screen.findByText('old text')).toBeInTheDocument()
    expect(screen.getByText('new text')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(screen.queryByText('old text')).toBeNull()
  })

  it('a null before (an add) and a null after (a removal) render as empty, not the text null', async () => {
    f = installFakeForge({ calls: { 'memory.changes': { items: [change('c1', { file: 'MEMORY.md', before: null, after: 'new' })] } } })
    render(<Changes />)
    fireEvent.click(await screen.findByRole('button'))
    expect(screen.queryByText('null')).toBeNull()
    expect(screen.getByText('new')).toBeInTheDocument()
  })

  it('-32601 shows 不支持', async () => {
    f = installFakeForge({ calls: { 'memory.changes': () => fail(-32601) } })
    render(<Changes />)
    await screen.findByText('不支持')
  })

  it('a generic failure shows 失败', async () => {
    f = installFakeForge({ calls: { 'memory.changes': () => fail(-32603, 'boom') } })
    render(<Changes />)
    await screen.findByText('失败')
  })
})
