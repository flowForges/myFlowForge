// 每个页面用夹具数据渲染,不能有 class 含 hint/desc/help/note/tip/caption 的元素,也不能有 <p>、<small>。
// ★页面任务(6–13)往 ROWS 里追加自己的行。
import { describe, it, expect, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import MffaiView from './MffaiView'
import { StatusStrip } from './StatusStrip'
import { EnableCard } from './EnableCard'
import DebugPage from './debug/DebugPage'
import { Confirm } from './ui/Confirm'
import { AutoSwitch, UNSANDBOXED_AUTO_LABEL } from './ui/AutoSwitch'
import { DiffLines } from './ui/DiffLines'
import { Countdown } from './ui/Countdown'
import { PathField } from './ui/PathField'
import { Chip } from './ui/Chip'
import { CodeChip } from './ui/CodeChip'
import { route } from './route'
import ChatPage from './chat/ChatPage'
import { DeleteSession } from './chat/DeleteSession'
import { DeleteSources } from './ui/DeleteSources'
import { MffaiComposer } from './chat/MffaiComposer'
import { NewSession } from './chat/NewSession'
import { RunCard } from './chat/RunCard'
import { TurnTail } from './chat/TurnTail'
import { ApprovalCard } from './chat/ApprovalCard'
import TasksPage from './tasks/TasksPage'
import ConnectionsPage from './conn/ConnectionsPage'
import { perms, runRow, summary } from './test/sessions'
import { fail, installFakeForge, RUNNING_STATE, type CallTable, type FakeForge } from './test/fakeForge'
import { ev, resetSeq, userMsg } from './test/events'
import { findHints } from './test/noHint'
import { tgCalls, tgStatus } from './test/telegram'

const roots = { data: '/d/mff-ai', worktrees: '/d/mff-ai-worktrees', imWorktrees: '/d/mff-ai-im', plugins: '/d/mff-ai-plugins', keychain: 'myflowforge-mffai/x' }

/** 尽量把每个状态块都点亮的共用夹具 */
export function richCalls(): CallTable {
  return {
    status: {
      state: 'running', uptimeMs: 1, rssMb: 50, version: '0.1.0',
      plugins: [{ id: 'loop-default', state: 'active' }, { id: 'broken', state: 'failed', error: 'boom' }, { id: 'mine', state: 'active', trust: 'dev' }],
      problems: ['dev_crashed', 'unknown_code_x'], secretsBackend: 'plaintext-file', dbUnprotected: true,
      sandbox: { level: 'partial', missing: ['proxy'], autoDegraded: true },
    },
    'session.list': { sessions: [{ id: 's1', title: 'one', origin: 'app', audience: 'owner', approvalMode: 'ask', createdAt: 1, updatedAt: 1, pendingApprovals: 2 }] },
    'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 1, problems: [] },
    'models.catalog': { presets: [], models: { p: [{ id: 'm1', name: 'GPT-5', context: 1, output: 1, image: false, reasoning: 'none', toolCall: true }] }, default: { accountId: 'a1', modelId: 'm1' } },
    'models.accounts': { accounts: [{ id: 'a1', presetId: 'p', label: '主账号', state: 'ok' }], secretsBackend: 'plaintext-file' },
    'models.quota': { windows: [{ label: '5h', usedPercent: 40 }] },
    'events.tail': { events: [
      userMsg('s1', 't1', 'hi'),
      ev('memory.injected', { turnId: 't1', kind: 'session', text: 'mem', items: [], truncated: true }, { sessionId: 's1' }),
      ev('plugins.injected', { turnId: 't1', text: 'skill', skill: true, mcp: true }, { sessionId: 's1' }),
    ] },
    'plugins.list': { plugins: [], dev: [], problems: ['store_corrupt'] },
  }
}

type Row = { name: string; mount: (f: FakeForge) => Promise<void> | void }

const ROWS: Row[] = [
  ...(['对话', '任务', '记忆', '插件', '连接', '权限', '调试'] as const).map((label): Row => ({
    name: `shell: ${label}`,
    mount: async (f) => {
      f.setState({ proxyStale: true, sandbox: { level: 'partial', missing: ['proxy'], autoDegraded: true } })
      render(<MffaiView />)
      await waitFor(() => expect(document.querySelectorAll('.mffai-nav button')).toHaveLength(7))
      const btn = [...document.querySelectorAll('.mffai-nav button')].find((b) => b.querySelector('.mffai-navlabel')?.textContent === label)!
      fireEvent.click(btn)
      await screen.findByTestId(`mffai-page-${route.get().page}`)
      await screen.findByText('主账号 · GPT-5')
    },
  })),
  {
    name: 'shell: not running',
    mount: async (f) => {
      f.setState({ running: false, supervisor: { ...RUNNING_STATE.supervisor!, state: 'tripped' } })
      render(<MffaiView />)
      await screen.findByText('重新启动')
    },
  },
  {
    name: 'enable card with delete-all confirm open, then a refused wipe',
    mount: async (f) => {
      f.setState({ enabled: false, running: false, supervisor: undefined, dataExists: true, roots })
      f.mffai.wipe.mockResolvedValue({ ok: false, reason: 'running' })
      render(<MffaiView />)
      fireEvent.click(await screen.findByText('删除全部数据'))
      await screen.findByRole('dialog')
      expect(findHints()).toEqual([])
      fireEvent.click(screen.getAllByText('删除全部数据').at(-1)!)
      await screen.findByText('running')
    },
  },
  ...(['面板', '注入', '插件', '原始'] as const).map((t): Row => ({
    name: `debug: ${t}`,
    mount: async () => {
      render(<DebugPage />)
      fireEvent.click(screen.getByRole('tab', { name: t }))
      if (t === '原始') {
        const list = await screen.findByRole('listbox', { name: '事件' })
        await waitFor(() => expect(within(list).queryAllByRole('option').length).toBeGreaterThan(0))
        fireEvent.click(within(list).getAllByRole('option')[0])
      }
      if (t === '注入') await screen.findByText('mem')
      if (t === '插件') await screen.findByText('store_corrupt')
    },
  })),
  {
    name: 'chat: every row chip, an open IM session, a rename that failed, the row menu',
    mount: async (f) => {
      f.script({
        'session.list': { sessions: [
          summary('a', { title: '本机', pendingApprovals: 2, updatedAt: Date.now() - 120_000 }),
          summary('b', { title: '群', origin: 'im', audience: 'group', open: { turnId: 't', parked: true }, updatedAt: 9 }),
          summary('c', { title: '编辑器', origin: 'acp', open: { turnId: 't', parked: false }, updatedAt: 5 }),
          summary('d', { title: '定时', origin: 'schedule', updatedAt: 1 }),
        ] },
        'channel.telegram.chats': { chats: [{ chatId: '7', accountId: '7', sessionId: 'b', queued: 0, running: true }], worktrees: [] },
        'session.rename': () => fail(-32010, 'timeout'),
        'plugins.commands': { commands: [] },
      })
      route.set({ page: 'chat', sessionId: 'b' })
      render(<ChatPage />)
      const title = await screen.findByText('本机')
      await screen.findByText('Telegram · 7')
      fireEvent.doubleClick(title)
      fireEvent.change(screen.getByRole('textbox', { name: '标题' }), { target: { value: 'x' } })
      fireEvent.keyDown(screen.getByRole('textbox', { name: '标题' }), { key: 'Enter' })
      await screen.findByText('失败')
      fireEvent.click(screen.getAllByRole('button', { name: '更多' })[0])
      await screen.findByRole('menu')
    },
  },
  {
    name: 'chat: the composer with the / menu open, parked, 停止 and 忙',
    mount: async (f) => {
      f.script({ 'plugins.commands': { commands: [{ name: 'zed:b', plugin: 'zed', description: 'say hi', argumentHint: '<who>' }, { name: 'zed:a', plugin: 'zed', description: 'a' }] } })
      render(<MffaiComposer session={{ id: 's1', origin: 'app' }} canStop parked={{ running: 2 }} onStop={() => {}}
        onCommand={async () => {}} onSend={async () => { throw { code: -32003, message: 'busy' } }} />)
      const box = screen.getByRole('textbox', { name: '输入' })
      fireEvent.change(box, { target: { value: 'hi' } })
      fireEvent.keyDown(box, { key: 'Enter' })
      await screen.findByText('忙')
      fireEvent.change(box, { target: { value: '/' } })
      await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2))
    },
  },
  {
    name: 'chat: new-session form with a cwd and 需审批, a failed start',
    mount: async (f) => {
      f.script({ 'permissions.get': perms('none'), 'session.create': () => fail(-32603, 'x') })
      f.mffai.models.catalog.mockResolvedValue({ presets: [], models: { p: [{ id: 'm1', name: 'M1', context: 1, output: 1, image: false, reasoning: 'none', toolCall: true }] }, default: { accountId: 'a1', modelId: 'm1' } })
      f.mffai.models.accounts.mockResolvedValue({ accounts: [{ id: 'a1', presetId: 'p', label: 'acc', state: 'ok' }], secretsBackend: 'keychain' })
      render(<NewSession initial={{ cwd: '/repo' }} onCreated={() => {}} />)
      await screen.findByText('需审批')
      const start = screen.getByRole('button', { name: '开始' }) as HTMLButtonElement
      await waitFor(() => expect(start.disabled).toBe(false))
      fireEvent.click(start)
      await screen.findByText('失败')
    },
  },
  {
    name: 'chat: new-session form without accounts (AddAccount open)',
    mount: async (f) => {
      f.mffai.models.catalog.mockResolvedValue({ presets: [{ id: 'p', label: 'Key', billing: 'metered', restriction: 'none', auth: 'api-key', protocols: [], docsUrl: '' }], models: {} })
      render(<NewSession onCreated={() => {}} />)
      fireEvent.click(await screen.findByText('添加账号'))
      await screen.findByText('添加')
    },
  },
  {
    name: 'chat: an IM session read-only row',
    mount: () => {
      render(<MffaiComposer session={{ id: 's1', origin: 'im' }} imName="Alice" canStop onStop={() => {}} onSend={async () => {}} onCommand={async () => {}} />)
    },
  },
  {
    name: 'chat: delete confirm with unmerged runs and IM source, then 不支持',
    mount: async (f) => {
      f.script({
        'executor.runs': { runs: [runRow('r1', 's1', { worktree: { path: '/w', present: true }, changed: 3 }), runRow('r2', 's1', { worktree: { path: '/w2', present: true } })] },
        'session.delete': () => fail(-32601),
      })
      render(<DeleteSession session={summary('s1', { title: 't', origin: 'im' })} onClose={() => {}} onDeleted={() => {}} />)
      const btn = await screen.findByRole('button', { name: '删除并丢弃改动' })
      fireEvent.click(btn)
      await screen.findByText('不支持')
    },
  },
  {
    name: 'chat: the notes box after delete',
    mount: async (f) => {
      f.script({ 'memory.get': { id: 'n_a', layer: 'memory', text: '引用' }, 'memory.delete': () => fail(-32010) })
      render(<DeleteSources title={(n) => `仍引用它的记忆 ${n} 条`} ids={['n_a', 'n_b']} onClose={() => {}} />)
      await screen.findAllByText('引用')
      fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0])
      await screen.findByText('失败')
    },
  },
  {
    name: 'chat: a full turn (steps, think, tools, approvals, runs, tail), the memory list, the changes diff and the rollback confirm',
    mount: async (f) => {
      const S = 'sx'
      const e = (type: Parameters<typeof ev>[0], payload: unknown) => ev(type, payload, { sessionId: S })
      const evs = [
        e('message.user', { turnId: 't0', text: 'first' }),
        e('turn.snapshot', { turnId: 't0', phase: 'start', ref: 's' }), e('turn.snapshot', { turnId: 't0', phase: 'end', ref: 'e', changed: 2 }),
        e('memory.injected', { turnId: 't0', kind: 'turn', text: 'm', items: ['n_a'] }),
        e('plugins.injected', { turnId: 't0', text: 'p', skill: true, mcp: false }),
        e('context.rebuilt', { turnId: 't0', step: 1, checkpointSeq: 1, throughSeq: 1, before: 900, after: 300 }),
        e('message.reasoning.delta', { turnId: 't0', step: 1, text: 'thinking' }),
        e('message.assistant', { turnId: 't0', step: 1, text: '# Title\n\n- a list\n\n```ts\nconst x = 1\n```\n[link](https://example.com)' }),
        e('tool.started', { turnId: 't0', callId: 'c1', name: 'read', argsPreview: 'a.ts' }),
        e('tool.ended', { turnId: 't0', callId: 'c1', name: 'read', ok: true, ms: 1, content: 'body', truncated: true }),
        e('approval.requested', { approvalId: 'p0', turnId: 't0', callId: 'c2', tool: 'shell', summary: 'ls' }),
        e('approval.resolved', { approvalId: 'p0', decision: 'deny', by: 'timeout' }),
        e('sandbox.netDenied', { host: 'h', port: 1, reason: 'x' }),
        e('session.approvalNarrowed', { approvalMode: 'ask' }),
        e('turn.usage', { turnId: 't0', step: 1, input: 1, output: 2, cacheRead: 3 }),
        e('turn.ended', { turnId: 't0' }),
        e('message.user', { turnId: 't1', text: 'second' }),
        e('turn.snapshot', { turnId: 't1', phase: 'start', reason: 'unsafe_filter' }),
        e('executor.run.queued', { runId: 'rq', turnId: 't1', callId: 'c', executor: 'claude', summary: 's', readOnly: true, isolation: 'none', position: 2 }),
        e('executor.run.started', { runId: 'r1', turnId: 't1', executor: 'codex', cwd: '/repo', isolation: 'wrapped', worktree: '/wt', untranslatedRules: 1 }),
        ...Array.from({ length: 7 }, (_, i) => e('executor.run.progress', { runId: 'r1', turnId: 't1', kind: (['tool', 'file', 'text', 'think'] as const)[i % 4], text: `p${i}` })),
        e('executor.run.ended', { runId: 'r1', turnId: 't1', executor: 'codex', status: 'failed', reason: 'exit_nonzero', ms: 2000, exit: 1, usage: { input: 1, output: 1 },
          changed: { files: ['a.ts'], source: 'git', concurrent: true, filesTruncated: 1 }, violations: ['v'], violationsTruncated: 1, rawLog: '/raw', droppedProgress: 3, worktree: '/wt' }),
        e('approval.requested', { approvalId: 'p1', turnId: 't1', callId: 'c3', tool: 'shell', summary: 'rm -rf build', key: 'k', unsandboxed: true }),
        e('turn.parked', { turnId: 't1', step: 1, active: 1, pending: 1 }),
      ]
      f.script({
        'session.list': { sessions: [summary(S, { open: { turnId: 't1', parked: true } })] },
        'session.state': { session: summary(S), events: evs, hasMore: true, lastSeq: evs.at(-1)!.seq, open: { turnId: 't1', parked: true, approvalIds: ['p1'] } },
        'plugins.commands': { commands: [] },
        'memory.get': { id: 'n_a', layer: 'memory', text: 'remembered' },
        'executor.changes': { files: [{ path: 'a.ts', status: 'M' }], source: 'git', concurrent: true },
        'executor.diff': { path: 'a.ts', status: 'M', binary: false, truncated: true, lines: [{ kind: 'del', ln: 1, text: 'old' }] },
        'executor.worktree.merge': () => fail(-32602, 'refused', { reason: 'conflict', restored: false, paths: ['a.ts'] }),
        'executor.runs': { runs: [runRow('r1', S, { worktree: { path: '/wt', present: true }, changed: 2 })] },
      })
      route.set({ page: 'chat', sessionId: S })
      render(<ChatPage />)
      await screen.findByText('rm -rf build')
      fireEvent.click(screen.getByRole('button', { name: '记忆 1' }))
      await screen.findByText('remembered')
      fireEvent.click(screen.getByRole('button', { name: '全部 7' }))
      fireEvent.click(screen.getByRole('button', { name: '2 个文件' }))
      fireEvent.click(await screen.findByText('a.ts', { selector: '.mffai-path' }))
      await screen.findByText('old')
      fireEvent.click(await screen.findByRole('button', { name: '合并' }))
      await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '合并' })) })
      await screen.findByText('未还原')
    },
  },
  {
    name: 'chat: the rollback confirm and a failed rollback; resolved approval lines; a queued run',
    mount: async (f) => {
      f.script({ 'turn.rollback': () => fail(-32603, 'x'), 'approval.respond': () => fail(-32603, 'x') })
      const turn = { turnId: 't1', seq: 1, users: [], steps: [], approvals: [], runs: new Map(), netDenied: [], terminal: { type: 'turn.failed' as const, reason: 'cancelled' }, snapshot: { start: 'a', end: 'b', changed: 1 } }
      render(
        <>
          <TurnTail sessionId="s1" canRollback turn={turn} />
          <ApprovalCard sessionId="s1" approval={{ approvalId: 'p', turnId: 't1', callId: 'c', tool: 'mcp__x', summary: 'x', seq: 1, resolved: { decision: 'allow', by: 'user', via: 'telegram:1' } }} />
          <ApprovalCard sessionId="s1" approval={{ approvalId: 'q', turnId: 't1', callId: 'c', tool: 'shell', summary: 'y', seq: 2 }} />
          <RunCard sessionId="s1" turnOpen run={{ runId: 'r', turnId: 't1', seq: 1, phase: 'queued', executor: 'codex', position: 1, readOnly: false, isolation: 'own', progress: [] }} />
        </>,
      )
      fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
      await screen.findByText('失败')
      fireEvent.click(screen.getByRole('button', { name: '回滚本轮' }))
      await screen.findByRole('dialog')
      expect(findHints()).toEqual([])
      await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '回滚本轮' })) })
      await waitFor(() => expect(screen.getAllByText('失败')).toHaveLength(2))
    },
  },
  {
    name: 'tasks: three groups, 已合并, N / 20, merge/discard confirms, IM worktree changes, and 不支持',
    mount: async (f) => {
      f.script({
        'executor.runs': { runs: [
          runRow('rr', 's1', { phase: 'running', worktree: undefined, changed: undefined }),
          runRow('rq', 's1', { phase: 'queued', worktree: undefined, changed: undefined }),
          runRow('re', 's1', { worktree: { path: '/wt/re', present: true, bytes: 4096 }, changed: 2 }),
          runRow('rm', 's1', { worktree: { path: '/wt/rm', present: true, merged: true }, changed: 1 }),
        ] },
        'channel.telegram.chats': { chats: [], worktrees: [
          { id: 'w1', project: 'proj', path: '/im/w1', sessionIds: [], createdAt: Date.now(), bytes: 1024, usedByChat: '7' },
        ] },
        'session.list': { sessions: [summary('s1', { title: '一号', cwd: '/repo' })] },
        'channel.telegram.config.get': { enabled: true, staleMinutes: 10, projects: [{ name: 'proj', path: '/checkout/proj', auto: false }] },
        'channel.telegram.worktree.changes': { files: [{ path: 'a.ts', status: 'M' }] },
        'channel.telegram.worktree.diff': { path: 'a.ts', status: 'M', binary: false, truncated: false, lines: [{ kind: 'add', ln: 1, text: 'x' }] },
      })
      render(<TasksPage />)
      await screen.findByText('proj')
      const reRow = document.querySelector('[data-run="re"]') as HTMLElement
      fireEvent.click(within(reRow).getByRole('button', { name: '合并' }))
      await screen.findByRole('dialog')
      expect(findHints()).toEqual([])
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      const wtRow = (await screen.findByText('proj')).closest('[data-worktree]') as HTMLElement
      fireEvent.click(await within(wtRow).findByRole('button', { name: '合并' }))
      await screen.findByRole('dialog')
      expect(findHints()).toEqual([])
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      fireEvent.click(within(wtRow).getByRole('button', { name: '改动' }))
      await within(wtRow).findByText('a.ts')
      fireEvent.click(within(wtRow).getByRole('button', { name: '丢弃' }))
      await screen.findByRole('dialog')
      expect(findHints()).toEqual([])
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
    },
  },
  {
    name: 'tasks: executor.runs and channel.telegram.chats both unsupported',
    mount: async (f) => {
      f.script({ 'executor.runs': () => fail(-32601), 'channel.telegram.chats': () => fail(-32601) })
      render(<TasksPage />)
      await waitFor(() => expect(screen.getAllByText('不支持')).toHaveLength(2))
    },
  },
  {
    name: 'conn: model select + 重新登录 + custom preset fields, executor rows with missing codes, Telegram placeholder',
    mount: async (f) => {
      const m = (id: string, name: string) => ({ id, name, context: 1, output: 1, image: false, reasoning: 'none', toolCall: true })
      f.mffai.models.catalog.mockResolvedValue({
        presets: [
          { id: 'p-gpt', label: 'ChatGPT', billing: 'subscription', restriction: 'none', auth: 'chatgpt-oauth', protocols: [], docsUrl: '' },
          { id: 'custom-x', label: '自定义', billing: 'metered', restriction: 'none', auth: 'api-key', protocols: [], docsUrl: '' },
        ],
        models: { 'p-gpt': [m('m1', 'M1'), m('m2', 'M2')] },
        default: { accountId: 'g1', modelId: 'm2' },
      })
      f.mffai.models.accounts.mockResolvedValue({ accounts: [{ id: 'g1', presetId: 'p-gpt', label: 'gpt', state: 'needs_login' }], secretsBackend: 'unavailable' })
      f.mffai.chatgpt.begin.mockResolvedValue({ flowId: 'f1', authUrl: 'http://x' })
      f.script({ ...tgCalls(tgStatus({
        state: 'conflict', reason: 'webhook_set', undelivered: 2, problems: ['save_failed'], secretsBackend: 'plaintext-file', proxy: 'env',
        paired: [{ accountId: '42', name: 'Ann', pairedAt: 1 }], pairing: { active: true, expiresAt: Date.now() + 60_000 },
      })),
      'permissions.get': perms('partial'),
      'channel.telegram.chats': { chats: [{ chatId: 'c1', accountId: '42', sessionId: 's1', project: 'api', model: { accountId: 'a1', modelId: 'm1' }, queued: 1, running: true }], worktrees: [] },
      'channel.telegram.pairing.begin': () => ({ code: 'AB12-CD34', expiresAt: Date.now() + 60_000, link: 'https://t.me/my_test_bot?start=AB12CD34' }),
      'channel.telegram.config.set': () => fail(-32602, 'invalid_project') })
      f.script({ 'executor.list': { executors: [
        { id: 'claude', installed: true, version: '1.0.0', auth: 'ok', isolation: 'own', missing: [] },
        { id: 'codex', installed: false, auth: 'missing', isolation: 'none', missing: ['codex_selftest'] },
      ] } })
      render(<ConnectionsPage />)
      await screen.findByText('gpt')
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'm1' } })
      fireEvent.click(screen.getByText('重新登录'))
      await waitFor(() => expect(f.mffai.chatgpt.begin).toHaveBeenCalled())
      fireEvent.click(screen.getByText('添加账号'))
      fireEvent.change(screen.getAllByRole('combobox').at(-1)!, { target: { value: 'custom-x' } })
      await screen.findByLabelText('模型 id')
      expect(findHints()).toEqual([])
      fireEvent.click(screen.getByRole('tab', { name: '执行器' }))
      await screen.findByText('claude')
      await screen.findByText('codex_selftest')
      fireEvent.click(screen.getByRole('tab', { name: 'Telegram' }))
      await screen.findByRole('button', { name: '清除 webhook' })
      await screen.findByTestId('mffai-tg-chat')
      await screen.findByText('部分')
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开始配对' })) })
      await screen.findByText('AB12-CD34')
      fireEvent.change(screen.getByLabelText('别名'), { target: { value: 'x' } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
      await screen.findByText('invalid_project')
      expect(findHints()).toEqual([])
      fireEvent.click(screen.getByRole('button', { name: '撤销' }))
      expect(findHints()).toEqual([])
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
      fireEvent.click(screen.getByRole('button', { name: '清除令牌' }))
      await screen.findByRole('dialog')
    },
  },
  {
    name: 'connections: Telegram unsupported',
    mount: async () => {
      render(<ConnectionsPage />)
      fireEvent.click(screen.getByRole('tab', { name: 'Telegram' }))
      await screen.findByText('不支持')
    },
  },
  {
    name: 'strip: every chip',
    mount: () => {
      render(<StatusStrip state={{ ...RUNNING_STATE, proxyStale: true, compatible: false }} onRestart={() => {}} onResetTrip={() => {}} failed
        info={{ status: richCalls().status as never, pending: 3, model: { account: 'a', model: 'm', quota: { windows: [{ label: '5h', usedPercent: 1 }] } } }} />)
    },
  },
  {
    name: 'controls',
    mount: () => {
      const node: ReactNode = (
        <>
          <EnableCard expectedRssMb={110} dataDir="/d" autostart onToggleAutostart={() => {}} onEnable={() => {}} failed dataExists roots={roots} onWipe={async () => ({ ok: true })} />
          <AutoSwitch checked onChange={() => {}} />
          <AutoSwitch checked={false} disabled label={UNSANDBOXED_AUTO_LABEL} onChange={() => {}} />
          <DiffLines diff={{ path: 'a', status: 'M', binary: true, truncated: true, lines: [{ kind: 'add', ln: 1, text: 'x' }, { kind: 'del', ln: 1, text: 'y' }, { kind: 'ctx', ln: 2, text: 'z' }] }} />
          <Countdown until={Date.now() + 60_000} />
          <PathField value="/a" kind="directory" onChange={() => {}} />
          <Chip tone="warn">x</Chip>
          <CodeChip code="cwd_too_broad" />
          <Confirm title="t" rows={[['会话', 'x']]} keep={['y']} confirmLabel="删" danger requireTyped="plugin.json" onCancel={() => {}} onConfirm={() => {}} />
        </>
      )
      render(node)
    },
  },
]

describe('no explanatory text at render time', () => {
  beforeEach(() => { resetSeq(); route.set({ page: 'chat' }) })

  it('the finder catches each banned class and tag', () => {
    const { container } = render(
      <div>
        {['x-hint', 'desc', 'mffai-help', 'note', 'tooltip', 'caption'].map((c) => <span key={c} className={c}>a</span>)}
        <p>p</p><small>s</small>
      </div>,
    )
    expect(findHints(container).map((h) => h.className || h.tag)).toEqual(['x-hint', 'desc', 'mffai-help', 'note', 'tooltip', 'caption', 'p', 'small'])
  })

  it('model text inside an assistant answer body is third-party content, not UI text: its <p> is not a finding', () => {
    const { container } = render(<div><div className="msg ai"><div className="msg-body ans"><p>model paragraph</p></div></div><span className="mffai-chip">x</span></div>)
    expect(findHints(container)).toEqual([])
    const { container: c2 } = render(<div className="msg-body"><p>user side</p></div>)
    expect(findHints(c2).map((h) => h.tag)).toEqual(['p'])
    // 不在助手消息里的 .msg-body.ans 不算
    const { container: c3 } = render(<div className="msg-body ans"><p>ours</p></div>)
    expect(findHints(c3).map((h) => h.tag)).toEqual(['p'])
  })

  for (const row of ROWS) {
    it(row.name, async () => {
      const f = installFakeForge({ calls: richCalls() })
      await row.mount(f)
      expect(findHints()).toEqual([])
    })
  }
})
