// 每个页面用夹具数据渲染,不能有 class 含 hint/desc/help/note/tip/caption 的元素,也不能有 <p>、<small>。
// ★页面任务(6–13)往 ROWS 里追加自己的行。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { perms, runRow, summary } from './test/sessions'
import { fail, installFakeForge, RUNNING_STATE, type CallTable, type FakeForge } from './test/fakeForge'
import { ev, resetSeq, userMsg } from './test/events'
import { findHints } from './test/noHint'

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

  for (const row of ROWS) {
    it(row.name, async () => {
      const f = installFakeForge({ calls: richCalls() })
      await row.mount(f)
      expect(findHints()).toEqual([])
    })
  }
})
