// 视觉核对用的静态页(08b R25)。只在 MFFAI_PREVIEW_OUT 设了时跑:
//   OUT=$(mktemp -d); MFFAI_PREVIEW_OUT=$OUT npx vitest run src/renderer/mffai/test/preview.test.tsx
// 每个任务把自己的屏加进来。
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writePreview, type PreviewOpts } from './preview'
import { CHAT_TG, PREVIEW_CHAT_NARROW, PREVIEW_NARROW, PREVIEW_SIZE, UI_DIFF, UI_ROWS, UI_TABLE, chatActiveEvents, chatSessions, chatTgEvents } from './previewFixtures'
import { memStorage } from './panel'
import { ACTIVITY_KEY } from '../layout'
import { vi } from 'vitest'
import { installResize } from './resize'
import { ev, userMsg } from './events'
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
import { fail, installFakeForge } from './fakeForge'
import { runRow } from './sessions'
import type { RunRow } from '@mffai/protocol'
import { detailOf, FULL_CONSENT, listRow, pluginList } from './plugins'
import { fireEvent, waitFor, screen, within } from '@testing-library/react'

const OUT = process.env.MFFAI_PREVIEW_OUT
/** 这两屏另出强调色 / 皮肤 / 毛玻璃变体(08b Task 12) */
const VARIANT_SCREENS = new Set(['03-chat-1-active', '05-plugins-1-detail'])
/** 每屏写深色(原名)和浅色(-light);变体屏再写 -amber、-forge、-glass */
function shot(name: string, opts: PreviewOpts): void {
  writePreview(name, opts)
  writePreview(`${name}-light`, { ...opts, theme: 'light' })
  if (!VARIANT_SCREENS.has(name)) return
  writePreview(`${name}-amber`, { ...opts, accent: 'amber' })
  writePreview(`${name}-forge`, { ...opts, skin: 'forge' })
  writePreview(`${name}-glass`, { ...opts, glass: true })
}
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
    shot('ui', PREVIEW_SIZE)
    const html = readFileSync(join(OUT!, 'ui.html'), 'utf8')
    expect(html).toContain('data-theme="dark"')
    expect(html).toContain('--mffai-knob')
    expect(html).toContain('.code-line')
    expect(readFileSync(join(OUT!, 'ui-light.html'), 'utf8')).toContain('data-theme="light"')
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
    shot('01-tasks', PREVIEW_SIZE)
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
    shot('04-conn-1-models', PREVIEW_SIZE)
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
    shot('04-conn-3-executors', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '04-conn-3-executors.html'))).toBe(true)
  })

  it('04-conn-2-telegram: status card, paired card, live pairing panel, projects and chats', async () => {
    route.set({ page: 'conn' })
    const f = installFakeForge({ state: { proxyStale: true, rssMb: 112, pluginsActive: 4, supervisor: { state: 'running', version: '0.8.2', restarts: 0, protocolVersion: 3 } }, calls: connCalls([], {
      'channel.telegram.status': { state: 'online', enabled: true, tokenSet: true, bot: { id: 1, username: 'forge_helper_bot' }, secretsBackend: 'keychain', proxy: 'none', lastOkAt: Date.now() - 120_000, paired: [{ accountId: '1', name: '张伟', pairedAt: Date.now() - 8 * 86_400_000 }, { accountId: '2', name: '产品群', pairedAt: Date.now() - 15 * 86_400_000 }], pairing: { active: false }, dropped: { unpaired: 3, stale: 0, group: 1, attachment: 2, badUpdate: 0 }, undelivered: 0, problems: [] },
      'channel.telegram.config.get': { enabled: true, staleMinutes: 30, projects: [{ name: 'api', path: '~/work/forge-api', auto: true }, { name: 'ops', path: '~/work/ops-gateway', auto: false }] },
      'channel.telegram.chats': { chats: [
        { chatId: 'c1', accountId: '1', sessionId: '看下今天的线上告警', project: 'ops', model: { accountId: 'a1', modelId: 'claude-sonnet-4-5' }, queued: 1, running: true },
        { chatId: 'c2', accountId: '2', sessionId: '发布清单核对', project: 'api', model: { accountId: 'a1', modelId: 'claude-sonnet-4-5' }, queued: 0, running: false },
      ], worktrees: [] },
      'channel.telegram.pairing.begin': () => ({ code: 'K7Q4M2', expiresAt: Date.now() + 252_000, link: 'https://t.me/forge_helper_bot?start=K7Q4M2' }),
      'permissions.get': { config: { rules: [], network: { allow: [] }, sandbox: { enabled: true, allowLoopback: false }, allowUnsandboxedAuto: false }, defaults: [], errors: [], sandbox: { level: 'partial', missing: [], autoDegraded: false } },
    }) })
    f.mffai.models.accounts = async () => ({ accounts: [{ id: 'a1', presetId: 'p', label: 'Claude', state: 'ok' }], secretsBackend: 'keychain' }) as never
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-conn')
    fireEvent.click(screen.getByRole('tab', { name: 'Telegram' }))
    await screen.findAllByTestId('mffai-tg-chat')
    await waitFor(() => expect(document.querySelector('[data-project-row]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '开始配对' }))
    await screen.findByText('K7Q4M2')
    shot('04-conn-2-telegram', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '04-conn-2-telegram.html'))).toBe(true)
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
    shot('01-tasks-power', PREVIEW_SIZE)
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
    shot('cards-long-tool', { width: 400, height: 420 })
    expect(existsSync(join(OUT!, 'cards-long-tool.html'))).toBe(true)
  })

  it('02-first-1-off: the enable hero', async () => {
    route.set({ page: 'chat' })
    installFakeForge({ state: { enabled: false, running: false, supervisor: undefined, autostart: false, dataDir: '~/Library/Application Support/myFlowForge/mff-ai' } })
    render(<MffaiView />)
    await screen.findByText('启用')
    shot('02-first-1-off', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '02-first-1-off.html'))).toBe(true)
  })

  it('02-first-4-fault: the fault panel', async () => {
    route.set({ page: 'chat' })
    installFakeForge({ state: { running: false, supervisor: { state: 'tripped', version: '0.8.2', restarts: 3, protocolVersion: 3, trippedReason: 'crash-loop' } } })
    render(<MffaiView />)
    await screen.findByText('后台已熔断')
    shot('02-first-4-fault', PREVIEW_SIZE)
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
        shot(name, size)
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
      shot('02-first-2-nomodel', PREVIEW_SIZE)
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
        shot(name, size)
        expect(existsSync(join(OUT!, `${name}.html`))).toBe(true)
      } finally { r.uninstall(); vi.unstubAllGlobals() }
    })
  }
  // 05-plugins:左列 + 详情 / 添加 / 全部 MCP
  const plugCalls = (extra: Record<string, unknown> = {}) => ({
    status: { state: 'running', uptimeMs: 1, rssMb: 112, version: '0.8.2', plugins: [{ id: 'a', state: 'active' }, { id: 'b', state: 'active' }, { id: 'my-hooks', state: 'active', trust: 'dev' }, { id: 'd', state: 'failed' }], sandbox: { level: 'full', missing: [], autoDegraded: false } },
    'session.list': { sessions: [] },
    'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
    'models.catalog': { presets: [], models: { p: [{ id: 'm1', name: 'Claude Sonnet 4.5', context: 1, output: 1, image: false, reasoning: 'none', toolCall: true }] }, default: { accountId: 'a1', modelId: 'm1' } },
    'models.accounts': { accounts: [{ id: 'a1', presetId: 'p', label: 'Claude', state: 'ok' }], secretsBackend: 'keychain' },
    'models.quota': { windows: [{ label: '5h', usedPercent: 42 }] },
    'events.tail': { events: [] },
    'plugins.list': pluginList({
      plugins: [
        listRow('github-tools', { version: '1.4.0', format: 'claude', source: { kind: 'git', url: 'github.com/acme/github-tools', commit: '3f9c2a1' } }),
        listRow('code-review', { version: '0.9.2', source: { kind: 'path', path: '~/plugins/code-review' } }),
        listRow('vercel-tools', { version: '2.0.1', state: 'server_failed', problems: ['server_failed'], source: { kind: 'git', url: 'github.com/vt/mcp', commit: 'a1b2c3d' } }),
        listRow('notes', { version: '0.3.0', enabled: false, source: { kind: 'path', path: '~/plugins/notes' } }),
      ],
      dev: [{ id: 'my-hooks.ts', hash: 'sha256:9be1c04', trustedAt: Date.now() - 2 * 86_400_000 }],
      problems: ['store_recovered'],
    }),
    'plugins.mcp.status': { servers: [
      { plugin: 'github-tools', server: 'github', sessionId: 's1', state: 'running', pid: 48213 },
      { plugin: 'github-tools', server: 'github', sessionId: 's2', state: 'running', pid: 48877 },
      { plugin: 'vercel-tools', server: 'deploy', sessionId: 's1', state: 'stopped', reason: 'server_exited' },
      { plugin: 'vercel-tools', server: 'logs', sessionId: 's3', state: 'refused', reason: 'needs_config' },
      { plugin: 'code-review', server: 'lint', sessionId: 's5', state: 'stopped' },
    ] },
    ...extra,
  }) as never
  const plugState = { proxyStale: true, rssMb: 112, pluginsActive: 4, supervisor: { state: 'running', version: '0.8.2', restarts: 0, protocolVersion: 3 } } as never
  const GH = {
    ...FULL_CONSENT,
    id: 'github-tools', version: '1.4.0', format: 'claude' as const,
    mcp: [
      { ...FULL_CONSENT.mcp[1], name: 'github', declared: null, fetchesAtRuntime: true, suggestedHosts: ['api.github.com', 'uploads.github.com', 'objects.githubusercontent.com'], problems: [] },
      { ...FULL_CONSENT.mcp[1], name: 'gh-search', declared: null, suggestedHosts: ['api.github.com', 'codeload.github.com'], problems: [] },
    ],
    config: [
      { key: 'GITHUB_TOKEN', title: 'GitHub token', sensitive: true, required: true, type: 'string' },
      { key: 'org', title: '默认组织', sensitive: false, required: false, type: 'string' },
    ],
  }

  it('05-plugins-1-detail: list column and the github-tools detail', async () => {
    route.set({ page: 'plugins' })
    installFakeForge({ state: plugState, calls: plugCalls({
      'plugins.get': detailOf(GH, {
        grants: { servers: { github: { network: ['api.github.com'], cwd: 'read' }, 'gh-search': { network: [], cwd: 'none' } } },
        settings: [{ key: 'GITHUB_TOKEN', set: true, sensitive: true }, { key: 'org', set: true, sensitive: false, value: 'acme' }],
        servers: [{ name: 'github', state: 'running' }, { name: 'gh-search', state: 'stopped' }],
      }),
    }) })
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-plugins')
    await waitFor(() => expect(document.querySelector('[data-plugin="github-tools"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-plugin="github-tools"] .mffai-prow-open')!)
    await screen.findByRole('button', { name: '保存授权' })
    await waitFor(() => expect(document.querySelector('[data-dsec="servers"] [data-mcp-row]')).not.toBeNull())
    shot('05-plugins-1-detail', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '05-plugins-1-detail.html'))).toBe(true)
  })

  it('05-plugins-2-install: the add pane with a git source and a fetch in progress', async () => {
    route.set({ page: 'plugins' })
    installFakeForge({ state: plugState, calls: plugCalls({ 'plugins.install.prepare': { stagingId: 'st1' }, 'plugins.install.status': { state: 'failed', error: 'symlink', path: 'scripts/ssh-config' } }) })
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-plugins')
    fireEvent.click(await screen.findByRole('button', { name: '添加' }))
    fireEvent.click(screen.getByRole('tab', { name: 'git' }))
    fireEvent.change(screen.getByLabelText('地址'), { target: { value: 'https://github.com/acme/github-tools' } })
    fireEvent.change(screen.getByLabelText('ref'), { target: { value: 'v1.5.0' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取' })) })
    await screen.findByText('symlink')
    shot('05-plugins-2-install', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '05-plugins-2-install.html'))).toBe(true)
  })

  it('05-plugins-3-mcp: the all-MCP view', async () => {
    route.set({ page: 'plugins' })
    installFakeForge({ state: plugState, calls: plugCalls() })
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-plugins')
    await screen.findByText('1 已退出')
    shot('05-plugins-3-mcp', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '05-plugins-3-mcp.html'))).toBe(true)
  })

  // 06-consent:A 首装整页,B 升级弹窗
  const GH_NEW = {
    ...GH,
    claimed: { name: 'GitHub Tools', description: '在对话里查 PR、issue 和 release', author: 'Acme Labs', homepage: 'https://acme.dev/gh-tools' },
    source: { kind: 'git' as const, url: 'github.com/acme/github-tools', commit: '3f9c2a1' },
    integrity: 'sha256-Rk3…9fQ=', files: 42, bytes: 319_488,
    mcp: [{ ...GH.mcp[0], command: 'node', args: ['${PLUGIN_ROOT}/dist/server.js', '--token', 'MASKED', '--cache', '${PLUGIN_DATA}'], argsMasked: [2],
      env: [{ name: 'GITHUB_TOKEN', source: 'config' as const, required: true }, { name: 'GH_HOST', source: 'literal' as const, required: false, value: 'github.com' }] }, GH.mcp[1]],
    skills: [{ name: 'pr-summary', description: '总结一个 PR 的改动', modelInvocable: true, userInvocable: false, files: 2, flags: [], ignored: [] }],
    commands: [{ name: '/gh-issue', description: '新建 issue', flags: [], ignored: [] }, { name: '/gh-release', description: '起草 release note', flags: [], ignored: ['allowed-tools'] }],
    notRun: { hooks: [{ event: 'PreToolUse', command: 'bash ${PLUGIN_ROOT}/hooks/guard.sh --token', masked: true }], agents: ['reviewer.md', 'triager.md'], bin: ['gh-helper'], monitors: [], workflows: [], lsp: [], other: [], remoteMcp: [{ name: 'gh-cloud', type: 'http', url: 'https://mcp.acme.dev/sse' }], scripts: ['postinstall'] },
    warnings: ['credentials_in_source', 'truncated'], truncatedSections: [{ section: 'skills', omitted: 4 }],
  }
  const { diff: _gd, ...GH_A } = GH_NEW
  const GH_B = {
    ...GH_NEW, version: '1.5.0', source: { kind: 'git' as const, url: 'acme-labs/github-tools', commit: '9d01b7e' }, integrity: 'sha256-p0L…a1c=', files: 47, bytes: 346_112,
    warnings: ['credentials_in_source'], truncatedSections: [],
    diff: {
      fromVersion: '1.4.0', toVersion: '1.5.0', sourceChanged: true,
      mcp: { added: ['gh-actions'], removed: [], changed: [{ name: 'github', fields: ['args' as const] }] },
      skills: { added: [], removed: [], textChanged: [] }, commands: { added: [], removed: ['/gh-release'], textChanged: [] },
      network: { added: ['pipelines.actions.githubusercontent.com'], removed: [] }, config: { added: [], requiredSensitive: [] },
      notRun: { hooksAdded: [{ event: 'PostToolUse', command: 'node ${PLUGIN_ROOT}/hooks/audit.js', masked: false }], hooksRemoved: [], added: [] },
      files: { from: 42, to: 47 }, integrity: { from: 'sha256-Rk3…9fQ=', to: 'sha256-p0L…a1c=' },
    },
  }

  it('06-consent-A: the first-install review page over the plugins page', async () => {
    route.set({ page: 'plugins' })
    installFakeForge({ state: plugState, calls: plugCalls({ 'plugins.install.prepare': { stagingId: 'st1' }, 'plugins.install.status': { state: 'ready', consent: GH_A, consentHash: 'h' } }) })
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-plugins')
    fireEvent.click(await screen.findByRole('button', { name: '添加' }))
    fireEvent.change(screen.getByLabelText('路径'), { target: { value: '~/src/github-tools' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取' })) })
    await screen.findByRole('button', { name: '安装并启用' })
    shot('06-consent-A', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '06-consent-A.html'))).toBe(true)
  })

  it('06-consent-B: the upgrade change modal', async () => {
    route.set({ page: 'plugins' })
    installFakeForge({ state: plugState, calls: plugCalls({
      'plugins.get': detailOf(GH_A as never, { grants: { servers: { github: { network: [], cwd: 'read' }, 'gh-search': { network: [], cwd: 'none' } } }, servers: [{ name: 'github', state: 'running' }] }),
      'plugins.upgrade.prepare': { stagingId: 'up1' },
      'plugins.install.status': { state: 'ready', consent: GH_B, consentHash: 'h2' },
    }) })
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-plugins')
    await waitFor(() => expect(document.querySelector('[data-plugin="github-tools"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-plugin="github-tools"] .mffai-prow-open')!)
    const up = await screen.findByRole('button', { name: '升级' })
    await waitFor(() => expect((up as HTMLButtonElement).disabled).toBe(false))
    await act(async () => { fireEvent.click(up) })
    const dlg = await screen.findByRole('dialog')
    await within(dlg).findByRole('button', { name: '升级' })
    shot('06-consent-B', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '06-consent-B.html'))).toBe(true)
  })
  const pageCalls = (extra: Record<string, unknown> = {}) => ({ ...(plugCalls() as object), 'plugins.list': pluginList({ plugins: [], dev: [], problems: [] }), ...extra })

  it('07-memory: the 待确认 tab with replace, add and full proposals', async () => {
    route.set({ page: 'memory' })
    installFakeForge({ state: { ...(plugState as object), roots: { data: '~/.mff-ai', worktrees: '/w', imWorktrees: '/im', plugins: '/p', keychain: 'k' } } as never, calls: pageCalls({
      'memory.health': { dbBytes: 1, rawRows: 1, noteRows: 1, cursorLag: 0, pendingProposals: 3, problems: ['delete_stuck:n_z'] },
      'memory.file.get': { content: '', hash: 'h0', cap: 2000 },
      'memory.list': { items: [] },
      'memory.get': (p: { id: string }) => ({ id: p.id, layer: 'raw', text: p.id === 'n_old' ? 'forge-api 的测试命令是 pnpm jest' : '以后装依赖都用 pnpm 吧,提交信息写中文就行' }),
      'memory.proposals.list': { items: [
        { id: 'p1', target: 'USER.md', op: 'add', text: '偏好 pnpm,不用 npm;提交信息用中文', evidence: ['r_1'], source: 'extract', flags: [], status: 'pending', createdAt: 1 },
        { id: 'p2', target: 'MEMORY.md', op: 'replace', text: 'forge-api 的测试命令是 pnpm vitest run', replaces: 'n_old', evidence: ['r_2'], source: 'model', flags: [], status: 'pending', createdAt: 2 },
        { id: 'p3', target: 'topics/deploy.md', op: 'add', text: '预发环境部署前要先跑 db:migrate:check', evidence: ['r_3'], source: 'extract', flags: ['exec'], status: 'pending', createdAt: 3 },
      ] },
      'memory.proposals.decide': (p: { id: string }) => (p.id === 'p3' ? fail(-32602, 'full') : { ok: true }),
    }) })
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-memory')
    fireEvent.click(await screen.findByRole('tab', { name: '待确认' }))
    await screen.findAllByText('提取')
    await act(async () => { fireEvent.click(document.querySelectorAll('[data-proposal="p3"] .mffai-primary')[0]) })
    await screen.findByText('已满')
    shot('07-memory', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '07-memory.html'))).toBe(true)
  })

  it('08-permissions: sandbox, switches, network, the rules table with an error row, defaults and the save bar', async () => {
    route.set({ page: 'perm' })
    installFakeForge({ state: plugState, calls: pageCalls({
      'permissions.get': {
        config: {
          rules: [
            { effect: 'deny', rule: 'shell: rm -rf *', match: ['rm -rf /', 'rm -rf ~'], noMatch: ['rm -rf ./dist'] },
            { effect: 'ask', rule: 'shell: git push*', match: ['git push origin main'], noMatch: ['git pull'] },
            { effect: 'allow', rule: 'shell: pnpm vitest*', match: ['pnpm vitest run'], noMatch: ['pnpm publish'] },
            { effect: 'allow', rule: 'read_file: src/**', match: ['src/a.ts'], noMatch: ['.env'] },
          ],
          network: { allow: ['registry.npmjs.org', 'api.github.com', '*.pypi.org'] }, sandbox: { enabled: true, allowLoopback: false }, allowUnsandboxedAuto: false,
        },
        defaults: ['deny read_file: ~/.ssh/**', 'deny read_file: **/.env*', 'ask shell: sudo *', 'ask write_file: /etc/**'], errors: [],
        sandbox: { level: 'partial', missing: ['netns'], autoDegraded: false },
      },
      'permissions.set': () => fail(-32602, 'invalid', [{ index: 2, rule: 'shell: pnpm vitest*', reason: 'test_failed', case: 'pnpm publish' }]),
    }) })
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-perm')
    await screen.findByText('registry.npmjs.org')
    fireEvent.click(screen.getByRole('switch', { name: '允许本机回环' }))
    fireEvent.click(screen.getByRole('switch', { name: '允许本机回环' }))
    fireEvent.change(screen.getAllByLabelText('规则')[0], { target: { value: 'shell: rm -rf *' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    await screen.findByText('test_failed')
    shot('08-permissions', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '08-permissions.html'))).toBe(true)
  })

  it('10-debug: the raw tab with filters and a picked event', async () => {
    route.set({ page: 'debug' })
    const events = [ev('memory.injected', { turnId: 't_9f2', kind: 'turn', text: 'items 2', items: [] }, { sessionId: 's_31ac' }), userMsg('s_31ac', 't_9f2', 'hello'), ev('plugins.injected', { turnId: 't_9f2', text: 'skill', skill: true, mcp: false }, { sessionId: 's_31ac' })]
    installFakeForge({ state: plugState, calls: pageCalls({ 'events.tail': { events } }) })
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-debug')
    fireEvent.click(await screen.findByRole('tab', { name: '原始' }))
    const list = await screen.findByRole('listbox', { name: '事件' })
    await waitFor(() => expect(within(list).queryAllByRole('option').length).toBeGreaterThan(0))
    fireEvent.click(within(list).getAllByRole('option')[0])
    shot('10-debug', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '10-debug.html'))).toBe(true)
  })
})
