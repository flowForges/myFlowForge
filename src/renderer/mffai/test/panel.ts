// 活动面板测试的共用夹具(08b Task 5):内存 localStorage(这个测试环境的全局 localStorage 不可用,同 layout.test)、
// 一个有旧轮和开着的轮的会话、在 MainWidthProvider 里挂 ChatPage 并给主区一个宽度。
import { createElement } from 'react'
import { render, screen } from '@testing-library/react'
import type { KernelEvent } from '@mffai/protocol'
import ChatPage from '../chat/ChatPage'
import { MainWidthProvider } from '../useMainWidth'
import { installFakeForge, type CallTable, type FakeForge } from './fakeForge'
import { ev } from './events'
import { installResize } from './resize'
import { runRow, summary } from './sessions'

export const S = 's1'

export const memStorage = (): Storage => {
  const d: Record<string, string> = {}
  return {
    getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = String(v) }, removeItem: (k) => { delete d[k] },
    clear: () => { for (const k of Object.keys(d)) delete d[k] }, key: (i) => Object.keys(d)[i] ?? null,
    get length() { return Object.keys(d).length },
  }
}

const e = (type: Parameters<typeof ev>[0], payload: unknown, sessionId = S) => ev(type, payload, { sessionId })

/**
 * t0:结束了的旧轮,一个结束的委派 r0(worktree 还在、3 个文件没合并)。
 * t1:开着的轮,先一个运行中的委派 r1,再一个待批的审批 a1(带 key)。
 */
export function panelEvents(sessionId = S, opts: { summary?: string; progress?: string; final?: string } = {}): KernelEvent[] {
  const x = (type: Parameters<typeof ev>[0], payload: unknown) => e(type, payload, sessionId)
  return [
    x('message.user', { turnId: 't0', text: 'older ask' }),
    x('executor.run.started', { runId: 'r0', turnId: 't0', executor: 'claude', cwd: '/wt/r0', isolation: 'own', worktree: '/wt/r0' }),
    x('executor.run.ended', { runId: 'r0', turnId: 't0', executor: 'claude', status: 'ok', ms: 1, changed: { files: ['a', 'b', 'c'], source: 'git' }, worktree: '/wt/r0', ...(opts.final && { final: opts.final }) }),
    x('turn.ended', { turnId: 't0' }),
    x('message.user', { turnId: 't1', text: 'fix the build' }),
    x('turn.snapshot', { turnId: 't1', phase: 'start', ref: 'refs/start' }),
    x('message.assistant', { turnId: 't1', step: 1, text: 'delegating now' }),
    x('executor.run.queued', { runId: 'r1', turnId: 't1', callId: 'c1', executor: 'codex', summary: 'do it', readOnly: false, isolation: 'own', position: 1 }),
    x('executor.run.started', { runId: 'r1', turnId: 't1', executor: 'codex', cwd: '/repo', isolation: 'own' }),
    x('executor.run.progress', { runId: 'r1', turnId: 't1', kind: 'tool', text: opts.progress ?? 'step 1' }),
    x('approval.requested', { approvalId: 'a1', turnId: 't1', callId: 'c2', tool: 'shell', summary: opts.summary ?? 'npm test', key: 'shell:npm test' }),
  ]
}

export function panelCalls(events: KernelEvent[] = panelEvents(), sessionPatch = {}, open: { parked: boolean } = { parked: false }): CallTable {
  return {
    'session.list': { sessions: [summary(S, { title: '会话一', cwd: '/repo', open: { turnId: 't1', ...open }, pendingApprovals: 1, ...sessionPatch }), summary('s2', { title: '会话二' })] },
    'session.state': { session: summary(S, { title: '会话一', cwd: '/repo', ...sessionPatch }), events, hasMore: false, lastSeq: events.at(-1)!.seq, open: { turnId: 't1', ...open, approvalIds: ['a1'] } },
    'plugins.commands': { commands: [] },
    'session.prompt': { accepted: true, turnId: 't1', followUp: true },
    'session.cancel': { ok: true },
    'executor.cancel': { ok: true },
    'approval.respond': { ok: true },
    'executor.runs': { runs: [runRow('r0', S, { turnId: 't0', worktree: { path: '/wt/r0', present: true }, changed: 3 })] },
    'channel.telegram.chats': { chats: [], worktrees: [] },
  }
}

/** ChatPage 在宽度提供者里;width 为 undefined 时不装 ResizeObserver 桩(jsdom 的样子) */
export async function mountPanel(width: number | undefined, calls: CallTable = panelCalls()): Promise<{ f: FakeForge; setWidth(px: number | undefined): void; done(): void }> {
  const r = width === undefined ? undefined : installResize()
  const f = installFakeForge({ calls })
  render(createElement(MainWidthProvider, null, createElement(ChatPage)))
  r?.setMainWidth(width)
  await screen.findByText('fix the build')
  return {
    f,
    setWidth: (px) => { if (!r) throw new Error('no resize stub'); r.setMainWidth(px) },
    done: () => r?.uninstall(),
  }
}

export const act$ = () => document.querySelector('aside.mffai-act') as HTMLElement | null
export const body$ = () => document.querySelector('.mffai-chat-body') as HTMLElement
export const actBtn = () => document.querySelector('button.mffai-actbtn') as HTMLButtonElement
