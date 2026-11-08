import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import MffaiView, { MFFAI_EXPECTED_RSS_MB } from './MffaiView'
import { DEFAULT_PAGE, route } from './route'
import { fail, installFakeForge, type FakeForge } from './test/fakeForge'
import { ev } from './test/events'

let mffai: any
let eventCb: (e: any) => void

function setup(state: any) {
  eventCb = () => {}
  mffai = {
    state: vi.fn(async () => state),
    enable: vi.fn(async () => ({ ...state, enabled: true })),
    restart: vi.fn(async () => state),
    resetTrip: vi.fn(async () => state),
    setAutostart: vi.fn(async () => state),
    tail: vi.fn(async () => ({ events: [] })),
    prompt: vi.fn(async () => ({ accepted: true, turnId: 't1' })),
    onEvent: (cb: any) => { eventCb = cb; return () => {} },
    onAlert: () => () => {},
    models: {
      catalog: vi.fn(async () => ({ presets: [], models: {} })),
      accounts: vi.fn(async () => ({ accounts: [], secretsBackend: 'keychain' })),
    },
  }
  ;(window as any).forge = { mffai, setSettings: vi.fn(async () => ({})) }
}

describe('MffaiView', () => {
  beforeEach(() => vi.useRealTimers())

  it('disabled -> EnableCard with memory and data dir', async () => {
    setup({ enabled: false, autostart: true, running: false, dataDir: '/x/mff-ai' })
    render(<MffaiView />)
    expect(await screen.findByText(`约 ${MFFAI_EXPECTED_RSS_MB} MB`)).toBeInTheDocument()
    expect(screen.getByText('/x/mff-ai')).toBeInTheDocument()
    fireEvent.click(screen.getByText('启用'))
    await waitFor(() => expect(mffai.enable).toHaveBeenCalled())
  })

  it('autostart toggle persists immediately, survives poll, saved before enable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const calls: string[] = []
    setup({ enabled: false, autostart: true, running: false, dataDir: '/d' })
    let saved = true
    mffai.state = vi.fn(async () => ({ enabled: false, autostart: saved, running: false, dataDir: '/d' }))
    ;(window as any).forge.setSettings = vi.fn(async (p: any) => { calls.push('set'); saved = p.mffai.autostart })
    mffai.enable = vi.fn(async () => { calls.push('enable'); return { enabled: true, autostart: saved, running: true } })
    render(<MffaiView />)
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement
    fireEvent.click(box)
    expect((window as any).forge.setSettings).toHaveBeenCalledWith({ mffai: { enabled: false, autostart: false } })
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    calls.length = 0
    fireEvent.click(screen.getByText('启用'))
    await waitFor(() => expect(calls).toEqual(['set', 'enable']))
    vi.useRealTimers()
  })

  it('failed action shows 失败', async () => {
    setup({ enabled: true, autostart: true, running: false, supervisor: { state: 'tripped', version: '0.1.0' } })
    mffai.resetTrip = vi.fn(async () => { throw new Error('x') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<MffaiView />)
    fireEvent.click(await screen.findByText('重新启动'))
    expect(await screen.findByText('失败')).toBeInTheDocument()
  })

  it('stopping -> 已停止, plugin count shown', async () => {
    setup({ enabled: true, autostart: true, running: true, pluginsActive: 3, supervisor: { state: 'stopping', version: '0.1.0' } })
    render(<MffaiView />)
    expect(await screen.findByText('已停止')).toBeInTheDocument()
    expect(screen.getByText('3 插件')).toBeInTheDocument()
  })

  it('running -> 运行中', async () => {
    setup({ enabled: true, autostart: true, running: true, rssMb: 99, supervisor: { state: 'running', version: '0.1.0' } })
    render(<MffaiView />)
    expect(await screen.findByText('运行中')).toBeInTheDocument()
    expect(screen.getByText('99 MB')).toBeInTheDocument()
  })

  it('tripped -> 重新启动 calls resetTrip', async () => {
    setup({ enabled: true, autostart: true, running: false, supervisor: { state: 'tripped', version: '0.1.0' } })
    render(<MffaiView />)
    expect(await screen.findByText('已熔断')).toBeInTheDocument()
    fireEvent.click(screen.getByText('重新启动'))
    expect(mffai.resetTrip).toHaveBeenCalled()
  })

  it('incompatible -> 重新启动 calls restart', async () => {
    setup({ enabled: true, autostart: true, running: true, compatible: false, supervisor: { state: 'running', version: '0.0.1' } })
    render(<MffaiView />)
    expect(await screen.findByText('版本不兼容')).toBeInTheDocument()
    fireEvent.click(screen.getByText('重新启动'))
    expect(mffai.restart).toHaveBeenCalled()
  })

  it('enabled but no supervisor (start failed / killed) -> 已停止 + 重新启动 calls restart', async () => {
    setup({ enabled: true, autostart: true, running: false, dataDir: '/d' })
    render(<MffaiView />)
    expect(await screen.findByText('已停止')).toBeInTheDocument()
    fireEvent.click(screen.getByText('重新启动'))
    expect(mffai.restart).toHaveBeenCalled()
    expect(mffai.resetTrip).not.toHaveBeenCalled()
  })

  it('running supervisor -> no 重新启动 button', async () => {
    setup({ enabled: true, autostart: true, running: true, supervisor: { state: 'running', version: '0.1.0' } })
    render(<MffaiView />)
    expect(await screen.findByText('运行中')).toBeInTheDocument()
    expect(screen.queryByText('重新启动')).toBeNull()
  })

  it('debug panel: 发送 calls prompt and assistant event renders', async () => {
    setup({ enabled: true, autostart: true, running: true, supervisor: { state: 'running', version: '0.1.0' } })
    const { container } = render(<MffaiView />)
    await screen.findByText('发送')
    fireEvent.change(container.querySelector('.mffai-send input')!, { target: { value: 'hi' } })
    fireEvent.click(screen.getByText('发送'))
    expect(mffai.prompt).toHaveBeenCalledWith('hi')
    act(() => eventCb({ seq: 5, ts: 1, type: 'message.assistant', payload: { turnId: 't1', text: 'echo: hi' } }))
    expect(await screen.findByText('echo: hi')).toBeInTheDocument()
  })
})

const summary = (id: string, pendingApprovals: number) => ({
  id, title: id, origin: 'app' as const, audience: 'owner' as const, approvalMode: 'ask' as const, createdAt: 1, updatedAt: 1, pendingApprovals,
})
const status = (plugins: { id: string; state: 'active' | 'failed' | 'disabled' }[] = []) => ({ state: 'running' as const, uptimeMs: 1, rssMb: 50, version: '0.1.0', plugins })

describe('MffaiView shell', () => {
  let f: FakeForge
  beforeEach(() => {
    route.set({ page: 'chat' })
    f = installFakeForge({
      calls: {
        status: status(),
        'session.list': { sessions: [] },
        'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
        'models.catalog': { presets: [], models: {} },
        'models.accounts': { accounts: [], secretsBackend: 'keychain' },
        'events.tail': { events: [] },
      },
    })
  })

  const nav = () => [...document.querySelectorAll('.mffai-nav button')]
  const navItem = (label: string) => nav().find((b) => b.querySelector('.mffai-navlabel')?.textContent === label)!
  const count = (label: string) => navItem(label).querySelector('.mffai-navnum')?.textContent ?? null

  it('running: the strip plus a seven-item nav; nav switches pages', async () => {
    render(<MffaiView />)
    await waitFor(() => expect(nav()).toHaveLength(7))
    expect(nav().map((b) => b.querySelector('.mffai-navlabel')!.textContent)).toEqual(['对话', '任务', '记忆', '插件', '连接', '权限', '调试'])
    expect(navItem('对话').className).toContain('on')
    expect(await screen.findByTestId('mffai-page-chat')).toBeInTheDocument()
    fireEvent.click(navItem('调试'))
    expect(await screen.findByTestId('mffai-page-debug')).toBeInTheDocument()
    expect(navItem('调试').className).toContain('on')
    expect(route.get().page).toBe('debug')
    fireEvent.click(navItem('任务'))
    expect(await screen.findByTestId('mffai-page-tasks')).toBeInTheDocument()
    expect(screen.queryByTestId('mffai-page-debug')).toBeNull()
  })

  it('unmount puts the route back on the default page; a route set before mount is kept', async () => {
    route.set({ page: 'memory' })
    const r = render(<MffaiView />)
    expect(await screen.findByTestId('mffai-page-memory')).toBeInTheDocument()
    r.unmount()
    expect(route.get()).toEqual({ page: DEFAULT_PAGE })
  })

  it('route.set from a page moves the nav', async () => {
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-chat')
    act(() => route.set({ page: 'memory' }))
    expect(await screen.findByTestId('mffai-page-memory')).toBeInTheDocument()
    expect(navItem('记忆').className).toContain('on')
  })

  it('not running: strip only, no nav', async () => {
    f.setState({ running: false, supervisor: undefined })
    render(<MffaiView />)
    expect(await screen.findByText('重新启动')).toBeInTheDocument()
    expect(document.querySelector('.mffai-nav')).toBeNull()
  })

  it('counts: pending approvals, pending proposals, plugins not active; none when zero', async () => {
    f.script({
      'session.list': { sessions: [summary('a', 2), summary('b', 1), summary('c', 0)] },
      'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 4, problems: [] },
      status: status([{ id: 'p1', state: 'active' }, { id: 'p2', state: 'failed' }, { id: 'p3', state: 'disabled' }]),
    })
    render(<MffaiView />)
    await waitFor(() => expect(count('对话')).toBe('3'))
    expect(count('记忆')).toBe('4')
    expect(count('插件')).toBe('2')
    expect(count('任务')).toBeNull()
    expect(screen.getByText('待处理 3')).toBeInTheDocument()
    // 审批答完:重取之后数字消失
    f.script({ 'session.list': { sessions: [summary('a', 0)] } })
    act(() => f.emit(ev('approval.resolved', { approvalId: 'x', decision: 'allow', by: 'user' }, { sessionId: 'a' })))
    await waitFor(() => expect(count('对话')).toBeNull())
    expect(screen.queryByText(/待处理/)).toBeNull()
  })

  it('memory.health unsupported (-32601): no memory count, nothing breaks', async () => {
    f.script({ 'session.list': { sessions: [summary('a', 1)] }, 'memory.health': () => fail(-32601, 'method not found') })
    render(<MffaiView />)
    await waitFor(() => expect(count('对话')).toBe('1'))
    expect(count('记忆')).toBeNull()
  })

  it('a reset alert refetches the counts', async () => {
    render(<MffaiView />)
    await waitFor(() => expect(f.callsOf('session.list').length).toBeGreaterThan(0))
    const before = f.callsOf('session.list').length
    f.script({ 'session.list': { sessions: [summary('a', 5)] } })
    act(() => f.alert({ kind: 'reset' }))
    await waitFor(() => expect(count('对话')).toBe('5'))
    expect(f.callsOf('session.list').length).toBeGreaterThan(before)
  })

  it('default model and its quota in the strip', async () => {
    f.script({
      'models.catalog': { presets: [], models: { p: [{ id: 'm1', name: 'GPT-5', context: 1, output: 1, image: false, reasoning: 'none', toolCall: true }] }, default: { accountId: 'a1', modelId: 'm1' } },
      'models.accounts': { accounts: [{ id: 'a1', presetId: 'p', label: '主账号', state: 'ok' }], secretsBackend: 'keychain' },
      'models.quota': ({ accountId }) => (accountId === 'a1' ? { windows: [{ label: '5h', usedPercent: 40 }] } : null),
    })
    render(<MffaiView />)
    expect(await screen.findByText('主账号 · GPT-5')).toBeInTheDocument()
    expect(await screen.findByText('5h 40%')).toBeInTheDocument()
  })

  it('proxyStale 重启 calls the host restart (respawns the daemon), never a worker call', async () => {
    f.setState({ proxyStale: true })
    render(<MffaiView />)
    fireEvent.click(await screen.findByText('重启'))
    expect(f.mffai.restart).toHaveBeenCalledTimes(1)
    expect(f.mffai.resetTrip).not.toHaveBeenCalled()
    expect(f.calls.map((c) => c.method)).not.toContain('restart')
  })

  it('one onEvent registration for the whole view', async () => {
    render(<MffaiView />)
    fireEvent.click(await screen.findByText('调试'))
    await screen.findByTestId('mffai-page-debug')
    // 视图和调试页共用一个;调试面板和它的模型下拉(useModels)保留旧的直接订阅
    expect(f.listeners()).toBe(3)
  })

  it('disabled with data: 删除全部数据 calls mffai.wipe and re-reads state', async () => {
    const roots = { data: '/d/mff-ai', worktrees: '/d/mff-ai-worktrees', imWorktrees: '/d/mff-ai-im', plugins: '/d/mff-ai-plugins', keychain: 'myflowforge-mffai/x' }
    f.setState({ enabled: false, running: false, supervisor: undefined, dataExists: true, roots })
    f.mffai.wipe.mockImplementation(async () => { f.setState({ dataExists: false }); return { ok: true, removed: [roots.data] } })
    render(<MffaiView />)
    fireEvent.click(await screen.findByText('删除全部数据'))
    fireEvent.click(screen.getAllByText('删除全部数据').at(-1)!)
    await waitFor(() => expect(f.mffai.wipe).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('删除全部数据')).toBeNull())
    expect(f.mffai.call).not.toHaveBeenCalled()
  })
})
