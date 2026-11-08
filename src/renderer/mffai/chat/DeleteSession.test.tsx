import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DeleteSession } from './DeleteSession'
import { route } from '../route'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'
import { runRow, summary } from '../test/sessions'

let f: FakeForge
beforeEach(() => { resetSeq(); route.set({ page: 'chat' }) })

const confirmRows = () => [...document.querySelectorAll('.mffai-confirm-row')].map((r) => [...r.children].filter((c) => c.tagName === 'SPAN').map((c) => c.textContent))
const okBtn = () => screen.getByRole('dialog').querySelector('.confirm-danger') as HTMLButtonElement

const present = (path: string) => ({ path, present: true })
const retained = [
  runRow('r1', 's1', { worktree: present('/w/r1'), changed: 0 }),
  runRow('r2', 's1', { worktree: present('/w/r2'), changed: 2, executor: 'claude' }),
  runRow('gone', 's1', { worktree: { path: '/w/g', present: false }, changed: 5 }),
  runRow('merged', 's1', { worktree: { path: '/w/m', present: true, merged: true }, changed: 5 }),
  runRow('other', 's2', { worktree: present('/w/o'), changed: 3 }),
]

function mount(s = summary('s1', { title: '修 bug' })) {
  const onClose = vi.fn(), onDeleted = vi.fn()
  render(<DeleteSession session={s} onClose={onClose} onDeleted={onDeleted} />)
  return { onClose, onDeleted }
}

describe('DeleteSession', () => {
  it('rows: the session, retained worktrees from executor.runs, the always-kept references row; no unmerged -> 删除 without the flag', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [runRow('r1', 's1', { worktree: present('/w/r1'), changed: 0 }), runRow('r9', 's1', { worktree: present('/w/r9') }), runRow('other', 's2', { worktree: present('/w/o'), changed: 3 })] },
      'session.delete': { ok: true, redacted: 3, notes: [] },
    } })
    const p = mount()
    await waitFor(() => expect(confirmRows()).toEqual([['会话', '修 bug'], ['保留的 worktree', '2'], ['别的会话里的引用', '保留']]))
    expect(screen.getByRole('dialog')).toHaveAccessibleName('删除会话')
    expect(okBtn().textContent).toBe('删除')
    await act(async () => { fireEvent.click(okBtn()) })
    const sent = f.callsOf('session.delete') as any[]
    expect(sent).toHaveLength(1)
    expect(sent[0].sessionId).toBe('s1')
    expect(typeof sent[0].commandId).toBe('string')
    expect('discardUnmerged' in sent[0]).toBe(false)
    expect(p.onDeleted).toHaveBeenCalledWith([])
  })

  it('one unmerged run: the 未合并的改动 row, a run row with 去合并, 删除并丢弃改动 sends exactly that run id', async () => {
    f = installFakeForge({ calls: { 'executor.runs': { runs: retained }, 'session.delete': { ok: true, redacted: 1, notes: ['n_x'] } } })
    const p = mount()
    await waitFor(() => expect(okBtn().textContent).toBe('删除并丢弃改动'))
    expect(confirmRows()).toEqual([
      ['会话', '修 bug'], ['保留的 worktree', '3'], ['未合并的改动', '2 个文件'], ['', 'claude · 2 个文件'], ['别的会话里的引用', '保留'],
    ])
    expect(screen.getAllByRole('button', { name: '去合并' })).toHaveLength(1)
    await act(async () => { fireEvent.click(okBtn()) })
    expect((f.callsOf('session.delete')[0] as any).discardUnmerged).toEqual(['r2'])
    expect(p.onDeleted).toHaveBeenCalledWith(['n_x'])
  })

  it('去合并 routes to that run card and closes', async () => {
    f = installFakeForge({ calls: { 'executor.runs': { runs: retained } } })
    const p = mount()
    fireEvent.click(await screen.findByRole('button', { name: '去合并' }))
    expect(route.get()).toEqual({ page: 'chat', sessionId: 's1', runId: 'r2' })
    expect(p.onClose).toHaveBeenCalled()
    expect(f.callsOf('session.delete')).toHaveLength(0)
  })

  it('IM session: 来源 Telegram row', async () => {
    f = installFakeForge({ calls: { 'executor.runs': { runs: [] } } })
    mount(summary('s1', { title: 'tg', origin: 'im' }))
    await waitFor(() => expect(confirmRows()).toContainEqual(['来源', 'Telegram']))
  })

  it('an unmerged refusal redraws from data.runs and does not resend; the next confirm names them', async () => {
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [runRow('r1', 's1', { worktree: present('/w/r1'), changed: 0 })] },
      'session.delete': () => fail(-32602, 'unmerged', { reason: 'unmerged', runs: [{ runId: 'r1', files: 4 }, { runId: 'zz', files: 1 }] }),
    } })
    const p = mount()
    await waitFor(() => expect(okBtn().textContent).toBe('删除'))
    await act(async () => { fireEvent.click(okBtn()) })
    await waitFor(() => expect(okBtn().textContent).toBe('删除并丢弃改动'))
    expect(f.callsOf('session.delete')).toHaveLength(1)
    expect(confirmRows()).toContainEqual(['未合并的改动', '5 个文件'])
    expect(confirmRows()).toContainEqual(['', 'codex · 4 个文件'])
    expect(confirmRows()).toContainEqual(['', 'zz · 1 个文件'])
    expect(p.onDeleted).not.toHaveBeenCalled()
    f.script({ 'session.delete': { ok: true, redacted: 0, notes: [] } })
    await act(async () => { fireEvent.click(okBtn()) })
    expect((f.callsOf('session.delete')[1] as any).discardUnmerged).toEqual(['r1', 'zz'])
    expect(p.onDeleted).toHaveBeenCalled()
  })

  it('-32003 refetches executor.runs and redraws, no resend', async () => {
    let n = 0
    f = installFakeForge({ calls: {
      'executor.runs': () => (++n === 1 ? { runs: [] } : { runs: [runRow('r5', 's1', { worktree: present('/w/r5'), changed: 1 })] }),
      'session.delete': () => fail(-32003, 'busy'),
    } })
    mount()
    await waitFor(() => expect(okBtn().textContent).toBe('删除'))
    await act(async () => { fireEvent.click(okBtn()) })
    await waitFor(() => expect(okBtn().textContent).toBe('删除并丢弃改动'))
    expect(f.callsOf('executor.runs')).toHaveLength(2)
    expect(f.callsOf('session.delete')).toHaveLength(1)
    expect(confirmRows()).toContainEqual(['保留的 worktree', '1'])
  })

  it('a timeout (-32010) then a retry reuses the commandId', async () => {
    let n = 0
    f = installFakeForge({ calls: {
      'executor.runs': { runs: [] },
      'session.delete': () => (++n === 1 ? fail(-32010, 'timeout') : { ok: true, redacted: 0, notes: [] }),
    } })
    const p = mount()
    await waitFor(() => expect(okBtn().disabled).toBe(false))
    await act(async () => { fireEvent.click(okBtn()) })
    expect(await within(screen.getByRole('dialog')).findByText('失败')).toBeInTheDocument()
    await act(async () => { fireEvent.click(okBtn()) })
    const [a, b] = f.callsOf('session.delete') as any[]
    expect(b.commandId).toBe(a.commandId)
    expect(p.onDeleted).toHaveBeenCalled()
  })

  it('executor.runs unsupported: no worktrees, delete still works', async () => {
    f = installFakeForge({ calls: { 'session.delete': { ok: true, redacted: 0, notes: [] } } })
    mount()
    await waitFor(() => expect(confirmRows()).toContainEqual(['保留的 worktree', '0']))
    expect(okBtn().disabled).toBe(false)
  })

  it('the confirm stays disabled until the run list answered', async () => {
    let release!: (v: unknown) => void
    f = installFakeForge({ calls: { 'executor.runs': () => new Promise((r) => { release = r }) as never } })
    mount()
    expect(okBtn().disabled).toBe(true)
    await act(async () => { release({ runs: [] }) })
    expect(okBtn().disabled).toBe(false)
  })

  it('session.deleted refetches the run list (worktree cleanup is async)', async () => {
    f = installFakeForge({ calls: { 'executor.runs': { runs: [] } } })
    mount()
    await waitFor(() => expect(f.callsOf('executor.runs')).toHaveLength(1))
    act(() => f.emit(ev('session.deleted', {}, { sessionId: 'sX' })))
    await waitFor(() => expect(f.callsOf('executor.runs')).toHaveLength(2))
  })

  it('session.delete unsupported (-32601, or memory unavailable) shows 不支持', async () => {
    for (const err of [() => fail(-32601), () => fail(-32603, 'memory is unavailable')]) {
      f = installFakeForge({ calls: { 'executor.runs': { runs: [] }, 'session.delete': err } })
      const { unmount } = render(<DeleteSession session={summary('s1')} onClose={() => {}} onDeleted={() => {}} />)
      await waitFor(() => expect(okBtn().disabled).toBe(false))
      await act(async () => { fireEvent.click(okBtn()) })
      expect(await within(screen.getByRole('dialog')).findByText('不支持')).toBeInTheDocument()
      unmount()
    }
  })

  it('取消 closes without a call', async () => {
    f = installFakeForge({ calls: { 'executor.runs': { runs: [] } } })
    const p = mount()
    fireEvent.click(screen.getByText('取消'))
    expect(p.onClose).toHaveBeenCalled()
    expect(f.callsOf('session.delete')).toHaveLength(0)
  })
})
