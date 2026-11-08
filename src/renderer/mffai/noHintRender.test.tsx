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
import { installFakeForge, RUNNING_STATE, type CallTable, type FakeForge } from './test/fakeForge'
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
