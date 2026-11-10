import { describe, it, expect, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import DebugPage from './DebugPage'
import { installFakeForge, type FakeForge } from '../test/fakeForge'
import { ev, redacted, resetSeq, userMsg } from '../test/events'

let f: FakeForge
beforeEach(() => {
  resetSeq()
  const events = [
    userMsg('s1', 't1', 'hello one'),
    ev('memory.injected', { turnId: 't1', kind: 'session', text: 'MEM-FULL-TEXT', items: ['n_a'], truncated: true }, { sessionId: 's1' }),
    ev('plugins.injected', { turnId: 't1', text: 'SKILL-TEXT', skill: true, mcp: false }, { sessionId: 's1' }),
    userMsg('s2', 't2', 'hello two'),
    ev('memory.injected', { turnId: 't2', kind: 'turn', text: 'MEM-S2', items: [] }, { sessionId: 's2' }),
  ]
  f = installFakeForge({
    calls: {
      'events.tail': { events },
      'session.list': { sessions: [] },
      status: { state: 'running', uptimeMs: 1, rssMb: 1, version: '0.1.0', plugins: [
        { id: 'loop-default', state: 'active' }, { id: 'broken', state: 'failed', error: 'boom at load' }, { id: 'mine', state: 'active', trust: 'dev' },
      ], problems: ['dev_crashed'] },
      'plugins.list': { plugins: [], dev: [], problems: ['store_corrupt'] },
    },
  })
})

const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))
const rawRows = () => within(screen.getByRole('listbox', { name: '事件' })).queryAllByRole('option')

describe('DebugPage', () => {
  it('opens on the existing panel', async () => {
    render(<DebugPage />)
    expect(await screen.findByText('发送')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '面板' }).getAttribute('aria-selected')).toBe('true')
  })

  it('page chrome: underline tabs and the three filters share one head row; the events live in a card', async () => {
    render(<DebugPage />)
    const root = document.querySelector('.mffai-debugpage') as HTMLElement
    expect(root).not.toBeNull()
    tab('注入')
    const sel = await screen.findByLabelText('会话')
    const head = sel.closest('.mffai-debughead') as HTMLElement
    expect(within(head).getByRole('tablist')).toBeInTheDocument()
    expect(within(head).getByLabelText('轮')).toBeInTheDocument()
    expect(within(head).getByLabelText('事件类型')).toBeInTheDocument()
    expect((await screen.findByText('MEM-FULL-TEXT')).closest('.mffai-card')).not.toBeNull()
    tab('原始')
    expect((await screen.findByRole('listbox', { name: '事件' })).closest('.mffai-card')).not.toBeNull()
  })

  it('注入: each memory.injected and plugins.injected in full, truncated marked', async () => {
    render(<DebugPage />)
    tab('注入')
    expect(await screen.findByText('MEM-FULL-TEXT')).toBeInTheDocument()
    expect(screen.getByText('SKILL-TEXT')).toBeInTheDocument()
    expect(screen.getByText('MEM-S2')).toBeInTheDocument()
    const card = screen.getByText('MEM-FULL-TEXT').closest('.mffai-inject')!
    expect(within(card as HTMLElement).getByText('已截断')).toBeInTheDocument()
    expect(within(screen.getByText('MEM-S2').closest('.mffai-inject') as HTMLElement).queryByText('已截断')).toBeNull()
  })

  it('filters: session, then turn, then event types', async () => {
    render(<DebugPage />)
    tab('注入')
    await screen.findByText('MEM-S2')
    fireEvent.change(screen.getByLabelText('会话'), { target: { value: 's1' } })
    expect(screen.queryByText('MEM-S2')).toBeNull()
    expect(screen.getByText('MEM-FULL-TEXT')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('轮'), { target: { value: 't1' } })
    expect(screen.getByText('SKILL-TEXT')).toBeInTheDocument()
    const types = screen.getByLabelText('事件类型') as HTMLSelectElement
    for (const o of types.options) o.selected = o.value === 'plugins.injected'
    fireEvent.change(types)
    expect(screen.queryByText('MEM-FULL-TEXT')).toBeNull()
    expect(screen.getByText('SKILL-TEXT')).toBeInTheDocument()
  })

  it('插件: status.plugins with error and trust, status.problems, plugins.list problems', async () => {
    render(<DebugPage />)
    tab('插件')
    expect(await screen.findByText('broken')).toBeInTheDocument()
    expect(screen.getByText('boom at load')).toBeInTheDocument()
    expect(screen.getByText('完全访问')).toBeInTheDocument()
    expect(screen.getByText('dev_crashed')).toBeInTheDocument()
    expect(await screen.findByText('store_corrupt')).toBeInTheDocument()
  })

  it('原始: pick an event, see its JSON; live events arrive', async () => {
    render(<DebugPage />)
    tab('原始')
    await waitFor(() => expect(rawRows()).toHaveLength(5))
    fireEvent.click(rawRows()[0])
    const pre = document.querySelector('.mffai-raw pre')!
    expect(JSON.parse(pre.textContent!)).toMatchObject({ type: 'message.user', sessionId: 's1', payload: { text: 'hello one' } })
    act(() => f.emit(userMsg('s3', 't3', 'live')))
    await waitFor(() => expect(rawRows()).toHaveLength(6))
  })

  it('redaction reaches the raw view: a seq shows [已删除], a session drops out', async () => {
    render(<DebugPage />)
    tab('原始')
    await waitFor(() => expect(rawRows()).toHaveLength(5))
    fireEvent.click(rawRows()[0])
    act(() => f.emit(redacted({ seqs: [1] })))
    await waitFor(() => expect(document.querySelector('.mffai-raw pre')!.textContent).toContain('[已删除]'))
    expect(document.body.innerHTML).not.toContain('hello one')
    act(() => f.emit(redacted({ session: 's2' })))
    await waitFor(() => expect(document.body.innerHTML).not.toContain('hello two'))
    expect(document.body.innerHTML).not.toContain('MEM-S2')
  })
})
