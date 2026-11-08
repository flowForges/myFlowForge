import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { MemoryProposal } from '@mffai/protocol'
import { Proposals } from './Proposals'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'

let f: FakeForge

const proposal = (id: string, patch: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id, target: 'MEMORY.md', op: 'add', text: `proposed ${id}`, evidence: [], source: 'extract', flags: [],
  status: 'pending', createdAt: 1, ...patch,
})

beforeEach(() => {
  resetSeq()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('Proposals', () => {
  it('lists pending proposals: target, op, source, flags, editable text', async () => {
    f = installFakeForge({ calls: {
      'memory.proposals.list': { items: [proposal('p1', { source: 'model', flags: ['pii'] })] },
    } })
    render(<Proposals onJumpToFile={() => {}} />)
    expect(await screen.findByText('MEMORY.md')).toBeInTheDocument()
    expect(screen.getByText('新增')).toBeInTheDocument()
    expect(screen.getByText('模型')).toBeInTheDocument()
    expect(screen.getByText('pii')).toBeInTheDocument()
    expect(f.callsOf('memory.proposals.list')).toEqual([{ status: 'pending' }])
    expect(screen.getByLabelText<HTMLTextAreaElement>('文字 p1').value).toBe('proposed p1')
  })

  it('a replace proposal shows the replaced original text via memory.get', async () => {
    f = installFakeForge({ calls: {
      'memory.proposals.list': { items: [proposal('p1', { op: 'replace', replaces: 'n_old' })] },
      'memory.get': { id: 'n_old', layer: 'memory', text: 'the old line' },
    } })
    render(<Proposals onJumpToFile={() => {}} />)
    expect(await screen.findByText('替换')).toBeInTheDocument()
    expect(await screen.findByText('the old line')).toBeInTheDocument()
  })

  it('evidence ids each fetch their quote via memory.get', async () => {
    f = installFakeForge({ calls: {
      'memory.proposals.list': { items: [proposal('p1', { evidence: ['r_1', 'r_2'] })] },
      'memory.get': (p: { id: string }) => ({ id: p.id, layer: 'raw', text: `quote of ${p.id}` }),
    } })
    render(<Proposals onJumpToFile={() => {}} />)
    expect(await screen.findByText('quote of r_1')).toBeInTheDocument()
    expect(await screen.findByText('quote of r_2')).toBeInTheDocument()
  })

  it('approving sends the edited text; a successful decide reloads the list', async () => {
    f = installFakeForge({ calls: {
      'memory.proposals.list': { items: [proposal('p1')] },
      'memory.proposals.decide': { ok: true },
    } })
    render(<Proposals onJumpToFile={() => {}} />)
    const box = await screen.findByLabelText('文字 p1')
    fireEvent.change(box, { target: { value: 'edited text' } })
    f.script({ 'memory.proposals.list': { items: [] } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '批准' })) })
    expect(f.callsOf('memory.proposals.decide')).toEqual([{ commandId: expect.any(String), id: 'p1', decision: 'approve', text: 'edited text' }])
    await waitFor(() => expect(screen.queryByText('MEMORY.md')).toBeNull())
  })

  it('rejecting does not send a text field', async () => {
    f = installFakeForge({ calls: {
      'memory.proposals.list': { items: [proposal('p1')] },
      'memory.proposals.decide': { ok: true },
    } })
    render(<Proposals onJumpToFile={() => {}} />)
    await screen.findByText('MEMORY.md')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '驳回' })) })
    expect(f.callsOf('memory.proposals.decide')).toEqual([{ commandId: expect.any(String), id: 'p1', decision: 'reject' }])
  })

  it('an over-cap approve (ERR_INVALID full) shows 已满 and 去编辑, which jumps to the target file', async () => {
    f = installFakeForge({ calls: {
      'memory.proposals.list': { items: [proposal('p1', { target: 'USER.md' })] },
      'memory.proposals.decide': () => fail(-32602, 'full'),
    } })
    const onJumpToFile = vi.fn()
    render(<Proposals onJumpToFile={onJumpToFile} />)
    await screen.findByText('USER.md')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '批准' })) })
    expect(await screen.findByText('已满')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '去编辑' }))
    expect(onJumpToFile).toHaveBeenCalledWith('USER.md')
  })

  it('-32601 on the list shows 不支持', async () => {
    f = installFakeForge({ calls: { 'memory.proposals.list': () => fail(-32601) } })
    render(<Proposals onJumpToFile={() => {}} />)
    await screen.findByText('不支持')
  })

  it('a -32603 "memory is unavailable" on the list shows 不支持, same as -32601', async () => {
    f = installFakeForge({ calls: { 'memory.proposals.list': () => fail(-32603, 'memory is unavailable') } })
    render(<Proposals onJumpToFile={() => {}} />)
    await screen.findByText('不支持')
  })

  it('a -32603 "memory is unavailable" on decide shows 不支持 on that row', async () => {
    f = installFakeForge({ calls: {
      'memory.proposals.list': { items: [proposal('p1')] },
      'memory.proposals.decide': () => fail(-32603, 'memory is unavailable'),
    } })
    render(<Proposals onJumpToFile={() => {}} />)
    await screen.findByText('MEMORY.md')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '批准' })) })
    expect(within(document.querySelector('[data-proposal="p1"]') as HTMLElement).getByText('不支持')).toBeInTheDocument()
  })

  it('a generic decide failure shows 失败 and keeps the row', async () => {
    f = installFakeForge({ calls: {
      'memory.proposals.list': { items: [proposal('p1')] },
      'memory.proposals.decide': () => fail(-32603, 'boom'),
    } })
    render(<Proposals onJumpToFile={() => {}} />)
    await screen.findByText('MEMORY.md')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '批准' })) })
    expect(within(document.querySelector('[data-proposal="p1"]') as HTMLElement).getByText('失败')).toBeInTheDocument()
  })

  it('memory.proposal and memory.updated events reload the list', async () => {
    f = installFakeForge({ calls: { 'memory.proposals.list': { items: [proposal('p1')] } } })
    render(<Proposals onJumpToFile={() => {}} />)
    await screen.findByText('MEMORY.md')
    f.script({ 'memory.proposals.list': { items: [] } })
    await act(async () => { f.emit(ev('memory.proposal', { id: 'p1', target: 'MEMORY.md', status: 'approved' })) })
    await waitFor(() => expect(screen.queryByText('MEMORY.md')).toBeNull())
  })

  it('two clicks in one frame decide once (ref guard against double submit)', async () => {
    f = installFakeForge({ calls: {
      'memory.proposals.list': { items: [proposal('p1')] },
      'memory.proposals.decide': () => new Promise<never>(() => {}),
    } })
    render(<Proposals onJumpToFile={() => {}} />)
    await screen.findByText('MEMORY.md')
    const btn = screen.getByRole('button', { name: '批准' })
    act(() => { btn.click(); btn.click() })
    expect(f.callsOf('memory.proposals.decide')).toHaveLength(1)
  })
})
