// 布局切换(活动、›、宽度跨 1280)时卡片换位置,但卡片不重挂:进行中的请求、重试用的 commandId、已合并 / 已丢弃、打开着的确认框都留着(Task 5 评审 1)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { KernelEvent } from '@mffai/protocol'
import { route } from '../route'
import { ev, resetSeq } from '../test/events'
import { fail, type CallTable } from '../test/fakeForge'
import { runRow, summary } from '../test/sessions'
import { S, act$, actBtn, body$, memStorage, mountPanel, panelCalls } from '../test/panel'

let done: (() => void) | undefined
beforeEach(() => { resetSeq(); route.set({ page: 'chat', sessionId: S }); vi.stubGlobal('localStorage', memStorage()) })
afterEach(() => { done?.(); done = undefined; vi.unstubAllGlobals() })

const btnIn = (root: HTMLElement, name: string) => within(root).queryByRole('button', { name }) as HTMLButtonElement | null
const card = (attr: string, id: string) => document.querySelector(`[${attr}="${id}"]`) as HTMLElement

/** 一轮已结束,委派 r1 结束、worktree 还在、3 个文件;用户先等在 hi 上 */
function endedRun(extra: CallTable): CallTable {
  const e = (type: Parameters<typeof ev>[0], payload: unknown) => ev(type, payload, { sessionId: S })
  const evs: KernelEvent[] = [
    e('message.user', { turnId: 't1', text: 'fix the build' }),
    e('executor.run.started', { runId: 'r1', turnId: 't1', executor: 'codex', cwd: '/wt/r1', isolation: 'own', worktree: '/wt/r1' }),
    e('executor.run.ended', { runId: 'r1', turnId: 't1', executor: 'codex', status: 'ok', ms: 1500, changed: { files: ['a.ts', 'b.ts', 'c.ts'], source: 'git' }, worktree: '/wt/r1' }),
    e('turn.ended', { turnId: 't1' }),
  ]
  return {
    'session.list': { sessions: [summary(S, { cwd: '/repo' })] }, 'plugins.commands': { commands: [] },
    'session.state': { session: summary(S, { cwd: '/repo' }), events: evs, hasMore: false, lastSeq: evs.at(-1)!.seq },
    'executor.runs': { runs: [runRow('r1', S, { worktree: { path: '/wt/r1', present: true }, changed: 3 })] },
    ...extra,
  }
}

describe('a card keeps its state when the layout moves it', () => {
  for (const how of ['活动', 'width 1279'] as const) {
    it(`approval.respond in flight, then ${how}: the inline card stays greyed and a second click sends nothing`, async () => {
      const m = await mountPanel(1440, { ...panelCalls(), 'approval.respond': () => new Promise(() => {}) as never }); done = m.done
      await act(async () => { fireEvent.click(btnIn(act$()!, '允许')!) })
      expect(m.f.callsOf('approval.respond')).toHaveLength(1)
      if (how === '活动') fireEvent.click(actBtn())
      else m.setWidth(1279)
      expect(act$()).toBeNull()
      const c = card('data-approval', 'a1')
      expect(body$().contains(c)).toBe(true)
      for (const n of ['允许', '本会话允许', '拒绝']) expect(btnIn(c, n)!.disabled).toBe(true)
      await act(async () => { btnIn(c, '拒绝')!.click(); btnIn(c, '允许')!.click() })
      expect(m.f.callsOf('approval.respond')).toEqual([{ approvalId: 'a1', decision: 'allow' }])
    })
  }

  it('a merge that failed keeps its commandId for the retry after the card moves', async () => {
    let n = 0
    const m = await mountPanel(1440, endedRun({ 'executor.worktree.merge': () => (++n === 1 ? fail(-32603, 'timeout') : { ok: true, files: 3 }) as never })); done = m.done
    const inPanel = await waitFor(() => { const b = btnIn(card('data-run', 'r1'), '合并'); expect(b).not.toBeNull(); return b! })
    expect(act$()!.contains(inPanel)).toBe(true)
    fireEvent.click(inPanel)
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '合并' })) })
    expect(within(card('data-run', 'r1')).getByText('失败')).toBeInTheDocument()
    fireEvent.click(actBtn())
    const inline = card('data-run', 'r1')
    expect(body$().contains(inline)).toBe(true)
    expect(within(inline).getByText('失败')).toBeInTheDocument()
    fireEvent.click(btnIn(inline, '合并')!)
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '合并' })) })
    const calls = m.f.callsOf('executor.worktree.merge') as { commandId: string }[]
    expect(calls).toHaveLength(2)
    expect(calls[1].commandId).toBe(calls[0].commandId)
    expect(within(card('data-run', 'r1')).getByText('已合并 3 个文件')).toBeInTheDocument()
  })

  it('a merge in flight: after › the inline 合并 / 丢弃 stay disabled', async () => {
    const m = await mountPanel(1440, endedRun({ 'executor.worktree.merge': () => new Promise(() => {}) as never })); done = m.done
    const b = await waitFor(() => { const x = btnIn(card('data-run', 'r1'), '合并'); expect(x).not.toBeNull(); return x! })
    fireEvent.click(b)
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '合并' })) })
    fireEvent.click(within(act$()!).getByRole('button', { name: '收起' }))
    const inline = card('data-run', 'r1')
    expect(body$().contains(inline)).toBe(true)
    expect(btnIn(inline, '合并')!.disabled).toBe(true)
    expect(btnIn(inline, '丢弃')!.disabled).toBe(true)
    expect(m.f.callsOf('executor.worktree.merge')).toHaveLength(1)
  })

  it('a discard that finished while docked still shows 已丢弃 and no buttons once inline', async () => {
    const m = await mountPanel(1440, endedRun({ 'executor.worktree.discard': { ok: true } })); done = m.done
    const b = await waitFor(() => { const x = btnIn(card('data-run', 'r1'), '丢弃'); expect(x).not.toBeNull(); return x! })
    fireEvent.click(b)
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '丢弃' })) })
    m.setWidth(1279)
    const inline = card('data-run', 'r1')
    expect(body$().contains(inline)).toBe(true)
    expect(within(inline).getByText('已丢弃')).toBeInTheDocument()
    expect(btnIn(inline, '丢弃')).toBeNull()
    expect(btnIn(inline, '合并')).toBeNull()
    expect(m.f.callsOf('executor.worktree.discard')).toHaveLength(1)
  })

  it('an open confirm stays open across the move and sends once when confirmed', async () => {
    const m = await mountPanel(1440, endedRun({ 'executor.worktree.merge': { ok: true, files: 3 } })); done = m.done
    const b = await waitFor(() => { const x = btnIn(card('data-run', 'r1'), '合并'); expect(x).not.toBeNull(); return x! })
    fireEvent.click(b)
    expect(screen.getByRole('dialog')).toHaveAccessibleName('合并到 /repo')
    fireEvent.click(actBtn())
    expect(act$()).toBeNull()
    expect(screen.getByRole('dialog')).toHaveAccessibleName('合并到 /repo')
    expect(m.f.callsOf('executor.worktree.merge')).toHaveLength(0)
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '合并' })) })
    expect(m.f.callsOf('executor.worktree.merge')).toEqual([{ commandId: expect.any(String), sessionId: S, runId: 'r1' }])
  })
})
