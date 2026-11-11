import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import TasksPage from './TasksPage'
import { route } from '../route'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'
import { runRow, summary } from '../test/sessions'
import { HeaderSlotCtx } from '../shell/headerSlot'

const dialog = () => screen.getByRole('dialog')
const rows = () => [...dialog().querySelectorAll('.mffai-confirm-row')].map((r) => [...r.querySelectorAll('span')].map((c) => c.textContent))

let f: FakeForge
beforeEach(() => { resetSeq(); route.set({ page: 'chat' }) })
afterEach(() => vi.useRealTimers())

describe('TasksPage', () => {
  it('groups executor.runs into 进行中 (running, then queued) and 已结束, in that order, each with its own rows', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [
        runRow('re', 's1', { phase: 'ended', worktree: { path: '/wt/re', present: true }, changed: 2 }),
        runRow('rq', 's1', { phase: 'queued', worktree: undefined, changed: undefined }),
        runRow('rr', 's1', { phase: 'running', worktree: undefined, changed: undefined }),
      ] },
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [summary('s1', { title: 'one', cwd: '/repo' })] },
    } })
    render(<TasksPage />)
    await screen.findByText('已结束')
    const heads = [...document.querySelectorAll('.mffai-tcard-title')].map((n) => n.textContent)
    expect(heads).toEqual(['进行中', '已结束', 'IM worktree'])
    const order = [...document.querySelectorAll('[data-run]')].map((n) => n.getAttribute('data-run'))
    expect(order).toEqual(['rr', 'rq', 're'])
    const live = document.querySelector('[data-tcard="live"]') as HTMLElement
    expect(live.querySelector('[data-run="rr"]')).not.toBeNull()
    expect(live.querySelector('[data-run="rq"]')).not.toBeNull()
    expect(live.querySelector('[data-run="re"]')).toBeNull()
    expect((document.querySelector('[data-tcard="ended"]') as HTMLElement).querySelector('[data-run="re"]')).not.toBeNull()
  })

  it('a click on a run row session jumps there (route set with sessionId and runId)', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [runRow('r1', 's1', { phase: 'running', worktree: undefined, changed: undefined })] },
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [summary('s1', { title: 'one' })] },
    } })
    render(<TasksPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'one' }))
    expect(route.get()).toEqual({ page: 'chat', sessionId: 's1', runId: 'r1' })
  })

  it('a session not (yet) loaded falls back to showing its id, still clickable', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [runRow('r1', 'ghost', { phase: 'running', worktree: undefined, changed: undefined })] },
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [] },
    } })
    render(<TasksPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'ghost' }))
    expect(route.get().sessionId).toBe('ghost')
  })

  it('worktree bytes formatted; absent when undefined', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [
        runRow('rb', 's1', { phase: 'ended', worktree: { path: '/wt/rb', present: true, bytes: 2048 }, changed: 1 }),
        runRow('ru', 's1', { phase: 'ended', worktree: { path: '/wt/ru', present: true }, changed: 1 }),
      ] },
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [summary('s1')] },
    } })
    render(<TasksPage />)
    await screen.findByText('2 KB')
    expect(document.querySelector('[data-run="ru"]')?.textContent).not.toContain('undefined')
  })

  it('已合并 hides 合并 but keeps 丢弃, for an executor run', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [runRow('rm', 's1', { phase: 'ended', worktree: { path: '/wt/rm', present: true, merged: true }, changed: 3 })] },
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [summary('s1')] },
    } })
    render(<TasksPage />)
    await screen.findByText('已合并')
    const row = document.querySelector('[data-run="rm"]') as HTMLElement
    expect(within(row).queryByRole('button', { name: '合并' })).toBeNull()
    expect(within(row).queryByRole('button', { name: '丢弃' })).not.toBeNull()
  })

  it('执行器 停止 sends executor.cancel for that run; 合并 names the session cwd and sends executor.worktree.merge; 丢弃 sends executor.worktree.discard', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [
        runRow('rs', 's1', { phase: 'running', worktree: undefined, changed: undefined }),
        runRow('re', 's1', { phase: 'ended', worktree: { path: '/wt/re', present: true }, changed: 2 }),
      ] },
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [summary('s1', { cwd: '/repo' })] },
      'executor.cancel': { ok: true },
      'executor.worktree.merge': { ok: true, files: 2 },
      'executor.worktree.discard': { ok: true },
    } })
    render(<TasksPage />)
    fireEvent.click(await screen.findByRole('button', { name: '停止' }))
    await waitFor(() => expect(f.callsOf('executor.cancel')).toEqual([{ commandId: expect.any(String), sessionId: 's1', runId: 'rs' }]))

    const endedRow = document.querySelector('[data-run="re"]') as HTMLElement
    fireEvent.click(within(endedRow).getByRole('button', { name: '合并' }))
    expect(dialog()).toHaveAccessibleName('合并到 /repo')
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '合并' })) })
    expect(f.callsOf('executor.worktree.merge')).toEqual([{ commandId: expect.any(String), sessionId: 's1', runId: 're' }])
    await screen.findByText('已合并')

    fireEvent.click(within(endedRow).getByRole('button', { name: '丢弃' }))
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '丢弃' })) })
    expect(f.callsOf('executor.worktree.discard')).toEqual([{ commandId: expect.any(String), sessionId: 's1', runId: 're' }])
  })

  it('IM worktree group: 改动 opens channel.telegram.worktree.changes/diff; 合并 names the real checkout path (not the project label) and sends channel.telegram.worktree.merge', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [] },
      'channel.telegram.chats': { chats: [], worktrees: [{ id: 'w1', project: 'proj', path: '/im/w1', sessionIds: [], createdAt: 1 }] },
      'session.list': { sessions: [] },
      'channel.telegram.config.get': { enabled: true, staleMinutes: 10, projects: [{ name: 'proj', path: '/checkout/proj', auto: false }] },
      'channel.telegram.worktree.changes': { files: [{ path: 'a.ts', status: 'M' }] },
      'channel.telegram.worktree.diff': { path: 'a.ts', status: 'M', binary: false, truncated: false, lines: [{ kind: 'add', ln: 1, text: 'NEW' }] },
      'channel.telegram.worktree.merge': { ok: true, files: 1 },
    } })
    render(<TasksPage />)
    const row = (await screen.findByText('proj')).closest('[data-worktree]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '改动' }))
    fireEvent.click(await within(row).findByText('a.ts'))
    await within(row).findByText('NEW')

    fireEvent.click(await within(row).findByRole('button', { name: '合并' }))
    expect(dialog()).toHaveAccessibleName('合并到 /checkout/proj')
    expect(rows()).toEqual([['项目', 'proj'], ['worktree', '/im/w1']])
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '合并' })) })
    expect(f.callsOf('channel.telegram.worktree.merge')).toEqual([{ commandId: expect.any(String), worktreeId: 'w1' }])
    await within(row).findByText('已合并')
  })

  it('an IM worktree whose project is not in channel.telegram.config.get has no 合并 button (merge disabled, not a label fallback)', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [] },
      'channel.telegram.chats': { chats: [], worktrees: [
        { id: 'w1', project: 'gone', path: '/im/w1', sessionIds: [], createdAt: 1 },
        { id: 'w2', project: '', path: '/im/w2', sessionIds: [], createdAt: 1 },
      ] },
      'session.list': { sessions: [] },
      'channel.telegram.config.get': { enabled: true, staleMinutes: 10, projects: [{ name: 'other', path: '/checkout/other', auto: false }] },
    } })
    render(<TasksPage />)
    const row1 = (await screen.findByText('gone')).closest('[data-worktree]') as HTMLElement
    await waitFor(() => expect(within(row1).queryByRole('button', { name: '合并' })).toBeNull())
    expect(within(row1).getByRole('button', { name: '丢弃' })).not.toBeNull()
    const row2 = document.querySelector('[data-worktree="w2"]') as HTMLElement
    expect(within(row2).queryByRole('button', { name: '合并' })).toBeNull()
  })

  it('discard confirm for an IM worktree counts sessions whose cwd is inside it (boundary on /), not a sibling with a longer name', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [] },
      'channel.telegram.chats': { chats: [], worktrees: [{ id: 'w1', project: 'p', path: '/root/wt_1', sessionIds: [], createdAt: 1 }] },
      'session.list': { sessions: [
        summary('a', { cwd: '/root/wt_1' }),
        summary('b', { cwd: '/root/wt_1/sub' }),
        summary('c', { cwd: '/root/wt_10/sub' }),
        summary('d', { cwd: '/elsewhere' }),
      ] },
      'channel.telegram.worktree.discard': { ok: true },
    } })
    render(<TasksPage />)
    const row = (await screen.findByText('p')).closest('[data-worktree]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '丢弃' }))
    expect(rows()).toEqual([['路径', '/root/wt_1'], ['在用的会话', '2']])
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '丢弃' })) })
    expect(f.callsOf('channel.telegram.worktree.discard')).toEqual([{ commandId: expect.any(String), worktreeId: 'w1' }])
    await within(row).findByText('已丢弃')
  })

  it('已结束 and IM worktree group titles show N / 20 (worktrees present/listed, not the row count)', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [
        runRow('e1', 's1', { phase: 'ended', worktree: { path: '/wt/e1', present: true }, changed: 1 }),
        runRow('e2', 's1', { phase: 'ended', worktree: undefined, changed: undefined }),
      ] },
      'channel.telegram.chats': { chats: [], worktrees: [
        { id: 'w1', project: 'p', path: '/im/w1', sessionIds: [], createdAt: 1 },
        { id: 'w2', project: 'p', path: '/im/w2', sessionIds: [], createdAt: 1 },
      ] },
      'session.list': { sessions: [summary('s1')] },
    } })
    render(<TasksPage />)
    await screen.findByText('1 / 20')
    await screen.findByText('2 / 20')
  })

  it('已结束 counts every present worktree, including a running run that still holds one (same 20-slot pool)', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [
        runRow('e1', 's1', { phase: 'ended', worktree: { path: '/wt/e1', present: true }, changed: 1 }),
        runRow('r1', 's1', { phase: 'running', worktree: { path: '/wt/r1', present: true } }),
      ] },
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [summary('s1')] },
    } })
    render(<TasksPage />)
    await screen.findByText('2 / 20')
  })

  it('executor.runs answering -32601 shows 不支持 in place of the three groups', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': () => fail(-32601),
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [] },
    } })
    render(<TasksPage />)
    await screen.findByText('不支持')
    expect(screen.queryByText('运行中')).toBeNull()
    // 不支持是一枚 chip,不是横贯整组的条:组里直接放的 chip 不被拉伸
    expect(screen.getByText('不支持').parentElement!.classList.contains('mffai-tgroup')).toBe(true)
    const css = readFileSync(resolve(__dirname, '../styles/pages.css'), 'utf8')
    expect(css).toMatch(/\.mffai-tgroup > \.mffai-chip \{[^}]*align-self: flex-start/)
  })

  it('channel.telegram.chats answering -32601 shows 不支持 for the IM worktree group only', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [] },
      'channel.telegram.chats': () => fail(-32601),
      'session.list': { sessions: [] },
    } })
    render(<TasksPage />)
    await screen.findByText('IM worktree')
    await screen.findByText('不支持')
  })

  it('five executor.run.* / worktree-merged events within 300 ms cause one reload', async () => {
    vi.useFakeTimers()
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [] },
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [] },
    } })
    render(<TasksPage />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(f.callsOf('executor.runs')).toHaveLength(1)
    act(() => {
      f.emit(ev('executor.run.queued', { runId: 'r', turnId: 't', callId: 'c', executor: 'codex', summary: 's', readOnly: false, isolation: 'none', position: 0 }, { sessionId: 's1' }))
      f.emit(ev('executor.run.started', { runId: 'r', turnId: 't', executor: 'codex', cwd: '/x', isolation: 'none' }, { sessionId: 's1' }))
      f.emit(ev('executor.run.progress', { runId: 'r', turnId: 't', kind: 'text', text: 'x' }, { sessionId: 's1' }))
      f.emit(ev('executor.worktree.merged', { runId: 'r', files: 1 }, { sessionId: 's1' }))
      f.emit(ev('channel.worktree.merged', { worktreeId: 'w', files: 1 }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(299) })
    expect(f.callsOf('executor.runs')).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(f.callsOf('executor.runs')).toHaveLength(2)
  })

  it('the executor merge confirm carries the 文件 row, as RunCard does', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [runRow('re', 's1', { phase: 'ended', worktree: { path: '/wt/re', present: true }, changed: 3 })] },
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [summary('s1', { cwd: '/repo' })] },
    } })
    render(<TasksPage />)
    const row = (await screen.findByText('3 个文件')).closest('[data-run]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '合并' }))
    expect(rows()).toEqual([['worktree', '/wt/re'], ['文件', '3']])
  })

  it('a reset alert refetches at once', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [] },
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [] },
    } })
    render(<TasksPage />)
    await waitFor(() => expect(f.callsOf('executor.runs')).toHaveLength(1))
    act(() => f.alert({ kind: 'reset' }))
    await waitFor(() => expect(f.callsOf('executor.runs')).toHaveLength(2))
  })

  it('the header slot gets N 运行中 (run chip with a dot) and N 排队 from the runs the page holds', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [
        runRow('a', 's1', { phase: 'running', worktree: undefined, changed: undefined }),
        runRow('b', 's1', { phase: 'running', worktree: undefined, changed: undefined }),
        runRow('c', 's1', { phase: 'queued', worktree: undefined, changed: undefined }),
        runRow('d', 's1', { phase: 'ended', worktree: undefined, changed: undefined }),
      ] },
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [summary('s1')] },
    } })
    const slot = document.createElement('div')
    document.body.append(slot)
    render(<HeaderSlotCtx.Provider value={slot}><TasksPage /></HeaderSlotCtx.Provider>)
    await waitFor(() => expect(slot).toHaveTextContent('2 运行中'))
    expect(slot).toHaveTextContent('1 排队')
    expect(within(slot).getByText('2 运行中')).toHaveClass('run', 'dot')
    slot.remove()
  })

  it('an unsupported executor.runs puts no counts in the header slot', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': () => fail(-32601),
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [] },
    } })
    const slot = document.createElement('div')
    document.body.append(slot)
    render(<HeaderSlotCtx.Provider value={slot}><TasksPage /></HeaderSlotCtx.Provider>)
    await screen.findByText('不支持')
    expect(slot.textContent).toBe('')
    slot.remove()
  })

  it('已结束 shows the worktree chip, one title per card with a count, and the rows carry logo tile, session link, status chip, 耗时, 改动, size', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [runRow('re', 's1', { phase: 'ended', status: 'failed', reason: 'timeout', ms: 1500, worktree: { path: '/wt/re', present: true, bytes: 3 * 1024 * 1024 }, changed: 4 })] },
      'channel.telegram.chats': { chats: [], worktrees: [] },
      'session.list': { sessions: [summary('s1', { title: 'one' })] },
    } })
    render(<TasksPage />)
    const row = (await screen.findByText('4 个文件')).closest('[data-run]') as HTMLElement
    expect(row.querySelector('.mffai-rlogo')).not.toBeNull()
    expect(within(row).getByRole('button', { name: 'one' })).toHaveClass('mffai-tlink')
    expect(within(row).getByText('timeout')).toBeInTheDocument()
    expect(within(row).getByText('00:01')).toBeInTheDocument()
    expect(within(row).getByText('3.0 MB')).toBeInTheDocument()
    expect(document.querySelector('[data-tcard="ended"] .mffai-chip')).toHaveTextContent('worktree 1 / 20')
    expect(within(row).getByRole('button', { name: '合并' })).toHaveClass('mffai-primary')
    expect(within(row).getByRole('button', { name: '丢弃' })).toHaveClass('mffai-danger')
  })

  it('merge and discard confirms are anchored to the clicked button (the overlay is the anchored one once the button can be measured)', async () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 10, left: 10, top: 10, right: 90, bottom: 40, width: 80, height: 30, toJSON: () => ({}) } as DOMRect)
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [runRow('re', 's1', { phase: 'ended', worktree: { path: '/wt/re', present: true }, changed: 1 })] },
      'channel.telegram.chats': { chats: [], worktrees: [{ id: 'w1', project: 'proj', path: '/im/w1', sessionIds: [], createdAt: 1 }] },
      'session.list': { sessions: [summary('s1', { cwd: '/repo' })] },
      'channel.telegram.config.get': { enabled: true, staleMinutes: 10, projects: [{ name: 'proj', path: '/checkout/proj', auto: false }] },
    } })
    render(<TasksPage />)
    const run = (await screen.findByText('1 个文件')).closest('[data-run]') as HTMLElement
    const wt = (await screen.findByText('proj')).closest('[data-worktree]') as HTMLElement
    await within(wt).findByRole('button', { name: '合并' })
    for (const [scope, name] of [[run, '合并'], [run, '丢弃'], [wt, '合并'], [wt, '丢弃']] as const) {
      fireEvent.click(within(scope).getByRole('button', { name }))
      expect(dialog().closest('.confirm-overlay')).toHaveClass('mffai-anchored')
      fireEvent.click(within(dialog()).getByRole('button', { name: '取消' }))
    }
    rect.mockRestore()
  })

  it('IM worktree card: project, path with copy, 在用 chip, size; 改动 stays a toggle', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [] },
      'channel.telegram.chats': { chats: [], worktrees: [{ id: 'w1', project: 'proj', path: '/im/w1', sessionIds: [], createdAt: 1, bytes: 2048, usedByChat: '7' }] },
      'session.list': { sessions: [] },
    } })
    render(<TasksPage />)
    const row = (await screen.findByText('proj')).closest('[data-worktree]') as HTMLElement
    expect(row.closest('[data-tcard="im"]')).not.toBeNull()
    expect(within(row).getByText('/im/w1')).toBeInTheDocument()
    expect(within(row).getByText('2 KB')).toBeInTheDocument()
    expect(within(row).getByText('7')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '改动' })).toHaveAttribute('aria-expanded', 'false')
  })
})
