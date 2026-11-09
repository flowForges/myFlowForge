// 一整天的脚本(08 计划 Task 14 Step 2):MffaiView 挂在假后台上,铃铛和弹层在旁边。
// 启用 → 加账号 → 带目录的新会话 → 流式回复带工具和审批(在铃铛里批)→ 委派运行挂起这一轮 → 重开 → 停止运行 → diff →
// 合并先被拒 dirty 再成功 → 回滚 → 改名 → 经同意页装插件 → `/` 命令 → 批一条待确认记忆 → 删会话 → 引用它的记忆 → 停用。
// 每个 RPC 都对着假后台的记录核对;DOM 里从来没有种下的秘密。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import type { KernelEvent, MemoryProposal, MffaiState, RunRow, SessionSummary } from '@mffai/protocol'
import MffaiView from './MffaiView'
import { startBell } from './bell'
import { route } from './route'
import { NotificationPopover } from '../shell/NotificationPopover'
import { removeNotif, upsertNotif, type Notif } from '../shell/notifications'
import { fail, installFakeForge, RUNNING_STATE, type CallTable, type FakeForge } from './test/fakeForge'
import { ev, resetSeq } from './test/events'
import { perms, runRow, summary } from './test/sessions'
import { detailOf, FULL_CONSENT, listRow, pluginList } from './test/plugins'
import { tgCalls, tgStatus } from './test/telegram'

const API_KEY = ['sk-', 'int', 'egration-', 'k3y-77'].join('')
const BOT_TOKEN = ['99887766', ':AAH', 'bell-tok3n'].join('')
const PAIR_CODE = ['PAIR', '-', '5150'].join('')
const PLUGIN_SECRET = ['plg-', 'sec', 'ret-', 'v4lue'].join('')
const SECRETS = [API_KEY, BOT_TOKEN, PAIR_CODE, PLUGIN_SECRET]

const S = 's1'
const model = { id: 'm1', name: 'M1', context: 1, output: 1, image: false, reasoning: 'none' as const, toolCall: true }
const preset = { id: 'p-key', label: 'Key套餐', billing: 'metered', restriction: 'none', auth: 'api-key', protocols: [], docsUrl: '' }

/** 铃铛只在启用后才起(App 的规则),和弹层一起挂在页面旁边 */
function Day({ bellOn }: { bellOn: boolean }) {
  const [ns, setNs] = useState<Notif[]>([])
  useEffect(() => {
    if (!bellOn) return
    return startBell({ upsert: (n) => setNs((x) => upsertNotif(x, n)), remove: (k) => setNs((x) => removeNotif(x, k)), open: () => {} })
  }, [bellOn])
  return (
    <>
      <div data-testid="bell">
        <NotificationPopover notifs={ns} updateAvailable={false} open onToggle={() => {}} onOpenUpgrade={() => {}}
          onMarkAllRead={() => {}} onClearAll={() => {}} onSelect={(n) => n.onOpen?.()} />
      </div>
      <MffaiView />
    </>
  )
}

let f: FakeForge
let log: KernelEvent[]
let sessions: SessionSummary[]
let runs: RunRow[]
let open: { turnId: string; parked: boolean; approvalIds: string[] } | undefined
let proposals: MemoryProposal[]
let accounts: { id: string; presetId: string; label: string; state: 'ok' }[]

const e = (type: Parameters<typeof ev>[0], payload: unknown) => ev(type, payload, { sessionId: S })
/** 写进会话日志(session.state 读得到),也实时推给页面 */
const live = (...es: KernelEvent[]) => act(() => { for (const x of es) { log.push(x); f.emit(x) } })
const bell = () => screen.getByTestId('bell')
const nav = (label: string) => [...document.querySelectorAll('.mffai-nav button')].find((b) => b.querySelector('.mffai-navlabel')?.textContent === label) as HTMLElement
const sessRow = (title: string) => [...document.querySelectorAll('.mffai-sess')].find((r) => r.querySelector('.mffai-sess-title')?.textContent === title) as HTMLElement
const card = (runId: string) => document.querySelector(`[data-run="${runId}"]`) as HTMLElement
const box = () => screen.getByRole('textbox', { name: '输入' }) as HTMLTextAreaElement
const dialog = () => screen.getByRole('dialog')

/** 每个 console.* 的间谍:秘密不进任何一条 */
let consoleSpies: ReturnType<typeof vi.spyOn>[] = []

function noSecrets(step: string) {
  const html = document.body.innerHTML
  for (const s of SECRETS) expect(html.includes(s), `${step}: ${s.slice(0, 4)}…`).toBe(false)
  // innerHTML 看不到输入框的 .value:逐个读
  for (const el of document.querySelectorAll('input, textarea')) {
    const v = (el as HTMLInputElement).value
    for (const s of SECRETS) expect(v.includes(s), `${step} input ${el.getAttribute('aria-label')}`).toBe(false)
  }
  for (const st of [localStorage, sessionStorage]) {
    for (let i = 0; i < st.length; i++) {
      const v = st.getItem(st.key(i)!) ?? ''
      for (const s of SECRETS) expect(v.includes(s), `${step} storage`).toBe(false)
    }
  }
  for (const spy of consoleSpies) {
    const all = JSON.stringify(spy.mock.calls)
    for (const s of SECRETS) expect(all.includes(s), `${step} console`).toBe(false)
  }
}

async function goto(label: string) {
  const b = await waitFor(() => { const x = nav(label); expect(x).toBeTruthy(); return x })
  await act(async () => { fireEvent.click(b) })
}

beforeEach(() => {
  resetSeq()
  route.set({ page: 'chat' })
  log = []
  sessions = []
  runs = []
  open = undefined
  proposals = []
  accounts = []
})
afterEach(() => { vi.restoreAllMocks(); consoleSpies = [] })

describe('a scripted day on the fake harness', () => {
  it('runs every page end to end, every RPC asserted, no planted secret on screen', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleSpies = [consoleSpy, ...(['log', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))]
    const table: CallTable = {
        status: { state: 'running', uptimeMs: 1, rssMb: 50, version: '0.1.0', plugins: [{ id: 'loop-default', state: 'active' }], problems: [], secretsBackend: 'keychain', sandbox: { level: 'full', missing: [], autoDegraded: false } },
        'session.list': () => ({ sessions: structuredClone(sessions) }),
        'session.state': (p) => {
          const s = sessions.find((x) => x.id === p.sessionId)
          if (!s) fail(-32602, 'unknown session')
          return { session: s!, events: structuredClone(log), hasMore: false, lastSeq: log.at(-1)?.seq ?? 0, ...(open && { open }) }
        },
        'session.create': (p) => {
          sessions = [summary(S, { title: '新会话', cwd: p.cwd, approvalMode: p.approvalMode ?? 'ask' })]
          return { sessionId: S }
        },
        'session.prompt': () => ({ accepted: true, turnId: 't1' }),
        'session.rename': (p) => { sessions = sessions.map((s) => (s.id === p.sessionId ? { ...s, title: p.title } : s)); return { ok: true } },
        'session.delete': (p) => { sessions = sessions.filter((s) => s.id !== p.sessionId); return { ok: true, redacted: 7, notes: ['n_q'] } },
        'memory.get': { id: 'n_q', layer: 'memory', text: '引用了那次会话的一条' },
        'memory.delete': { ok: true, redacted: 1, sources: [] },
        'permissions.get': perms('full'),
        'channel.telegram.chats': { chats: [], worktrees: [] },
        'channel.telegram.status': () => fail(-32601),
        'plugins.commands': { commands: [] },
        'approval.respond': { ok: true },
        'executor.runs': () => ({ runs: structuredClone(runs) }),
        'executor.cancel': { ok: true },
        'executor.changes': { files: [{ path: 'a.ts', status: 'M' }], source: 'git' },
        'executor.diff': { path: 'a.ts', status: 'M', binary: false, truncated: false, lines: [{ kind: 'del', ln: 1, text: 'old line' }, { kind: 'add', ln: 1, text: 'new line' }] },
        'executor.worktree.merge': () => fail(-32602, 'refused', { reason: 'dirty', paths: ['a.ts'] }),
        'turn.rollback': { ok: true, files: 1 },
        'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
        'memory.proposals.list': () => ({ items: structuredClone(proposals) }),
        'memory.proposals.decide': (p) => { proposals = proposals.filter((x) => x.id !== p.id); return { ok: true } },
        'memory.file.get': { content: '', hash: 'h', cap: 2000 },
        'memory.list': { items: [] },
        'plugins.list': pluginList(),
        'plugins.mcp.status': { servers: [] },
        'plugins.install.prepare': { stagingId: 'st1' },
        'plugins.install.status': { state: 'ready', consent: FULL_CONSENT, consentHash: 'hash-abc' },
        'plugins.install.confirm': { ok: true, id: 'zed-tools' },
        'plugins.command.run': { accepted: true, turnId: 't2' },
        'channel.telegram.config.get': { enabled: false, staleMinutes: 10, projects: [] },
        'models.quota': { windows: [{ label: '5h', usedPercent: 10 }] },
        'models.catalog': () => ({ presets: [preset], models: { 'p-key': [model] }, ...(accounts.length && { default: { accountId: 'a1', modelId: 'm1' } }) }) as never,
        'models.accounts': () => ({ accounts: structuredClone(accounts), secretsBackend: 'keychain' }) as never,
    }
    f = installFakeForge({ state: { enabled: false, running: false, supervisor: undefined, dataExists: false }, calls: table })
    f.mffai.enable.mockImplementation(async () => { f.setState({ ...RUNNING_STATE }); return f.mffai.state() })
    f.mffai.models.catalog.mockImplementation(async () => ({ presets: [preset], models: { 'p-key': [model] }, ...(accounts.length && { default: { accountId: 'a1', modelId: 'm1' } }) }))
    f.mffai.models.accounts.mockImplementation(async () => ({ accounts: structuredClone(accounts), secretsBackend: 'keychain' }))
    f.mffai.models.addAccount.mockImplementation(async () => { accounts = [{ id: 'a1', presetId: 'p-key', label: 'Key套餐', state: 'ok' }]; return accounts[0] })

    // ── 启用 ──
    const view = render(<Day bellOn={false} />)
    const enable = await screen.findByRole('button', { name: '启用' })
    await act(async () => { fireEvent.click(enable) })
    expect(f.forge.setSettings).toHaveBeenCalledWith({ mffai: { enabled: false, autostart: false } })
    expect(f.mffai.enable).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.querySelectorAll('.mffai-nav button')).toHaveLength(7))
    view.rerender(<Day bellOn />)
    await waitFor(() => expect(f.callsOf('memory.proposals.list').length).toBeGreaterThan(0))
    noSecrets('enable')

    // ── 加账号(新会话表单的模型位) ──
    fireEvent.click(await screen.findByRole('button', { name: '添加账号' }))
    const form = document.querySelector('input[type=password]')!.closest('.mffai-card, div') as HTMLElement
    fireEvent.change(document.querySelector('input[type=password]')!, { target: { value: API_KEY } })
    await act(async () => { fireEvent.click(within(form.parentElement ?? form).getByRole('button', { name: '添加' })) })
    expect(f.mffai.models.addAccount).toHaveBeenCalledTimes(1)
    expect(f.mffai.models.addAccount.mock.calls[0][0]).toMatchObject({ presetId: 'p-key', apiKey: API_KEY })
    await waitFor(() => expect((document.querySelector('.mffai-picker') as HTMLSelectElement)?.value).toBeTruthy())
    noSecrets('add account')

    // ── 带目录的新会话 ──
    fireEvent.change(screen.getByRole('textbox', { name: '工作目录' }), { target: { value: '/repo' } })
    const start = screen.getByRole('button', { name: '开始' }) as HTMLButtonElement
    await waitFor(() => expect(start.disabled).toBe(false))
    await act(async () => { fireEvent.click(start) })
    expect(f.callsOf('session.create')).toEqual([{ commandId: expect.any(String), model: { accountId: 'a1', modelId: 'm1' }, cwd: '/repo', approvalMode: 'ask' }])
    expect(route.get()).toEqual({ page: 'chat', sessionId: S })
    await waitFor(() => expect(f.callsOf('session.state')).toContainEqual({ sessionId: S }))

    // ── 发一句,流式回复带一个工具和一个审批;在铃铛里批 ──
    fireEvent.change(box(), { target: { value: 'fix the build' } })
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(f.callsOf('session.prompt')).toEqual([{ commandId: expect.any(String), sessionId: S, text: 'fix the build' }])
    open = { turnId: 't1', parked: false, approvalIds: [] }
    live(
      e('turn.started', { turnId: 't1' }),
      e('message.user', { turnId: 't1', text: 'fix the build' }),
      e('turn.snapshot', { turnId: 't1', phase: 'start', ref: 'refs/mffai/s1/t1-start' }),
      e('message.assistant.delta', { turnId: 't1', step: 1, text: 'looking at ' }),
      e('message.assistant.delta', { turnId: 't1', step: 1, text: 'the build' }),
      e('tool.started', { turnId: 't1', callId: 'c1', name: 'read', argsPreview: 'package.json' }),
      e('tool.ended', { turnId: 't1', callId: 'c1', name: 'read', ok: true, ms: 3, content: '{"name":"x"}' }),
      e('approval.requested', { approvalId: 'ap1', turnId: 't1', callId: 'c2', tool: 'shell', summary: 'npm test' }),
    )
    expect(await screen.findByText('looking at the build')).toBeInTheDocument()
    expect(screen.getByText('npm test')).toBeInTheDocument()
    const bellRow = within(bell()).getByText('shell').closest('.notif-item') as HTMLElement
    expect(within(bellRow).queryByText('npm test')).toBeNull()
    await act(async () => { fireEvent.click(within(bellRow).getByRole('button', { name: '允许' })) })
    expect(f.callsOf('approval.respond')).toEqual([{ approvalId: 'ap1', decision: 'allow' }])
    live(e('approval.resolved', { approvalId: 'ap1', decision: 'allow', by: 'user' }))
    expect(within(bell()).queryByText('shell')).toBeNull()
    expect(screen.getByText('已允许')).toBeInTheDocument()

    // ── 委派运行把这一轮挂起 ──
    live(
      e('executor.run.queued', { runId: 'r1', turnId: 't1', callId: 'c3', executor: 'codex', summary: 'fix it', readOnly: false, isolation: 'own', position: 0 }),
      e('executor.run.started', { runId: 'r1', turnId: 't1', executor: 'codex', cwd: '/wt/s1/r1', isolation: 'own', worktree: '/wt/s1/r1' }),
      e('executor.run.progress', { runId: 'r1', turnId: 't1', kind: 'tool', text: 'edit a.ts' }),
      e('turn.parked', { turnId: 't1', step: 1, active: 1, pending: 0 }),
    )
    open = { turnId: 't1', parked: true, approvalIds: [] }
    sessions = sessions.map((s) => ({ ...s, open: { turnId: 't1', parked: true } }))
    const composer = () => document.querySelector('.mffai-composer') as HTMLElement
    expect(await within(composer()).findByText('挂起 · 1 运行中')).toBeInTheDocument()

    // ── 重开:离开对话页再回来,卡片和 停止 都在(从 session.state 重读) ──
    const statesBefore = f.callsOf('session.state').length
    await goto('任务')
    await screen.findByTestId('mffai-page-tasks')
    await goto('对话')
    act(() => route.set({ page: 'chat', sessionId: S }))
    expect(await screen.findByText('edit a.ts')).toBeInTheDocument()
    expect(f.callsOf('session.state').length).toBeGreaterThan(statesBefore)
    expect(f.callsOf('session.state').at(-1)).toEqual({ sessionId: S })
    expect(within(card('r1')).getByRole('button', { name: '停止' })).toBeInTheDocument()
    expect(within(composer()).getByText('挂起 · 1 运行中')).toBeInTheDocument()

    // ── 停止这个运行;它结束、这一轮收尾 ──
    await act(async () => { fireEvent.click(within(card('r1')).getByRole('button', { name: '停止' })) })
    expect(f.callsOf('executor.cancel')).toEqual([{ commandId: expect.any(String), sessionId: S, runId: 'r1' }])
    runs = [runRow('r1', S, { status: 'cancelled', worktree: { path: '/wt/s1/r1', present: true }, changed: 1 })]
    live(
      e('executor.run.ended', { runId: 'r1', turnId: 't1', executor: 'codex', status: 'cancelled', ms: 900, changed: { files: ['a.ts'], source: 'git' }, worktree: '/wt/s1/r1' }),
      e('turn.resumed', { turnId: 't1', step: 1, cause: 'notice' }),
      e('message.assistant', { turnId: 't1', step: 2, text: 'stopped it' }),
      e('turn.snapshot', { turnId: 't1', phase: 'end', ref: 'refs/mffai/s1/t1-end', changed: 1 }),
      e('turn.ended', { turnId: 't1' }),
    )
    open = undefined
    sessions = sessions.map(({ open: _o, ...s }) => s)
    expect(await within(bell()).findByText('codex')).toBeInTheDocument()

    // ── diff ──
    fireEvent.click(await within(card('r1')).findByRole('button', { name: '1 个文件' }))
    fireEvent.click(await within(card('r1')).findByRole('button', { name: /a\.ts/ }))
    expect(await within(card('r1')).findByText('new line')).toBeInTheDocument()
    expect(f.callsOf('executor.changes')).toEqual([{ sessionId: S, runId: 'r1' }])
    expect(f.callsOf('executor.diff')).toEqual([{ sessionId: S, runId: 'r1', path: 'a.ts' }])

    // ── 合并:先被拒 dirty,再成功 ──
    fireEvent.click(await within(card('r1')).findByRole('button', { name: '合并' }))
    expect(dialog()).toHaveAccessibleName('合并到 /repo')
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '合并' })) })
    expect(await within(card('r1')).findByText('dirty')).toBeInTheDocument()
    f.script({ 'executor.worktree.merge': { ok: true, files: 1 } })
    fireEvent.click(within(card('r1')).getByRole('button', { name: '合并' }))
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '合并' })) })
    expect(await within(card('r1')).findByText('已合并 1 个文件')).toBeInTheDocument()
    const merges = f.callsOf('executor.worktree.merge') as { commandId: string }[]
    expect(merges).toEqual([{ commandId: expect.any(String), sessionId: S, runId: 'r1' }, { commandId: expect.any(String), sessionId: S, runId: 'r1' }])
    expect(merges[1].commandId).not.toBe(merges[0].commandId)

    // ── 回滚本轮 ──
    fireEvent.click(await screen.findByRole('button', { name: '回滚本轮' }))
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '回滚本轮' })) })
    expect(f.callsOf('turn.rollback')).toEqual([{ commandId: expect.any(String), sessionId: S, turnId: 't1' }])
    live(e('turn.rolledBack', { turnId: 't1', files: 1 }))

    // ── 改名 ──
    fireEvent.doubleClick(await waitFor(() => { const r = sessRow('新会话'); expect(r).toBeTruthy(); return r.querySelector('.mffai-sess-title')! }))
    fireEvent.change(screen.getByRole('textbox', { name: '标题' }), { target: { value: '修构建' } })
    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: '标题' }), { key: 'Enter' }) })
    expect(f.callsOf('session.rename')).toEqual([{ commandId: expect.any(String), sessionId: S, title: '修构建' }])
    live(e('session.renamed', { title: '修构建' }))
    await waitFor(() => expect(sessRow('修构建')).toBeTruthy())
    noSecrets('chat')

    // ── 经同意页装一个插件 ──
    await goto('插件')
    fireEvent.click(await screen.findByRole('button', { name: '添加' }))
    fireEvent.change(screen.getByLabelText('路径'), { target: { value: '/src/zed' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取' })) })
    expect(f.callsOf('plugins.install.prepare')).toEqual([{ source: { kind: 'path', path: '/src/zed' } }])
    const install = await screen.findByRole('button', { name: '安装并启用' })
    expect(document.querySelector('[data-section="claimed"]')).not.toBeNull()
    await act(async () => { fireEvent.click(install) })
    expect(f.callsOf('plugins.install.confirm')).toEqual([{
      commandId: expect.any(String), stagingId: 'st1', consentHash: 'hash-abc', enable: true,
      grants: { servers: { 'fs-server': { network: [], cwd: 'read' }, 'net-server': { network: [], cwd: 'read' } } },
    }])
    f.script({ 'plugins.commands': { commands: [{ name: 'zed:hello', plugin: 'zed-tools', description: 'say hi' }] } })
    live(ev('plugins.installed', { id: 'zed-tools', version: '1.0.0', integrity: 'sha256-x', format: 'claude', sourceKind: 'path' }))

    // ── `/` 命令 ──
    await goto('对话')
    act(() => route.set({ page: 'chat', sessionId: S }))
    await screen.findByText('stopped it')
    await waitFor(() => expect((f.callsOf('plugins.commands')).length).toBeGreaterThan(0))
    fireEvent.change(box(), { target: { value: '/zed:hello bob' } })
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    await waitFor(() => expect(f.callsOf('plugins.command.run')).toEqual([{ commandId: expect.any(String), sessionId: S, name: 'zed:hello', args: 'bob' }]))

    // ── 一条待确认记忆:铃铛里数字出现,在记忆页批准,铃铛里消失 ──
    proposals = [{ id: 'p1', target: 'MEMORY.md', op: 'add', text: '项目用 pnpm', evidence: [], source: 'extract', flags: [], status: 'pending', createdAt: 1 }]
    live(ev('memory.proposal', { id: 'p1', target: 'MEMORY.md', status: 'pending' }))
    expect(await within(bell()).findByText('待确认记忆 1', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(within(bell()).queryByText(/pnpm/)).toBeNull()
    await goto('记忆')
    fireEvent.click(await screen.findByRole('tab', { name: '待确认' }))
    const approve = await screen.findByRole('button', { name: '批准' })
    await act(async () => { fireEvent.click(approve) })
    expect(f.callsOf('memory.proposals.decide')).toEqual([{ commandId: expect.any(String), id: 'p1', decision: 'approve', text: '项目用 pnpm' }])
    live(ev('memory.updated', { id: 'n_new', op: 'approve', source: 'user' }))
    await waitFor(() => expect(within(bell()).queryByText(/待确认记忆/)).toBeNull(), { timeout: 2000 })

    // ── 删会话,然后引用它的记忆 ──
    await goto('对话')
    await waitFor(() => expect(sessRow('修构建')).toBeTruthy())
    fireEvent.click(within(sessRow('修构建')).getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    const del = await screen.findByRole('dialog', { name: '删除会话' })
    await waitFor(() => expect((within(del).getByRole('button', { name: /删除/ }) as HTMLButtonElement).disabled).toBe(false))
    await act(async () => { fireEvent.click(within(del).getByRole('button', { name: /删除/ })) })
    const delCalls = f.callsOf('session.delete') as { sessionId: string }[]
    expect(delCalls).toHaveLength(1)
    expect(delCalls[0]).toMatchObject({ commandId: expect.any(String), sessionId: S })
    live(e('session.deleted', {}))
    const notesBox = await screen.findByRole('dialog', { name: '仍引用它的记忆 1 条' })
    expect(await within(notesBox).findByText('引用了那次会话的一条')).toBeInTheDocument()
    await act(async () => { fireEvent.click(within(notesBox).getByRole('button', { name: '删除' })) })
    expect(f.callsOf('memory.delete')).toEqual([{ commandId: expect.any(String), id: 'n_q' }])
    fireEvent.click(await screen.findByRole('button', { name: '关闭' }))
    await waitFor(() => expect(sessRow('修构建')).toBeUndefined())

    // ── 种下的秘密经事件进来:铃铛和页面都不显示 ──
    live(
      ev('channel.status', { channel: 'telegram', state: 'unauthorized', reason: `token ${BOT_TOKEN}` }),
      ev('channel.pairing.burned', { channel: 'telegram' }),
      ev('plugin.failed', { id: 'channel-telegram', error: `code ${PAIR_CODE} token ${BOT_TOKEN}` }),
    )
    expect(await within(bell()).findByText('配对码已作废', { exact: false })).toBeInTheDocument()
    noSecrets('events')

    // ── 停用 ──
    f.setState({ enabled: false, running: false, supervisor: undefined })
    view.rerender(<Day bellOn={false} />)
    act(() => f.alert({ kind: 'restarting' }))
    expect(await screen.findByRole('button', { name: '启用' })).toBeInTheDocument()
    await waitFor(() => expect(f.listeners()).toBe(0))
    expect(within(bell()).queryByText('codex')).toBeNull()
    noSecrets('disabled')

    // 没有一次 RPC 是页面直接调 window.forge.mffai.* 的旧通道(调试面板除外,这里没打开)
    expect(f.mffai.approvalRespond).not.toHaveBeenCalled()
    expect(f.mffai.rollback).not.toHaveBeenCalled()
    expect(f.mffai.prompt).not.toHaveBeenCalled()
    // 每次调用都落在脚本表里(没有一次意外的 -32601),没有一条 console.error
    const unscripted = [...new Set(f.calls.map((c) => c.method))].filter((m) => !Object.hasOwn(table, m))
    expect(unscripted).toEqual([])
    expect(consoleSpy.mock.calls.map((c) => String(c[0]) + " " + JSON.stringify(c.slice(1)).slice(0, 200))).toEqual([])
  }, 60_000)

  it('the bot token, a pairing code and a plugin secret go through the real inputs and flows and are gone after (M7)', async () => {
    consoleSpies = (['error', 'log', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    let tg = tgStatus({ tokenSet: false, bot: undefined, state: 'no_token' })
    let detail = detailOf(FULL_CONSENT, { settings: [{ key: 'API_TOKEN', set: false, sensitive: true }] })
    const table: CallTable = {
      ...tgCalls(),
      status: { state: 'running', uptimeMs: 1, rssMb: 50, version: '0.1.0', plugins: [], problems: [], secretsBackend: 'keychain', sandbox: { level: 'full', missing: [], autoDegraded: false } },
      'session.list': { sessions: [] },
      'memory.proposals.list': { items: [] },
      'models.catalog': { presets: [], models: {} } as never,
      'models.accounts': { accounts: [], secretsBackend: 'keychain' } as never,
      'channel.telegram.status': () => structuredClone(tg),
      'channel.telegram.setToken': (p) => {
        expect(p).toEqual({ token: BOT_TOKEN })
        tg = tgStatus({ tokenSet: true })
        return { ok: true, bot: { id: 1, username: 'my_test_bot' } }
      },
      'channel.telegram.pairing.begin': { code: PAIR_CODE, expiresAt: Date.now() + 300_000, link: `https://t.me/my_test_bot?start=${PAIR_CODE}` },
      'channel.telegram.pairing.cancel': { ok: true },
      'plugins.list': pluginList({ plugins: [listRow('zed-tools')] }),
      'plugins.get': () => structuredClone(detail),
      'plugins.mcp.status': { servers: [] },
      'plugins.settings.set': (p) => {
        expect(p).toEqual({ id: 'zed-tools', key: 'API_TOKEN', value: PLUGIN_SECRET })
        detail = detailOf(FULL_CONSENT, { settings: [{ key: 'API_TOKEN', set: true, sensitive: true }] })
        return { ok: true }
      },
    }
    f = installFakeForge({ state: { ...RUNNING_STATE }, calls: table })
    render(<Day bellOn />)

    // ── 令牌:真的输入框,保存后框里是空的 ──
    await goto('连接')
    fireEvent.click(await screen.findByRole('tab', { name: 'Telegram' }))
    const token = await screen.findByLabelText('令牌') as HTMLInputElement
    fireEvent.change(token, { target: { value: BOT_TOKEN } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存令牌' })) })
    expect(f.callsOf('channel.telegram.setToken')).toHaveLength(1)
    await waitFor(() => expect((screen.getByLabelText('令牌') as HTMLInputElement).value).toBe(''))
    noSecrets('token saved')

    // ── 配对码:开始配对后看得见,channel.paired 之后没了,铃铛里从来没有 ──
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '开始配对' })) })
    expect(await screen.findByText(PAIR_CODE)).toBeInTheDocument()
    expect(within(bell()).queryByText(PAIR_CODE, { exact: false })).toBeNull()
    tg = tgStatus({ tokenSet: true, paired: [{ accountId: '42', name: 'Ann', pairedAt: Date.now() }] })
    act(() => f.emit(ev('channel.paired', { channel: 'telegram', accountId: '42', name: 'Ann' })))
    await waitFor(() => expect(document.body.innerHTML.includes(PAIR_CODE)).toBe(false))
    expect(within(bell()).getByText('Ann')).toBeInTheDocument()
    noSecrets('paired')

    // ── 插件的敏感配置:真的密码框,保存后框里是空的,只显示 已设置 ──
    await goto('插件')
    fireEvent.click(await screen.findByRole('button', { name: '详情' }))
    const secret = await screen.findByLabelText('API_TOKEN') as HTMLInputElement
    fireEvent.change(secret, { target: { value: PLUGIN_SECRET } })
    const row = secret.closest('[data-setting="API_TOKEN"]') as HTMLElement
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '保存' })) })
    expect(f.callsOf('plugins.settings.set')).toHaveLength(1)
    await waitFor(() => expect(within(document.querySelector('[data-setting="API_TOKEN"]') as HTMLElement).getByText('已设置')).toBeInTheDocument())
    expect((screen.getByLabelText('API_TOKEN') as HTMLInputElement).value).toBe('')
    noSecrets('plugin secret saved')
  }, 60_000)
})
