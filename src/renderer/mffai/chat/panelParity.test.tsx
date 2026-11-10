// Review Focus 2 的面板行:今天(BASE)套件里审批卡、运行卡、SessionPane 的关键行为,对着面板里的卡片再跑一遍,期望的调用照抄。
// 主区 1440(test/resize 桩),偏好缺省 = 展开。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { KernelEvent } from '@mffai/protocol'
import ChatPage from './ChatPage'
import { MainWidthProvider } from '../useMainWidth'
import { route } from '../route'
import { ev, resetSeq } from '../test/events'
import { fail, installFakeForge, type CallTable, type FakeForge } from '../test/fakeForge'
import { installResize } from '../test/resize'
import { runRow, summary } from '../test/sessions'
import { S, act$, memStorage, mountPanel, panelCalls, panelEvents } from '../test/panel'

let un: (() => void) | undefined
beforeEach(() => { resetSeq(); route.set({ page: 'chat', sessionId: S }); vi.stubGlobal('localStorage', memStorage()) })
afterEach(() => { un?.(); un = undefined; vi.unstubAllGlobals() })

const panel = () => act$()!
const inPanel = (name: string) => within(panel()).queryByRole('button', { name }) as HTMLButtonElement | null
const runCard = (id: string) => panel().querySelector(`[data-run="${id}"]`) as HTMLElement
const dialog = () => screen.getByRole('dialog')
const rows = () => [...dialog().querySelectorAll('.mffai-confirm-row')].map((r) => [...r.querySelectorAll('span')].map((c) => c.textContent))

async function mount(calls: CallTable, text: string): Promise<FakeForge> {
  const r = installResize(); un = r.uninstall
  const f = installFakeForge({ calls })
  render(<MainWidthProvider><ChatPage /></MainWidthProvider>)
  r.setMainWidth(1440)
  await screen.findByText(text)
  expect(panel()).not.toBeNull()
  return f
}

/** 一轮已结束,委派 r1 结束、worktree 还在、3 个文件(RunCard.test 的 done() + kept) */
function endedRun(): CallTable {
  const e = (type: Parameters<typeof ev>[0], payload: unknown) => ev(type, payload, { sessionId: S })
  const evs: KernelEvent[] = [
    e('message.user', { turnId: 't1', text: 'hi' }),
    e('executor.run.started', { runId: 'r1', turnId: 't1', executor: 'codex', cwd: '/wt/r1', isolation: 'own', worktree: '/wt/r1' }),
    e('executor.run.ended', { runId: 'r1', turnId: 't1', executor: 'codex', status: 'ok', ms: 1500, changed: { files: ['a.ts', 'b.ts', 'c.ts'], source: 'git' }, worktree: '/wt/r1' }),
    e('turn.ended', { turnId: 't1' }),
  ]
  return {
    'session.list': { sessions: [summary(S, { cwd: '/repo' })] }, 'plugins.commands': { commands: [] },
    'session.state': { session: summary(S, { cwd: '/repo' }), events: evs, hasMore: false, lastSeq: evs.at(-1)!.seq },
    'executor.runs': { runs: [runRow('r1', S, { worktree: { path: '/wt/r1', present: true }, changed: 3 })] },
  }
}

describe('cards inside the activity panel behave as inline', () => {
  it('allow (mirrors SessionPane.test "an IM session: cards still answerable…")', async () => {
    const m = await mountPanel(1440); un = m.done
    await act(async () => { fireEvent.click(inPanel('允许')!) })
    expect(m.f.callsOf('approval.respond')).toEqual([{ approvalId: 'a1', decision: 'allow' }])
  })

  it('allow for this session, then every button greys (mirrors ApprovalCard.test "a click sends approval.respond…")', async () => {
    const m = await mountPanel(1440); un = m.done
    await act(async () => { fireEvent.click(inPanel('本会话允许')!) })
    expect(m.f.callsOf('approval.respond')).toEqual([{ approvalId: 'a1', decision: 'allow_session' }])
    for (const n of ['允许', '本会话允许', '拒绝']) expect(inPanel(n)!.disabled).toBe(true)
  })

  it('deny; a failed respond re-enables with 失败 (mirrors ApprovalCard.test "a failed respond re-enables…")', async () => {
    const m = await mountPanel(1440, { ...panelCalls(), 'approval.respond': () => fail(-32603, 'x') }); un = m.done
    await act(async () => { fireEvent.click(inPanel('拒绝')!) })
    expect(m.f.callsOf('approval.respond')).toEqual([{ approvalId: 'a1', decision: 'deny' }])
    expect(within(panel()).getByText('失败')).toBeInTheDocument()
    expect(inPanel('拒绝')!.disabled).toBe(false)
  })

  it('本会话允许 only with a key; 未隔离 with unsandboxed (mirrors ApprovalCard.test "本会话允许 only with a key…")', async () => {
    const evs = panelEvents().map((x) => x.type === 'approval.requested'
      ? { ...x, payload: { approvalId: 'a1', turnId: 't1', callId: 'c2', tool: 'shell', summary: 'npm test', unsandboxed: true } } : x)
    const m = await mountPanel(1440, panelCalls(evs)); un = m.done
    expect(inPanel('允许')).not.toBeNull()
    expect(inPanel('本会话允许')).toBeNull()
    expect(within(panel()).getByText('未隔离')).toBeInTheDocument()
  })

  it('the run 停止 sends executor.cancel for that run only (mirrors RunCard.test "running: 运行中 and the per-run 停止…")', async () => {
    const m = await mountPanel(1440); un = m.done
    await act(async () => { fireEvent.click(within(runCard('r1')).getByRole('button', { name: '停止' })) })
    expect(m.f.callsOf('executor.cancel')).toEqual([{ commandId: expect.any(String), sessionId: S, runId: 'r1' }])
    expect(m.f.callsOf('session.cancel')).toEqual([])
  })

  it('merge refused dirty lists the paths, then accepted (mirrors RunCard.test "merge refused dirty…" and "合并: the confirm names the session checkout…")', async () => {
    let n = 0
    const f = await mount({ ...endedRun(), 'executor.worktree.merge': () => (++n === 1 ? fail(-32602, 'refused', { reason: 'dirty', paths: ['src/a.ts', 'src/b.ts'] }) : { ok: true, files: 3 }) as never }, 'hi')
    const merge = await waitFor(() => within(runCard('r1')).getByRole('button', { name: '合并' }))
    fireEvent.click(merge)
    expect(dialog()).toHaveAccessibleName('合并到 /repo')
    expect(rows()).toEqual([['worktree', '/wt/r1'], ['文件', '3']])
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '合并' })) })
    for (const t of ['dirty', 'src/a.ts', 'src/b.ts']) expect(within(panel()).getByText(t)).toBeInTheDocument()
    fireEvent.click(within(runCard('r1')).getByRole('button', { name: '合并' }))
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '合并' })) })
    expect(f.callsOf('executor.worktree.merge')).toEqual([
      { commandId: expect.any(String), sessionId: S, runId: 'r1' },
      { commandId: expect.any(String), sessionId: S, runId: 'r1' },
    ])
    expect(within(runCard('r1')).queryByRole('button', { name: '合并' })).toBeNull()
    expect(within(panel()).getByText('已合并 3 个文件')).toBeInTheDocument()
  })

  it('丢弃: confirm 丢弃 worktree / 路径, then executor.worktree.discard (mirrors RunCard.test "丢弃: confirm…")', async () => {
    const f = await mount({ ...endedRun(), 'executor.worktree.discard': { ok: true } }, 'hi')
    const discard = await waitFor(() => within(runCard('r1')).getByRole('button', { name: '丢弃' }))
    fireEvent.click(discard)
    expect(dialog()).toHaveAccessibleName('丢弃 worktree')
    expect(rows()).toEqual([['路径', '/wt/r1']])
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '丢弃' })) })
    expect(f.callsOf('executor.worktree.discard')).toEqual([{ commandId: expect.any(String), sessionId: S, runId: 'r1' }])
    expect(within(runCard('r1')).queryByRole('button', { name: '合并' })).toBeNull()
    expect(within(runCard('r1')).queryByRole('button', { name: '丢弃' })).toBeNull()
    expect(within(panel()).getByText('已丢弃')).toBeInTheDocument()
  })

  it('reopen restores the approval card, the run card 停止, 挂起 and the turn-level 停止 (mirrors SessionPane.test "reopen restores…")', async () => {
    const e = (type: Parameters<typeof ev>[0], payload: unknown) => ev(type, payload, { sessionId: S })
    const events = [
      e('message.user', { turnId: 't1', text: 'fix the build' }),
      e('turn.snapshot', { turnId: 't1', phase: 'start', ref: 'refs/start' }),
      e('message.assistant', { turnId: 't1', step: 1, text: 'delegating now' }),
      e('executor.run.queued', { runId: 'r1', turnId: 't1', callId: 'c1', executor: 'codex', summary: 'do it', readOnly: false, isolation: 'own', position: 1 }),
      e('executor.run.started', { runId: 'r1', turnId: 't1', executor: 'codex', cwd: '/repo', isolation: 'own' }),
      ...Array.from({ length: 30 }, (_, i) => e('executor.run.progress', { runId: 'r1', turnId: 't1', kind: 'tool', text: `step ${i}` })),
      e('approval.requested', { approvalId: 'p1', turnId: 't1', callId: 'c2', tool: 'shell', summary: 'npm test' }),
      e('turn.parked', { turnId: 't1', step: 1, active: 1, pending: 0 }),
    ]
    const calls: CallTable = {
      'session.list': { sessions: [summary(S, { title: '会话', open: { turnId: 't1', parked: true }, pendingApprovals: 1 })] },
      'session.state': { session: summary(S), events, hasMore: false, lastSeq: events.at(-1)!.seq, open: { turnId: 't1', parked: true, approvalIds: ['p1'] } },
      'plugins.commands': { commands: [] },
      'session.prompt': { accepted: true, turnId: 't1', followUp: true },
      'session.cancel': { ok: true },
      'executor.cancel': { ok: true },
      'channel.telegram.chats': { chats: [], worktrees: [] },
    }
    const composer = () => document.querySelector('.mffai-composer') as HTMLElement
    const check = async () => {
      await screen.findByText('npm test')
      expect(panel().contains(screen.getByText('npm test'))).toBe(true)
      expect(screen.getByText('fix the build')).toBeInTheDocument()
      expect(within(runCard('r1')).getByRole('button', { name: '停止' })).toBeInTheDocument()
      expect(within(composer()).getByText('挂起 · 1 运行中')).toBeInTheDocument()
      expect(within(composer()).getByRole('button', { name: '停止' })).toBeInTheDocument()
      expect(within(panel()).getByRole('button', { name: '允许' })).toBeInTheDocument()
    }
    const r = installResize(); un = r.uninstall
    const f = installFakeForge({ calls })
    const first = render(<MainWidthProvider><ChatPage /></MainWidthProvider>)
    r.setMainWidth(1440)
    await check()
    first.unmount()
    render(<MainWidthProvider><ChatPage /></MainWidthProvider>)
    r.setMainWidth(1440)
    await check()
    fireEvent.change(screen.getByRole('textbox', { name: '输入' }), { target: { value: 'also lint' } })
    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: '输入' }), { key: 'Enter' }) })
    expect(f.callsOf('session.prompt')).toEqual([{ commandId: expect.any(String), sessionId: S, text: 'also lint' }])
    await act(async () => { fireEvent.click(within(composer()).getByRole('button', { name: '停止' })) })
    await act(async () => { fireEvent.click(within(runCard('r1')).getByRole('button', { name: '停止' })) })
    expect(f.callsOf('session.cancel')).toEqual([{ commandId: expect.any(String), sessionId: S }])
    expect(f.callsOf('executor.cancel')).toEqual([{ commandId: expect.any(String), sessionId: S, runId: 'r1' }])
  })
})
