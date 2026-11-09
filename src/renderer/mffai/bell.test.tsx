// 铃铛(08 §13.6):每个来源的文字和 key;插值都过 sanitize(R1);允许/拒绝走 approval.respond、approval.resolved 到了才移除;
// onOpen 写 mff-ai 自己的路由;记忆待确认重读去抖 300 ms、同 key 原地更新、0 时移除;stop 退订。
// 配对码、令牌、命令全文、记忆正文从不进通知(Task 10 控制者备注、Review Focus 8)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { MemoryProposal, SessionSummary } from '@mffai/protocol'
import { MemoryProposalSchema } from '@mffai/protocol/browser'
import { startBell, type BellSink } from './bell'
import { route } from './route'
import { NotificationPopover } from '../shell/NotificationPopover'
import { removeNotif, upsertNotif, type Notif } from '../shell/notifications'
import { fail, installFakeForge, type CallTable, type FakeForge } from './test/fakeForge'
import { ev, resetSeq } from './test/events'
import { summary } from './test/sessions'

const XSS = '<img src=x onerror=alert(1)>'

function sinkOf() {
  let ns: Notif[] = []
  const open = vi.fn()
  const sink: BellSink = {
    upsert: (n) => { ns = upsertNotif(ns, n) },
    remove: (k) => { ns = removeNotif(ns, k) },
    open,
  }
  return { sink, open, get: () => ns, byKey: (k: string) => ns.find((n) => n.key === k) }
}

const proposal = (id: string, text = 'note body'): MemoryProposal => MemoryProposalSchema.parse({
  id, target: 'MEMORY.md', op: 'add', text, evidence: [], source: 'extract', flags: [], status: 'pending', createdAt: 1,
})

let f: FakeForge
let stop: (() => void) | undefined
let s: ReturnType<typeof sinkOf>

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

function boot(calls: CallTable = {}) {
  f = installFakeForge({ calls: { 'memory.proposals.list': { items: [] }, ...calls } })
  s = sinkOf()
  stop = startBell(s.sink)
}

const popover = (ns: Notif[]) => render(
  <NotificationPopover notifs={ns} updateAvailable={false} open onToggle={() => {}} onOpenUpgrade={() => {}} onMarkAllRead={() => {}} onClearAll={() => {}} onSelect={() => {}} />,
)

beforeEach(() => { resetSeq(); route.set({ page: 'debug' }) })
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.restoreAllMocks() })

describe('bell: approvals', () => {
  it('approval.requested gives `<tool> 待审批` keyed by approvalId, with 允许 / 拒绝; the command text stays out', async () => {
    boot()
    act(() => f.emit(ev('approval.requested', { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'echo CMD_MARKER_9' }, { sessionId: 's1' })))
    const n = s.byKey('mffai:approval:a1')!
    expect(n.t).toBe('<b>shell</b> 待审批')
    expect(n.view).toBe('mffai')
    expect(n.actions?.map((a) => [a.label, !!a.danger])).toEqual([['允许', false], ['拒绝', true]])
    expect(JSON.stringify(s.get())).not.toContain('CMD_MARKER_9')
  })

  it('允许 from the popover calls approval.respond; the notification stays until its approval.resolved', async () => {
    boot({ 'approval.respond': { ok: true } })
    act(() => f.emit(ev('approval.requested', { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'x' }, { sessionId: 's1' })))
    popover(s.get())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '允许' })) })
    expect(f.callsOf('approval.respond')).toEqual([{ approvalId: 'a1', decision: 'allow' }])
    expect(s.byKey('mffai:approval:a1')).toBeDefined()
    act(() => f.emit(ev('approval.resolved', { approvalId: 'a1', decision: 'allow', by: 'user' }, { sessionId: 's1' })))
    expect(s.byKey('mffai:approval:a1')).toBeUndefined()
  })

  it('拒绝 sends deny; a second click while in flight sends nothing more', async () => {
    let resolve!: (v: { ok: boolean }) => void
    boot({ 'approval.respond': () => new Promise((r) => { resolve = r }) })
    act(() => f.emit(ev('approval.requested', { approvalId: 'a2', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'x' }, { sessionId: 's1' })))
    const deny = s.byKey('mffai:approval:a2')!.actions!.find((a) => a.label === '拒绝')!
    deny.run(); deny.run()
    await flush()
    expect(f.callsOf('approval.respond')).toEqual([{ approvalId: 'a2', decision: 'deny' }])
    await act(async () => { resolve({ ok: true }) })
  })

  it('approval.respond answering ok:false (already answered elsewhere) removes it', async () => {
    boot({ 'approval.respond': { ok: false } })
    act(() => f.emit(ev('approval.requested', { approvalId: 'a3', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'x' }, { sessionId: 's1' })))
    s.byKey('mffai:approval:a3')!.actions![0].run()
    await flush()
    expect(s.byKey('mffai:approval:a3')).toBeUndefined()
  })

  it('a failed respond keeps it, so it can be tried again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    boot({ 'approval.respond': () => fail(-32603, 'boom') })
    act(() => f.emit(ev('approval.requested', { approvalId: 'a4', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'x' }, { sessionId: 's1' })))
    s.byKey('mffai:approval:a4')!.actions![0].run()
    await flush()
    expect(s.byKey('mffai:approval:a4')).toBeDefined()
    s.byKey('mffai:approval:a4')!.actions![0].run()
    await flush()
    expect(f.callsOf('approval.respond')).toHaveLength(2)
  })

  it('onOpen routes to that session on the chat page', () => {
    boot()
    act(() => f.emit(ev('approval.requested', { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'x' }, { sessionId: 's9' })))
    s.byKey('mffai:approval:a1')!.onOpen!()
    expect(route.get()).toEqual({ page: 'chat', sessionId: 's9' })
  })
})

describe('bell: unsandboxed approvals and session titles', () => {
  it('unsandboxed:true says 未隔离 and offers only 拒绝, so it must be allowed from the chat card', () => {
    boot()
    act(() => f.emit(ev('approval.requested', { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'x', unsandboxed: true }, { sessionId: 's1' })))
    const n = s.byKey('mffai:approval:a1')!
    expect(n.t).toContain('未隔离')
    expect(n.actions?.map((a) => a.label)).toEqual(['拒绝'])
    const { container } = popover(s.get())
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull()
    expect(container.textContent).toContain('未隔离')
  })

  it('two approvals for the same tool carry their sanitized session titles in the body', async () => {
    boot({ 'session.list': { sessions: [summary('s1', { title: '修登录' }), summary('s2', { title: `发文档${XSS}` })] } })
    act(() => {
      f.emit(ev('approval.requested', { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'x' }, { sessionId: 's1' }))
      f.emit(ev('approval.requested', { approvalId: 'a2', turnId: 't2', callId: 'c2', tool: 'shell', summary: 'x' }, { sessionId: 's2' }))
    })
    await flush()
    expect(s.byKey('mffai:approval:a1')!.t).toBe('<b>shell</b> 待审批 · 修登录')
    expect(s.byKey('mffai:approval:a2')!.t).toBe('<b>shell</b> 待审批 · 发文档')
    const { container } = popover(s.get())
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })

  it('a session.list answer without sessions keeps the plain notification and throws nothing', async () => {
    boot({ 'session.list': {} as never })
    act(() => f.emit(ev('approval.requested', { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'x' }, { sessionId: 's1' })))
    await flush()
    expect(s.byKey('mffai:approval:a1')!.t).toBe('<b>shell</b> 待审批')
  })

  it('a title already resolved by the time it arrives does not bring the notification back', async () => {
    let resolve!: (v: { sessions: SessionSummary[] }) => void
    boot({ 'session.list': () => new Promise((r) => { resolve = r }) })
    act(() => f.emit(ev('approval.requested', { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'x' }, { sessionId: 's1' })))
    act(() => f.emit(ev('approval.resolved', { approvalId: 'a1', decision: 'allow', by: 'user' }, { sessionId: 's1' })))
    await act(async () => { resolve({ sessions: [summary('s1', { title: 'T' })] }) })
    expect(s.byKey('mffai:approval:a1')).toBeUndefined()
  })
})

describe('bell: invisible characters are shown (M1)', () => {
  it('a tool name, title and plugin id with bidi / zero-width chars show \\u{…} and never the raw char', async () => {
    boot({ 'session.list': { sessions: [summary('s1', { title: 'a\u200Bb' })] } })
    act(() => {
      f.emit(ev('approval.requested', { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: 'sh\u202Eell', summary: 'x' }, { sessionId: 's1' }))
      f.emit(ev('plugin.failed', { id: 'p\u2028q', error: 'e' }))
    })
    await flush()
    expect(s.byKey('mffai:approval:a1')!.t).toBe('<b>sh\\u{202E}ell</b> 待审批 · a\\u{200B}b')
    expect(s.byKey('mffai:plugin:p\u2028q')!.t).toBe('<b>p\\u{2028}q</b> 启动失败')
    expect(JSON.stringify(s.get().map((n) => n.t))).not.toMatch(/[\u202E\u200B\u2028]/)
  })
})

describe('bell: session.deleted', () => {
  it('drops that session\'s approval and run notifications, not another session\'s', () => {
    boot()
    act(() => {
      f.emit(ev('approval.requested', { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'x' }, { sessionId: 's1' }))
      f.emit(ev('executor.run.ended', { runId: 'r1', turnId: 't1', executor: 'codex', status: 'ok', ms: 1, changed: { files: [], source: 'git' } }, { sessionId: 's1' }))
      f.emit(ev('approval.requested', { approvalId: 'a2', turnId: 't2', callId: 'c2', tool: 'shell', summary: 'x' }, { sessionId: 's2' }))
    })
    act(() => f.emit(ev('session.deleted', {}, { sessionId: 's1' })))
    expect(s.byKey('mffai:approval:a1')).toBeUndefined()
    expect(s.byKey('mffai:run:r1')).toBeUndefined()
    expect(s.byKey('mffai:approval:a2')).toBeDefined()
  })
})

describe('bell: memory proposals', () => {
  it('reads pending proposals at start: one `待确认记忆 N`, no note text', async () => {
    boot({ 'memory.proposals.list': { items: [proposal('p1', 'NOTE_MARKER_1'), proposal('p2')] } })
    await flush()
    expect(f.callsOf('memory.proposals.list')).toEqual([{ status: 'pending' }])
    const n = s.byKey('mffai:proposals')!
    expect(n.t).toBe('待确认记忆 2')
    expect(JSON.stringify(s.get())).not.toContain('NOTE_MARKER_1')
    n.onOpen!()
    expect(route.get()).toEqual({ page: 'memory' })
  })

  it('memory.updated / memory.proposal re-read once per 300 ms; the same key updates in place and goes at 0', async () => {
    vi.useFakeTimers()
    let items = [proposal('p1'), proposal('p2')]
    boot({ 'memory.proposals.list': () => ({ items }) })
    await flush()
    expect(s.byKey('mffai:proposals')!.t).toBe('待确认记忆 2')
    s.sink.upsert({ ic: 'ok', cls: 'ni-ok', t: 'other', m: '', unread: true })
    items = [proposal('p1')]
    act(() => {
      f.emit(ev('memory.updated', { op: 'approve', source: 'user' }))
      f.emit(ev('memory.proposal', { id: 'p2', target: 'MEMORY.md', status: 'approved' }))
      f.emit(ev('memory.updated', { op: 'x', source: 'user' }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(299) })
    expect(f.callsOf('memory.proposals.list')).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5) })
    expect(f.callsOf('memory.proposals.list')).toHaveLength(2)
    expect(s.get().map((n) => n.t)).toEqual(['other', '待确认记忆 1'])
    items = []
    act(() => f.emit(ev('memory.updated', { op: 'reject', source: 'user' })))
    await act(async () => { await vi.advanceTimersByTimeAsync(305) })
    expect(s.byKey('mffai:proposals')).toBeUndefined()
  })

  it('no memory plugin (-32601): no notification, no console.error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    boot({ 'memory.proposals.list': () => fail(-32601) })
    await flush()
    expect(s.get()).toEqual([])
    expect(err).not.toHaveBeenCalled()
  })

  it('a reset alert re-reads the proposals', async () => {
    boot()
    await flush()
    act(() => f.alert({ kind: 'reset' }))
    await act(async () => { await new Promise((r) => setTimeout(r, 350)) })
    expect(f.callsOf('memory.proposals.list')).toHaveLength(2)
  })
})

describe('bell: other sources', () => {
  it('memory.recommendation: its text and 开会话, which routes to a new session in its cwd, opens the page and drops the notification', () => {
    boot()
    act(() => f.emit(ev('memory.recommendation', { id: 'r1', category: 'routine', habitId: 'h1', text: '每周一看看依赖', cwd: '/w/api' })))
    const n = s.byKey('mffai:rec:r1')!
    expect(n.t).toBe('每周一看看依赖')
    const open = n.actions!.find((a) => a.label === '开会话')!
    open.run()
    expect(route.get()).toEqual({ page: 'chat', newSession: { cwd: '/w/api' } })
    expect(s.open).toHaveBeenCalledTimes(1)
    expect(s.byKey('mffai:rec:r1')).toBeUndefined()
  })

  it('channel.paired: `Telegram 已配对 <name>` with 撤销, which unpairs and drops it; an app-side unpair drops it too', async () => {
    boot({ 'channel.telegram.unpair': { ok: true } })
    act(() => f.emit(ev('channel.paired', { channel: 'telegram', accountId: '42', name: 'Ann' })))
    act(() => f.emit(ev('channel.paired', { channel: 'telegram', accountId: '43', name: 'Bob' })))
    const n = s.byKey('mffai:paired:42')!
    expect(n.t).toBe('Telegram 已配对 <b>Ann</b>')
    const undo = n.actions!.find((a) => a.label === '撤销')!
    expect(undo.danger).toBe(true)
    undo.run()
    await flush()
    expect(f.callsOf('channel.telegram.unpair')).toEqual([{ commandId: expect.any(String), accountId: '42' }])
    expect(s.byKey('mffai:paired:42')).toBeUndefined()
    act(() => f.emit(ev('channel.unpaired', { channel: 'telegram', accountId: '43', by: 'app' })))
    expect(s.byKey('mffai:paired:43')).toBeUndefined()
    expect(s.get()).toEqual([])
  })

  it('a failed 撤销 keeps the notification and retries with the same commandId', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let n = 0
    boot({ 'channel.telegram.unpair': () => { if (n++ === 0) fail(-32010, 'timeout'); return { ok: true } } })
    act(() => f.emit(ev('channel.paired', { channel: 'telegram', accountId: '42', name: 'Ann' })))
    s.byKey('mffai:paired:42')!.actions![0].run()
    await flush()
    expect(s.byKey('mffai:paired:42')).toBeDefined()
    s.byKey('mffai:paired:42')!.actions![0].run()
    await flush()
    const ids = f.callsOf('channel.telegram.unpair').map((p) => (p as { commandId: string }).commandId)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(s.byKey('mffai:paired:42')).toBeUndefined()
  })

  it('a 撤销 that timed out after the harness already unpaired: unpaired, re-pair, 撤销 again sends a new commandId', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let n = 0
    boot({ 'channel.telegram.unpair': () => { if (n++ === 0) fail(-32010, 'timeout'); return { ok: true } } })
    act(() => f.emit(ev('channel.paired', { channel: 'telegram', accountId: '42', name: 'Ann' })))
    s.byKey('mffai:paired:42')!.actions![0].run()
    await flush()
    act(() => f.emit(ev('channel.unpaired', { channel: 'telegram', accountId: '42', by: 'app' })))
    act(() => f.emit(ev('channel.paired', { channel: 'telegram', accountId: '42', name: 'Ann' })))
    s.byKey('mffai:paired:42')!.actions![0].run()
    await flush()
    const ids = f.callsOf('channel.telegram.unpair').map((p) => (p as { commandId: string }).commandId)
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('a timed-out 撤销, then a fresh channel.paired for that account (no unpaired seen): the next 撤销 sends a new commandId', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let n = 0
    boot({ 'channel.telegram.unpair': () => { if (n++ === 0) fail(-32010, 'timeout'); return { ok: true } } })
    act(() => f.emit(ev('channel.paired', { channel: 'telegram', accountId: '42', name: 'Ann' })))
    s.byKey('mffai:paired:42')!.actions![0].run()
    await flush()
    act(() => f.emit(ev('channel.paired', { channel: 'telegram', accountId: '42', name: 'Ann' })))
    s.byKey('mffai:paired:42')!.actions![0].run()
    await flush()
    const ids = f.callsOf('channel.telegram.unpair').map((p) => (p as { commandId: string }).commandId)
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('an IM-side unpair, a burned pairing, and unauthorized / conflict status are problems; online is not', () => {
    boot()
    act(() => {
      f.emit(ev('channel.unpaired', { channel: 'telegram', accountId: '42', by: 'im' }))
      f.emit(ev('channel.pairing.burned', { channel: 'telegram' }))
      f.emit(ev('channel.status', { channel: 'telegram', state: 'unauthorized' }))
    })
    expect(s.byKey('mffai:unpaired:42')!.t).toBe('<b>Telegram</b> 对方已解除配对')
    expect(s.byKey('mffai:burned:telegram')!.t).toBe('<b>Telegram</b> 配对码已作废')
    expect(s.byKey('mffai:channel:telegram')!.t).toBe('<b>Telegram</b> 令牌无效')
    act(() => f.emit(ev('channel.status', { channel: 'telegram', state: 'conflict' })))
    expect(s.byKey('mffai:channel:telegram')!.t).toBe('<b>Telegram</b> 冲突')
    const before = s.get().length
    act(() => f.emit(ev('channel.status', { channel: 'telegram', state: 'online' })))
    expect(s.get()).toHaveLength(before)
    s.byKey('mffai:channel:telegram')!.onOpen!()
    expect(route.get()).toEqual({ page: 'conn' })
  })

  it('executor.run.ended: `<executor> 完成 / 失败`, opening the session at that run', () => {
    boot()
    act(() => {
      f.emit(ev('executor.run.ended', { runId: 'r1', turnId: 't1', executor: 'codex', status: 'ok', ms: 1, changed: { files: [], source: 'git' } }, { sessionId: 's1' }))
      f.emit(ev('executor.run.ended', { runId: 'r2', turnId: 't1', executor: 'claude', status: 'failed', ms: 1, changed: { files: [], source: 'git' } }, { sessionId: 's1' }))
    })
    const ok = s.byKey('mffai:run:r1')!
    expect(ok.t).toBe('<b>codex</b> 完成')
    expect(ok.ic).toBe('ok')
    expect(s.byKey('mffai:run:r2')!.t).toBe('<b>claude</b> 失败')
    expect(s.byKey('mffai:run:r2')!.ic).toBe('warn')
    ok.onOpen!()
    expect(route.get()).toEqual({ page: 'chat', sessionId: 's1', runId: 'r1' })
  })

  it('plugin.failed, plugins.integrity.failed and the MCP server_failed / integrity_failed states; running is not', () => {
    boot()
    act(() => {
      f.emit(ev('plugin.failed', { id: 'zed', error: 'boom' }))
      f.emit(ev('plugins.integrity.failed', { id: 'yak' }))
      f.emit(ev('plugins.mcp.status', { plugin: 'zed', server: 'fs', state: 'server_failed', reason: 'server_exited' }))
      f.emit(ev('plugins.mcp.status', { plugin: 'zed', server: 'db', state: 'integrity_failed' }))
      f.emit(ev('plugins.mcp.status', { plugin: 'zed', server: 'ok', state: 'running' }))
    })
    expect(s.byKey('mffai:plugin:zed')!.t).toBe('<b>zed</b> 启动失败')
    expect(s.byKey('mffai:plugin:yak')!.t).toBe('<b>yak</b> 校验失败')
    expect(s.byKey('mffai:mcp:zed:fs')!.t).toBe('<b>zed · fs</b> 服务失败')
    expect(s.byKey('mffai:mcp:zed:db')!.t).toBe('<b>zed · db</b> 校验失败')
    expect(s.byKey('mffai:mcp:zed:ok')).toBeUndefined()
    s.byKey('mffai:plugin:zed')!.onOpen!()
    expect(route.get()).toEqual({ page: 'plugins' })
  })
})

describe('bell: third-party names are text (R1)', () => {
  it('a tool, plugin, server, executor, Telegram name and recommendation of <img onerror> leave no img in the popover', () => {
    boot()
    act(() => {
      f.emit(ev('approval.requested', { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: `t${XSS}`, summary: 'x' }, { sessionId: 's1' }))
      f.emit(ev('plugin.failed', { id: XSS, error: 'e' }))
      f.emit(ev('plugins.integrity.failed', { id: `<script>alert(1)</script>` }))
      f.emit(ev('plugins.mcp.status', { plugin: XSS, server: XSS, state: 'server_failed' }))
      f.emit(ev('channel.paired', { channel: 'telegram', accountId: '1', name: `a<b${XSS}` }))
      f.emit(ev('executor.run.ended', { runId: 'r1', turnId: 't1', executor: XSS, status: 'ok', ms: 1, changed: { files: [], source: 'git' } }, { sessionId: 's1' }))
      f.emit(ev('memory.recommendation', { id: 'r1', category: 'routine', habitId: 'h', text: `go ${XSS} "q" & 'z'`, cwd: '/w' }))
    })
    const { container } = popover(s.get())
    expect(container.querySelectorAll('img, script')).toHaveLength(0)
    expect(container.querySelectorAll('.ni-t b')).toHaveLength(6)
    const texts = [...container.querySelectorAll('.ni-t')].map((n) => n.textContent)
    expect(texts).toContain('go  "q" & \'z\'')
    expect(texts).toContain('Telegram 已配对 a')
  })
})

describe('bell: no secret reaches a notification (Task 10, Review Focus 8)', () => {
  it('pairing code and bot token fed through channel.pairing.* and channel.* events never appear', async () => {
    const TOKEN = ['1234567', 'AAH', 'tok', 'en_s3cret_xyz'].join('')
    const CODE = ['PAIR', '-', '7731'].join('')
    boot({ 'memory.proposals.list': { items: [proposal('p1', `remember ${TOKEN}`)] } })
    act(() => {
      f.emit(ev('channel.status', { channel: 'telegram', state: 'unauthorized', reason: `bad token ${TOKEN}` }))
      f.emit(ev('channel.status', { channel: 'telegram', state: 'conflict', reason: `code ${CODE}` }))
      f.emit(ev('channel.pairing.burned', { channel: 'telegram' }))
      f.emit(ev('channel.paired', { channel: 'telegram', accountId: '42', name: 'Ann' }))
      f.emit(ev('channel.unpaired', { channel: 'telegram', accountId: '9', by: 'im' }))
      f.emit(ev('plugin.failed', { id: 'channel-telegram', error: `token ${TOKEN} code ${CODE}` }))
      f.emit(ev('approval.requested', { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: 'shell', summary: `curl -H ${TOKEN} ${CODE}` }, { sessionId: 's1' }))
    })
    await flush()
    expect(s.get().length).toBeGreaterThan(5)
    const all = s.get().map((n) => [n.t, n.m, n.key, ...(n.actions ?? []).map((a) => a.label)].join('\n')).join('\n')
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain(CODE)
    const { container } = popover(s.get())
    expect(container.innerHTML).not.toContain(TOKEN)
    expect(container.innerHTML).not.toContain(CODE)
  })
})

describe('bell: lifecycle', () => {
  it('nothing is subscribed or called before start; stop unsubscribes, cancels the pending re-read and removes its notifications', async () => {
    f = installFakeForge({ calls: { 'memory.proposals.list': { items: [proposal('p1')] } } })
    expect(f.listeners()).toBe(0)
    expect(f.calls).toEqual([])
    vi.useFakeTimers()
    s = sinkOf()
    s.sink.upsert({ ic: 'ok', cls: 'ni-ok', t: 'app own', m: '', unread: true })
    const st = startBell(s.sink)
    await flush()
    expect(f.listeners()).toBe(1)
    act(() => f.emit(ev('approval.requested', { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'x' }, { sessionId: 's1' })))
    act(() => f.emit(ev('memory.updated', { op: 'x', source: 'user' })))
    st()
    expect(f.listeners()).toBe(0)
    expect(f.alertListeners()).toBe(0)
    expect(s.get().map((n) => n.t)).toEqual(['app own'])
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(f.callsOf('memory.proposals.list')).toHaveLength(1)
    expect(s.get().map((n) => n.t)).toEqual(['app own'])
  })

  it('a read answered after stop adds nothing', async () => {
    let resolve!: (v: { items: MemoryProposal[] }) => void
    f = installFakeForge({ calls: { 'memory.proposals.list': () => new Promise((r) => { resolve = r }) } })
    s = sinkOf()
    const st = startBell(s.sink)
    st()
    await act(async () => { resolve({ items: [proposal('p1')] }) })
    expect(s.get()).toEqual([])
  })
})
