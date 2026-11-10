// 视觉核对用的静态页(08b R25)。只在 MFFAI_PREVIEW_OUT 设了时跑:
//   OUT=$(mktemp -d); MFFAI_PREVIEW_OUT=$OUT npx vitest run src/renderer/mffai/test/preview.test.tsx
// 每个任务把自己的屏加进来。
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writePreview } from './preview'
import { PREVIEW_SIZE, UI_DIFF, UI_ROWS, UI_TABLE } from './previewFixtures'
import { Chip, type ChipTone } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { AutoSwitch, UNSANDBOXED_AUTO_LABEL } from '../ui/AutoSwitch'
import { Countdown } from '../ui/Countdown'
import { DiffLines } from '../ui/DiffLines'
import { PathField } from '../ui/PathField'
import { Confirm } from '../ui/Confirm'
import MffaiView from '../MffaiView'
import { route } from '../route'
import { installFakeForge } from './fakeForge'
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

  it('01-tasks: rail and page header (the tasks body comes later)', async () => {
    route.set({ page: 'tasks' })
    installFakeForge({
      state: { proxyStale: true, rssMb: 112, pluginsActive: 4, supervisor: { state: 'running', version: 'v0.8.2', restarts: 0, protocolVersion: 3 } },
      calls: {
        status: { state: 'running', uptimeMs: 1, rssMb: 112, version: '0.8.2', plugins: [{ id: 'a', state: 'active' }, { id: 'b', state: 'failed' }], sandbox: { level: 'full', missing: [], autoDegraded: false } },
        'session.list': { sessions: [{ id: 's1', title: 'one', origin: 'app', audience: 'owner', approvalMode: 'ask', createdAt: 1, updatedAt: 1, pendingApprovals: 2 }] },
        'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 3, problems: [] },
        'models.catalog': { presets: [], models: { p: [{ id: 'm1', name: 'Claude Sonnet 4.5', context: 1, output: 1, image: false, reasoning: 'none', toolCall: true }] }, default: { accountId: 'a1', modelId: 'm1' } },
        'models.accounts': { accounts: [{ id: 'a1', presetId: 'p', label: 'Claude', state: 'ok' }], secretsBackend: 'keychain' },
        'models.quota': { windows: [{ label: '5h', usedPercent: 42 }] },
        'events.tail': { events: [] },
      },
    })
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-tasks')
    await waitFor(() => expect(document.querySelectorAll('.mffai-navnum')).toHaveLength(3))
    await screen.findByText('Claude · Claude Sonnet 4.5')
    writePreview('01-tasks', PREVIEW_SIZE)
    expect(existsSync(join(OUT!, '01-tasks.html'))).toBe(true)
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
})
