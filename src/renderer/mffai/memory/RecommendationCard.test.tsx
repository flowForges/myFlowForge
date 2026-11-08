import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { RecommendationCard } from './RecommendationCard'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'
import { route } from '../route'

let f: FakeForge

beforeEach(() => {
  resetSeq()
  route.set({ page: 'chat' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('RecommendationCard', () => {
  it('renders nothing until a memory.recommendation event arrives', () => {
    f = installFakeForge({})
    const { container } = render(<RecommendationCard />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the recommendation text once the event arrives', () => {
    f = installFakeForge({})
    render(<RecommendationCard />)
    act(() => { f.emit(ev('memory.recommendation', { id: 'rec1', category: 'routine', habitId: 'h1', text: '每周一 9 点你常在 repo 工作', cwd: '/repo' })) })
    expect(screen.getByText('每周一 9 点你常在 repo 工作')).toBeInTheDocument()
  })

  it('开会话 sets the chat route to a new session prefilled with the recommended cwd, and dismisses the card', () => {
    f = installFakeForge({})
    render(<RecommendationCard />)
    act(() => { f.emit(ev('memory.recommendation', { id: 'rec1', category: 'routine', habitId: 'h1', text: 'x', cwd: '/repo' })) })
    fireEvent.click(screen.getByRole('button', { name: '开会话' }))
    expect(route.get()).toEqual({ page: 'chat', newSession: { cwd: '/repo' } })
    expect(screen.queryByText('x')).toBeNull()
  })

  it('不再提 sends memory.habits.decide dismissed for the habitId and removes the card on success', async () => {
    f = installFakeForge({ calls: { 'memory.habits.decide': { ok: true } } })
    render(<RecommendationCard />)
    act(() => { f.emit(ev('memory.recommendation', { id: 'rec1', category: 'routine', habitId: 'h1', text: 'x', cwd: '/repo' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '不再提' })) })
    expect(f.callsOf('memory.habits.decide')).toEqual([{ commandId: expect.any(String), id: 'h1', decision: 'dismissed' }])
    expect(screen.queryByText('x')).toBeNull()
  })

  it('a failed 不再提 keeps the card and shows 失败', async () => {
    f = installFakeForge({ calls: { 'memory.habits.decide': () => fail(-32603, 'boom') } })
    render(<RecommendationCard />)
    act(() => { f.emit(ev('memory.recommendation', { id: 'rec1', category: 'routine', habitId: 'h1', text: 'x', cwd: '/repo' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '不再提' })) })
    expect(screen.getByText('x')).toBeInTheDocument()
    expect(screen.getByText('失败')).toBeInTheDocument()
  })

  it('two recommendations with different ids both show; a duplicate id is not added twice', () => {
    f = installFakeForge({})
    render(<RecommendationCard />)
    act(() => {
      f.emit(ev('memory.recommendation', { id: 'rec1', category: 'routine', habitId: 'h1', text: 'first', cwd: '/a' }))
      f.emit(ev('memory.recommendation', { id: 'rec2', category: 'routine', habitId: 'h2', text: 'second', cwd: '/b' }))
      f.emit(ev('memory.recommendation', { id: 'rec1', category: 'routine', habitId: 'h1', text: 'first', cwd: '/a' }))
    })
    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '开会话' })).toHaveLength(2)
  })
})
