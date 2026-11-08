import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { MemoryHabit } from '@mffai/protocol'
import { Habits } from './Habits'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'

let f: FakeForge

const habit = (id: string, patch: Partial<MemoryHabit> = {}): MemoryHabit => ({
  id, kind: 'routine', weekday: 1, hour: 9, cwd: '/repo', status: 'detected', ...patch,
})

beforeEach(() => {
  resetSeq()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('Habits', () => {
  it('lists habits: weekday/hour/cwd text and status', async () => {
    f = installFakeForge({ calls: { 'memory.habits.list': { items: [habit('h1')] } } })
    render(<Habits />)
    expect(await screen.findByText('周一 9 点 · /repo')).toBeInTheDocument()
    expect(screen.getByText('待确认')).toBeInTheDocument()
  })

  it('confirm and dismiss buttons only show for detected habits', async () => {
    f = installFakeForge({ calls: { 'memory.habits.list': { items: [habit('h1', { status: 'confirmed' })] } } })
    render(<Habits />)
    await screen.findByText('已确认')
    expect(screen.queryByRole('button', { name: '确认' })).toBeNull()
    expect(screen.queryByRole('button', { name: '忽略' })).toBeNull()
  })

  it('confirming a habit reloads the list', async () => {
    f = installFakeForge({ calls: {
      'memory.habits.list': { items: [habit('h1')] },
      'memory.habits.decide': { ok: true },
    } })
    render(<Habits />)
    await screen.findByText('待确认')
    f.script({ 'memory.habits.list': { items: [habit('h1', { status: 'confirmed' })] } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认' })) })
    expect(f.callsOf('memory.habits.decide')).toEqual([{ commandId: expect.any(String), id: 'h1', decision: 'confirmed' }])
    await screen.findByText('已确认')
  })

  it('dismissing a habit sends decision dismissed', async () => {
    f = installFakeForge({ calls: {
      'memory.habits.list': { items: [habit('h1')] },
      'memory.habits.decide': { ok: true },
    } })
    render(<Habits />)
    await screen.findByText('待确认')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '忽略' })) })
    expect(f.callsOf('memory.habits.decide')).toEqual([{ commandId: expect.any(String), id: 'h1', decision: 'dismissed' }])
  })

  it('a failed decide keeps the row and shows 失败 on it', async () => {
    f = installFakeForge({ calls: {
      'memory.habits.list': { items: [habit('h1')] },
      'memory.habits.decide': () => fail(-32603, 'boom'),
    } })
    render(<Habits />)
    await screen.findByText('待确认')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认' })) })
    expect(within(document.querySelector('[data-habit="h1"]') as HTMLElement).getByText('失败')).toBeInTheDocument()
  })

  it('toggling 主动推荐 sends memory.recommendations.set with the new value', async () => {
    f = installFakeForge({ calls: { 'memory.habits.list': { items: [] }, 'memory.recommendations.set': { ok: true } } })
    render(<Habits />)
    await waitFor(() => expect(f.callsOf('memory.habits.list')).toHaveLength(1))
    const sw = screen.getByRole('switch', { name: '主动推荐' })
    expect(sw).not.toBeChecked()
    await act(async () => { fireEvent.click(sw) })
    expect(f.callsOf('memory.recommendations.set')).toEqual([{ commandId: expect.any(String), routine: true }])
    expect(sw).toBeChecked()
  })

  it('-32601 on the list shows 不支持', async () => {
    f = installFakeForge({ calls: { 'memory.habits.list': () => fail(-32601) } })
    render(<Habits />)
    await screen.findByText('不支持')
  })

  it('a -32603 "memory is unavailable" on the list shows 不支持, same as -32601', async () => {
    f = installFakeForge({ calls: { 'memory.habits.list': () => fail(-32603, 'memory is unavailable') } })
    render(<Habits />)
    await screen.findByText('不支持')
  })

  it('a -32603 "memory is unavailable" on toggling 主动推荐 shows 不支持', async () => {
    f = installFakeForge({ calls: { 'memory.habits.list': { items: [] }, 'memory.recommendations.set': () => fail(-32603, 'memory is unavailable') } })
    render(<Habits />)
    await waitFor(() => expect(f.callsOf('memory.habits.list')).toHaveLength(1))
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: '主动推荐' })) })
    expect(screen.getByText('不支持')).toBeInTheDocument()
  })

  it('a memory.recommendation event reloads the habits list', async () => {
    f = installFakeForge({ calls: { 'memory.habits.list': { items: [habit('h1')] } } })
    render(<Habits />)
    await screen.findByText('待确认')
    f.script({ 'memory.habits.list': { items: [habit('h1', { status: 'confirmed' })] } })
    await act(async () => { f.emit(ev('memory.recommendation', { id: 'r1', category: 'routine', habitId: 'h1', text: 'x', cwd: '/repo' })) })
    await screen.findByText('已确认')
  })
})
