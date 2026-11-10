// 视觉核对用的静态页(08b R25)。只在 MFFAI_PREVIEW_OUT 设了时跑:
//   OUT=$(mktemp -d); MFFAI_PREVIEW_OUT=$OUT npx vitest run src/renderer/mffai/test/preview.test.tsx
// 每个任务把自己的屏加进来。
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writePreview } from './preview'
import { CHAT_TG, PREVIEW_CHAT_NARROW, PREVIEW_NARROW, PREVIEW_SIZE, UI_DIFF, UI_ROWS, UI_TABLE, chatActiveEvents, chatSessions, chatTgEvents } from './previewFixtures'
import { memStorage } from './panel'
import { ACTIVITY_KEY } from '../layout'
import { vi } from 'vitest'
import { installResize } from './resize'
import { ev } from './events'
import { act } from '@testing-library/react'
import { Chip, type ChipTone } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { AutoSwitch, UNSANDBOXED_AUTO_LABEL } from '../ui/AutoSwitch'
import { Countdown } from '../ui/Countdown'
import { DiffLines } from '../ui/DiffLines'
import { PathField } from '../ui/PathField'
import { Confirm } from '../ui/Confirm'
import MffaiView from '../MffaiView'
import { ApprovalCard } from '../chat/ApprovalCard'
import { route } from '../route'
import { installFakeForge } from './fakeForge'
import { runRow } from './sessions'
import type { RunRow } from '@mffai/protocol'
import { fireEvent, waitFor, screen } from '@testing-library/react'

const OUT = process.env.MFFAI_PREVIEW_OUT
const TONES: ChipTone[] = ['ok', 'bad', 'warn', 'muted', 'run', 'acc', 'line']

function Controls() {
  return (
    <div className="mffai-page">
      <div className="mffai-tabs" role="tablist">
        <button className="set-btn active" role="tab">模型</button><button className="set-btn" role="tab">执行器</button><button className="set-btn" role="tab">Telegram</button>
      </div>
      <div className="mffai-row">
        <button className="set-btn mffai-primary">添加</button><button className="set-btn">测试</button><button className="set-btn mffai-danger">删除</button>
        <button className="set-btn" disabled>停用</button><button className="txt-btn">改动 3</button>
        <div className="mffai-seg"><button className="on">全部</button><button>本机</button><button>Telegram</button><button>定时</button></div>
        <span className="mffai-spin" />
      </div>
      {TONES.map((t) => (
        <div key={t} className="mffai-row"><Chip tone={t}>{t}</Chip><Chip tone={t} dot>{t}</Chip><Chip tone={t} sq>{t}</Chip><CodeChip code="crash-loop" /></div>
      ))}
      <div className="mffai-row">
        <input aria-label="地址" defaultValue="api.example.com" /><select aria-label="模型" defaultValue="a"><option value="a">GPT-5</option></select>
        <PathField value="~/work/forge-api" kind="directory" onChange={() => {}} />
      </div>
      <div className="mffai-card">
        <AutoSwitch checked onChange={() => {}} />
        <AutoSwitch checked={false} label={UNSANDBOXED_AUTO_LABEL} onChange={() => {}} />
        <label className="mffai-switch"><input type="checkbox" role="switch" defaultChecked />开机自启</label>
        <label className="mffai-switch"><input type="checkbox" role="switch" />主动推荐</label>
      </div>
      <div className="mffai-row"><Countdown from={Date.now() - 100_000} until={Date.now() + 200_000} /></div>
      <table className="mffai-tbl">
        <thead><tr><th>任务</th><th>执行器</th><th>状态</th><th>耗时</th></tr></thead>
        <tbody>{UI_TABLE.map((r) => <tr key={r.task}><td>{r.task}</td><td>{r.who}</td><td><Chip tone="run" dot>{r.state}</Chip></td><td>{r.time}</td></tr>)}</tbody>
      </table>
      <DiffLines diff={UI_DIFF} />
    </div>
  )
}

describe.skipIf(!OUT)('preview screens', () => {
  it('ui: shared controls', () => {
    render(<Controls />)
    writePreview('ui', PREVIEW_SIZE)
    const html = readFileSync(join(OUT!, 'ui.html'), 'utf8')
    expect(html).toContain('data-theme="dark"')
    expect(html).toContain('--mffai-knob')
    expect(html).toContain('.code-line')
  })

  it('ui-confirm: a confirm over the controls, light theme', () => {
    render(<><Controls /><Confirm title="合并" rows={UI_ROWS} keep={['分支 mffai/r_7f3a']} confirmLabel="合并" onCancel={() => {}} onConfirm={() => {}} /></>)
    writePreview('ui-confirm', { ...PREVIEW_SIZE, theme: 'light' })
    expect(existsSync(join(OUT!, 'ui-confirm.html'))).toBe(true)
  })

  it('01-tasks: rail, page header with the run counts, and the three cards', async () => {
    route.set({ page: 'tasks' })
    const now = Date.now()
    const run = (runId: string, executor: string, sessionId: string, patch: Partial<RunRow>) => runRow(runId, sessionId, { executor, ...patch })
    installFakeForge({
      state: { proxyStale: true, rssMb: 112, pluginsActive: 4, supervisor: { state: 'running', version: 'v0.8.2', restarts: 0, protocolVersion: 3 } },
      calls: {
        status: { state: 'running', uptimeMs: 1, rssMb: 112, version: '0.8.2', plugins: [{ id: 'a', state: 'active' }, { id: 'b', state: 'failed' }], sandbox: { level: 'full', missing: [], autoDegraded: false } },
        'session.list': { sessions: [
          { id: 's1', title: '登录模块错误处理重构', origin: 'app', audience: 'owner', approvalMode: 'ask', createdAt: 1, updatedAt: 1, pendingApprovals: 2 },
          { id: 's2', title: '看下今天的线上告警', origin: 'app', audience: 'owner', approvalMode: 'ask', createdAt: 1, updatedAt: 1, pendingApprovals: 0 },
          { id: 's3', title: 'forge-api 补单测', origin: 'app', audience: 'owner', approvalMode: 'ask', createdAt: 1, updatedAt: 1, pendingApprovals: 0, cwd: '~/work/forge-api' },
          { id: 's4', title: 'README 翻译成英文', origin: 'app', audience: 'owner', approvalMode: 'ask', createdAt: 1, updatedAt: 1, pendingApprovals: 0, cwd: '~/work/forge-api' },
          { id: 's5', title: '设计周报模板', origin: 'app', audience: 'owner', approvalMode: 'ask', createdAt: 1, updatedAt: 1, pendingApprovals: 0 },
        ] },
        'executor.runs': { runs: [
          run('r1', 'codex', 's1', { phase: 'running', ms: 102000, worktree: { path: '~/.mff-ai/wt/r1', present: true, bytes: 312 * 1024 * 1024 } }),
          run('r2', 'claude-code', 's2', { phase: 'running', ms: 38000, worktree: { path: '~/.mff-ai/wt/r2', present: true, bytes: 96 * 1024 * 1024 } }),
          run('r3', 'codex', 's1', { phase: 'queued' }),
          run('r4', 'codex', 's3', { status: 'ok', ms: 247000, changed: 7, worktree: { path: '~/.mff-ai/wt/r4', present: true, bytes: 288 * 1024 * 1024 } }),
          run('r5', 'gemini', 's4', { status: 'ok', ms: 75000, changed: 2, worktree: { path: '~/.mff-ai/wt/r5', present: true, bytes: 41 * 1024 * 1024, merged: true } }),
          run('r6', 'claude-code', 's5', { status: 'failed', reason: 'timeout', ms: 52000, changed: 0, worktree: { path: '~/.mff-ai/wt/r6', present: true, bytes: 12 * 1024 * 1024 } }),
        ] },
        'channel.telegram.chats': { chats: [], worktrees: [{ id: 'w1', project: 'ops-gateway', path: '~/.mff-ai/im-wt/ops-gateway-3f2a', sessionIds: [], createdAt: now - 3600_000, bytes: 96 * 1024 * 1024, usedByChat: '张伟' }] },
        'channel.telegram.config.get': { enabled: true, staleMinutes: 10, projects: [{ name: 'ops-gateway', path: '~/work/ops-gateway', auto: false }] },
        'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 3, problems: [] },
        'models.catalog': { presets: [], models: { p: [{ id: 'm1', name: 'Claude Sonnet 4.5', context: 1, output: 1, image: false, reasoning: 'none', toolCall: true }] }, default: { accountId: 'a1', modelId: 'm1' } },
        'models.accounts': { accounts: [{ id: 'a1', presetId: 'p', label: 'Claude', state: 'ok' }], secretsBackend: 'keychain' },
        'models.quota': { windows: [{ label: '5h', usedPercent: 42 }] },
        'events.tail': { events: [] },
      },
    })
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-tasks')
    await waitFor(() => expect(document.querySelectorAll('.mffai-navnum').length).toBeGreaterThan(0))
    await screen.findByText('Claude · Claude Sonnet 4.5')
    await screen.findByText('ops-gateway')
    await waitFor(() => expect(document.querySelector('.mffai-head-slot')).toHaveTextContent('2 运行中'))
    expect(document.querySelectorAll('[data-tcard]')).toHaveLength(3)
    writePreview('01-tasks', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '01-tasks.html'))).toBe(true)
  })

  const connCalls = (accounts: unknown[], extra: Record<string, unknown> = {}) => ({
    status: { state: 'running', uptimeMs: 1, rssMb: 112, version: '0.8.2', plugins: [{ id: 'a', state: 'active' }, { id: 'b', state: 'failed' }], sandbox: { level: 'full', missing: [], autoDegraded: false } },
    'session.list': { sessions: [] },
    'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
    'events.tail': { events: [] },
    ...extra,
  }) as never
  const mdl = (id: string, name: string) => ({ id, name, context: 1, output: 1, image: false, reasoning: 'none', toolCall: true })
  const presetOf = (id: string, label: string, restriction = 'none', auth = 'api-key') => ({ id, label, billing: 'metered', restriction, auth, protocols: [], docsUrl: '' })

  it('04-conn-1-models: account cards with quota bars and the add-account drawer open', async () => {
    route.set({ page: 'conn' })
    const f = installFakeForge({ state: { proxyStale: true, rssMb: 112, pluginsActive: 4, supervisor: { state: 'running', version: '0.8.2', restarts: 0, protocolVersion: 3 } }, calls: connCalls([]) })
    f.mffai.models.catalog = async () => ({
      presets: [presetOf('anthropic', 'Anthropic'), presetOf('openai', 'OpenAI'), presetOf('deepseek', 'DeepSeek'), presetOf('openrouter', 'OpenRouter'), presetOf('chatgpt', 'ChatGPT 订阅', 'none', 'chatgpt-oauth'), presetOf('custom-openai', '自定义')],
      models: { anthropic: [mdl('claude-sonnet-4-5', 'claude-sonnet-4-5'), mdl('claude-opus-4', 'claude-opus-4')], chatgpt: [mdl('gpt-5-codex', 'gpt-5-codex')], deepseek: [mdl('deepseek-chat', 'deepseek-chat')], openrouter: [mdl('qwen/qwen3-coder', 'qwen/qwen3-coder')] },
      default: { accountId: 'a1', modelId: 'claude-sonnet-4-5' },
    }) as never
    f.mffai.models.accounts = async () => ({ accounts: [
      { id: 'a1', presetId: 'anthropic', label: 'Anthropic 个人', state: 'ok' },
      { id: 'a2', presetId: 'deepseek', label: 'DeepSeek', state: 'ok' },
      { id: 'a3', presetId: 'chatgpt', label: 'ChatGPT Plus', state: 'needs_login', restriction: 'coding-tools-only' },
      { id: 'a4', presetId: 'openrouter', label: 'OpenRouter 团队', state: 'quota_exhausted' },
    ], secretsBackend: 'keychain' }) as never
    f.mffai.models.quota = async (id: string) => ((({ a1: { windows: [{ label: '5h', usedPercent: 42 }, { label: '周', usedPercent: 18 }] }, a2: { windows: [{ label: '余额', usedPercent: 34 }] }, a3: { windows: [{ label: '5h', usedPercent: 0 }, { label: '周', usedPercent: 64 }] }, a4: { windows: [{ label: '月', usedPercent: 100 }] } }) as Record<string, unknown>)[id]) as never
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-conn')
    await screen.findByText('Anthropic 个人')
    await screen.findByText('5h 42%')
    fireEvent.click(screen.getByRole('button', { name: '添加账号' }))
    fireEvent.change(screen.getAllByRole('combobox').at(-1)!, { target: { value: 'custom-openai' } })
    fireEvent.change(document.querySelector('input[type=password]')!, { target: { value: 'sk-••••••••••••••••••••3fa1' } })
    writePreview('04-conn-1-models', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '04-conn-1-models.html'))).toBe(true)
  })

  it('04-conn-3-executors: the executors table while refreshing', async () => {
    route.set({ page: 'conn' })
    const f = installFakeForge({ state: { proxyStale: true, rssMb: 112, pluginsActive: 4, supervisor: { state: 'running', version: '0.8.2', restarts: 0, protocolVersion: 3 } }, calls: connCalls([], {
      'executor.list': { executors: [
        { id: 'claude-code', installed: true, version: '2.1.3', auth: 'ok', isolation: 'own', missing: [] },
        { id: 'codex', installed: true, version: '0.48.0', auth: 'missing', isolation: 'wrapped', missing: ['codex_network'] },
        { id: 'gemini', installed: false, auth: 'unknown', isolation: 'none', missing: ['unsupported'] },
      ] },
      'executor.refresh': () => new Promise(() => {}),
    }) })
    f.mffai.models.accounts = async () => ({ accounts: [{ id: 'a1', presetId: 'p', label: 'Claude', state: 'ok' }], secretsBackend: 'keychain' }) as never
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-conn')
    fireEvent.click(screen.getByRole('tab', { name: '执行器' }))
    await screen.findByText('codex_network')
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await screen.findByText('刷新中')
    writePreview('04-conn-3-executors', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '04-conn-3-executors.html'))).toBe(true)
  })

  const calls01 = {
    status: { state: 'running', uptimeMs: 1, rssMb: 112, version: '0.8.2', plugins: [{ id: 'a', state: 'active' }, { id: 'b', state: 'failed' }, { id: 'm', state: 'active', trust: 'dev' }, { id: 'd', state: 'active' }], secretsBackend: 'plaintext-file', sandbox: { level: 'full', missing: [], autoDegraded: false } },
    'session.list': { sessions: [] },
    'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
  } as never

  it('01-tasks-power: the power popover open over the tasks page', async () => {
    route.set({ page: 'tasks' })
    installFakeForge({ state: { proxyStale: true, rssMb: 112, autostart: true, pluginsActive: 4, supervisor: { state: 'running', version: '0.8.2', restarts: 0, protocolVersion: 3 } }, calls: calls01 })
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-tasks')
    await screen.findByText('完整')
    fireEvent.click(document.querySelector('button.mffai-power')!)
    await screen.findByText('1 有问题')
    writePreview('01-tasks-power', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '01-tasks-power.html'))).toBe(true)
  })

  it('cards-long-tool: a 120-char tool name, unsandboxed, n / m, in a 368 px panel', () => {
    installFakeForge()
    render(
      <div className="mffai-page"><aside className="mffai-act" style={{ width: 368 }}><div className="mffai-act-body">
        <ApprovalCard sessionId="s1" pos={{ n: 2, m: 3 }} approval={{ approvalId: 'p', turnId: 't1', callId: 'c', tool: 'mcp__' + 'y'.repeat(115), summary: 'rm -rf build', seq: 1, key: 'k', unsandboxed: true }} />
        <ApprovalCard sessionId="s1" approval={{ approvalId: 'q', turnId: 't1', callId: 'c', tool: 'http_get', summary: 'grafana.internal/api/ds/query', seq: 2 }} />
      </div></aside></div>,
    )
    writePreview('cards-long-tool', { width: 400, height: 420 })
    expect(existsSync(join(OUT!, 'cards-long-tool.html'))).toBe(true)
  })

  it('02-first-1-off: the enable hero', async () => {
    route.set({ page: 'chat' })
    installFakeForge({ state: { enabled: false, running: false, supervisor: undefined, autostart: false, dataDir: '~/Library/Application Support/myFlowForge/mff-ai' } })
    render(<MffaiView />)
    await screen.findByText('启用')
    writePreview('02-first-1-off', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '02-first-1-off.html'))).toBe(true)
  })

  it('02-first-4-fault: the fault panel', async () => {
    route.set({ page: 'chat' })
    installFakeForge({ state: { running: false, supervisor: { state: 'tripped', version: '0.8.2', restarts: 3, protocolVersion: 3, trippedReason: 'crash-loop' } } })
    render(<MffaiView />)
    await screen.findByText('后台已熔断')
    writePreview('02-first-4-fault', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '02-first-4-fault.html'))).toBe(true)
  })

  const chatCalls = () => ({
    status: { state: 'running', uptimeMs: 1, rssMb: 112, version: '0.8.2', plugins: [{ id: 'a', state: 'active' }, { id: 'b', state: 'active' }, { id: 'c', state: 'active' }, { id: 'd', state: 'active' }], sandbox: { level: 'full', missing: [], autoDegraded: false } },
    'session.list': { sessions: chatSessions(Date.now()) },
    'channel.telegram.chats': CHAT_TG.chats,
    'channel.telegram.status': CHAT_TG.status,
    'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
    'models.catalog': { presets: [{ id: 'p', name: 'Anthropic' }], models: { p: [{ id: 'm1', name: 'Claude Sonnet 4.5', context: 1, output: 1, image: false, reasoning: 'none', toolCall: true }] }, default: { accountId: 'a1', modelId: 'm1' } },
    'models.accounts': { accounts: [{ id: 'a1', presetId: 'p', label: 'Claude', state: 'ok' }], secretsBackend: 'keychain' },
    'models.quota': { windows: [{ label: '5h', usedPercent: 42 }] },
    'permissions.get': { config: { rules: [], network: { allow: [] }, sandbox: { enabled: true, allowLoopback: false }, allowUnsandboxedAuto: false }, defaults: [], errors: [], sandbox: { level: 'full', missing: [], autoDegraded: false } },
    'events.tail': { events: [] },
  }) as never

  for (const [name, size, main] of [['02-first-3-ready', PREVIEW_SIZE, 1376], ['03-chat-4-narrow-list', PREVIEW_NARROW, 1036]] as const) {
    it(`${name}: the session column beside the new-session form`, async () => {
      route.set({ page: 'chat', newSession: { cwd: '~/work/forge-api' } })
      const r = installResize()
      try {
        const f = installFakeForge({ state: { proxyStale: true, rssMb: 112, pluginsActive: 4, supervisor: { state: 'running', version: '0.8.2', restarts: 0, protocolVersion: 3 } }, calls: chatCalls() })
        const model = { id: 'm1', name: 'Claude Sonnet 4.5', context: 1, output: 1, image: false, reasoning: 'none' as const, toolCall: true }
        f.mffai.models.catalog = async () => ({ presets: [], models: { p: [model] }, default: { accountId: 'a1', modelId: 'm1' } }) as never
        f.mffai.models.accounts = async () => ({ accounts: [{ id: 'a1', presetId: 'p', label: 'Anthropic', state: 'ok' }], secretsBackend: 'keychain' }) as never
        render(<MffaiView />)
        await screen.findByTestId('mffai-page-chat')
        r.setMainWidth(main)
        await waitFor(() => expect(document.querySelectorAll('.mffai-sess')).toHaveLength(9))
        await screen.findByText('张伟')
        act(() => { f.emit(ev('memory.recommendation', { id: 'r1', category: 'routine', habitId: 'h1', text: '周一上午通常在 forge-api 看周报数据', cwd: '~/work/forge-api' })) })
        await screen.findByText('周一上午通常在 forge-api 看周报数据')
        await screen.findByRole('combobox', { name: '编辑工具' })
        writePreview(name, size)
        expect(existsSync(join(OUT!, `${name}.html`))).toBe(true)
      } finally { r.uninstall() }
    })
  }

  it('02-first-2-nomodel: no accounts, the start page with AddAccount open', async () => {
    route.set({ page: 'chat' })
    const r = installResize()
    try {
      const f = installFakeForge({ state: { rssMb: 98, pluginsActive: 4, supervisor: { state: 'running', version: '0.8.2', restarts: 0, protocolVersion: 3 } },
        calls: { ...(chatCalls() as object), 'session.list': { sessions: [] } } as never })
      const presets = [['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['deepseek', 'DeepSeek'], ['openrouter', 'OpenRouter']]
        .map(([id, label]) => ({ id, label, billing: 'metered', restriction: 'none', auth: 'api-key', protocols: [], docsUrl: '' }))
      f.mffai.models.catalog = async () => ({ presets, models: {} }) as never
      f.mffai.models.accounts = async () => ({ accounts: [], secretsBackend: 'keychain' }) as never
      render(<MffaiView />)
      await screen.findByTestId('mffai-page-chat')
      r.setMainWidth(1376)
      fireEvent.click(await screen.findByRole('button', { name: '添加账号' }))
      writePreview('02-first-2-nomodel', PREVIEW_SIZE)
      expect(existsSync(join(OUT!, '02-first-2-nomodel.html'))).toBe(true)
    } finally { r.uninstall() }
  })

  const COMMANDS = [
    { name: 'review', plugin: 'code-review', description: '审阅当前改动', argumentHint: '[路径]' },
    { name: 'commit', plugin: 'git-helper', description: '生成提交说明并提交' },
    { name: 'deploy-preview', plugin: 'vercel-tools', description: '部署预览环境', argumentHint: '<分支>' },
  ]

  const FRAMES = [
    ['03-chat-1-active', PREVIEW_SIZE, 1376, 's1', 'open'],
    ['03-chat-2-telegram', PREVIEW_SIZE, 1376, 's2', 'open'],
    ['03-chat-3-collapsed', PREVIEW_SIZE, 1376, 's1', 'closed'],
    ['03-chat-4-narrow', PREVIEW_CHAT_NARROW, 1036, 's1', 'open'],
  ] as const
  for (const [name, size, main, sid, pref] of FRAMES) {
    it(`${name}: the chat header, the conversation and the activity panel`, async () => {
      vi.stubGlobal('localStorage', memStorage())
      localStorage.setItem(ACTIVITY_KEY, pref)
      route.set({ page: 'chat', sessionId: sid })
      const r = installResize()
      try {
        const now = Date.now()
        const e = (type: string, payload: Record<string, unknown>) => ev(type as never, payload, { sessionId: sid, ts: now - 60_000 })
        const events = (sid === 's1' ? chatActiveEvents(e) : chatTgEvents(e)) as { seq: number }[]
        const sess = chatSessions(now).find((x) => x.id === sid)!
        const open = sid === 's1' ? { turnId: 't1', parked: false, approvalIds: ['a1', 'a2'] } : { turnId: 't2', parked: true, approvalIds: [] }
        const f = installFakeForge({
          state: { proxyStale: true, rssMb: 112, pluginsActive: 4, supervisor: { state: 'running', version: '0.8.2', restarts: 0, protocolVersion: 3 } },
          calls: {
            ...(chatCalls() as object),
            'session.state': { session: sess, events, hasMore: false, lastSeq: events.at(-1)!.seq, open },
            'plugins.commands': { commands: name === '03-chat-1-active' ? COMMANDS : [] },
            'executor.runs': { runs: [{ runId: 'r2', sessionId: 's2', turnId: 't1', executor: 'Claude Code', phase: 'ended', status: 'ok', queuedAt: 1, readOnly: false, isolation: 'own', worktree: { path: '~/.mff-ai/wt/r2', present: true }, changed: 2 }] },
          } as never,
        })
        const model = { id: 'm1', name: 'Claude Sonnet 4.5', context: 1, output: 1, image: false, reasoning: 'none' as const, toolCall: true }
        f.mffai.models.catalog = async () => ({ presets: [], models: { p: [model] }, default: { accountId: 'a1', modelId: 'm1' } }) as never
        render(<MffaiView />)
        await screen.findByTestId('mffai-page-chat')
        r.setMainWidth(main)
        await waitFor(() => expect(document.querySelectorAll('.mffai-sess')).toHaveLength(9))
        await waitFor(() => expect(document.querySelector('header.mffai-chathead')).not.toBeNull())
        await screen.findByText(sid === 's1' ? /throw new Error/ : '好,正在等合并结果')
        if (sid === 's2') fireEvent.click(await screen.findByRole('button', { name: '会话' }))
        await waitFor(() => expect(document.querySelector('[data-run]')).not.toBeNull())
        if (name === '03-chat-1-active') {
          fireEvent.change(screen.getByRole('textbox', { name: '输入' }), { target: { value: '/' } })
          await waitFor(() => expect(document.querySelectorAll('.mffai-slash [role=option]')).toHaveLength(3))
        }
        writePreview(name, size)
        expect(existsSync(join(OUT!, `${name}.html`))).toBe(true)
      } finally { r.uninstall(); vi.unstubAllGlobals() }
    })
  }
})
