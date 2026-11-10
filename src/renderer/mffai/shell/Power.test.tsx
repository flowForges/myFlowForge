import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { MffaiState, StatusResult } from '@mffai/protocol'
import { PowerButton, powerTone } from './Power'
import MffaiView from '../MffaiView'
import { route } from '../route'
import { installFakeForge, RUNNING_STATE } from '../test/fakeForge'

const sup = (state: 'starting' | 'running' | 'restarting' | 'tripped' | 'stopping', extra: object = {}) => ({ ...RUNNING_STATE.supervisor!, state, ...extra })
const st = (p: Partial<MffaiState> = {}): MffaiState => ({ ...RUNNING_STATE, ...p })
const status = (p: Partial<StatusResult> = {}): StatusResult => ({ state: 'running', uptimeMs: 1, rssMb: 50, version: '0.1.0', plugins: [], ...p })
const noop = () => {}
const handlers = () => ({ onEnable: vi.fn(), onDisable: vi.fn(), onAutostart: vi.fn(), onRestart: vi.fn(), onResetTrip: vi.fn() })
const btn = () => document.querySelector('button.mffai-power') as HTMLButtonElement
const pop = () => document.querySelector('.mffai-powerpop')

describe('powerTone', () => {
  it('running -> run; disabled -> off; tripped or incompatible -> bad; starting, restarting or op -> wait', () => {
    expect(powerTone(st())).toBe('run')
    expect(powerTone(st({ enabled: false, running: false, supervisor: undefined }))).toBe('off')
    expect(powerTone(st({ running: false, supervisor: sup('tripped') }))).toBe('bad')
    expect(powerTone(st({ compatible: false }))).toBe('bad')
    expect(powerTone(st({ running: false, supervisor: sup('starting') }))).toBe('wait')
    expect(powerTone(st({ supervisor: sup('restarting') }))).toBe('wait')
    expect(powerTone(st({ op: 'restart' }))).toBe('wait')
    expect(powerTone(st({ enabled: false, running: false, supervisor: undefined, op: 'enable' }))).toBe('wait')
  })
})

describe('PowerButton', () => {
  it('the tone is a class on button.mffai-power; open adds .open and opening calls nothing', () => {
    const h = handlers()
    const r = render(<PowerButton state={st()} {...h} />)
    expect(btn().className).toBe('mffai-power')
    expect(btn().getAttribute('aria-expanded')).toBe('false')
    expect(pop()).toBeNull()
    fireEvent.click(btn())
    expect(pop()).not.toBeNull()
    expect(btn().classList.contains('open')).toBe(true)
    expect(btn().getAttribute('aria-expanded')).toBe('true')
    for (const f of Object.values(h)) expect(f).not.toHaveBeenCalled()
    r.rerender(<PowerButton state={st({ enabled: false, running: false, supervisor: undefined })} {...h} />)
    expect(btn().classList.contains('off')).toBe(true)
    r.rerender(<PowerButton state={st({ compatible: false })} {...h} />)
    expect(btn().classList.contains('bad')).toBe(true)
    r.rerender(<PowerButton state={st({ op: 'restart' })} {...h} />)
    expect(btn().classList.contains('wait')).toBe(true)
  })

  it('Esc closes and returns focus to the button; an outside click closes; a click inside does not', () => {
    render(<div><span data-testid="out">x</span><PowerButton state={st()} {...handlers()} /></div>)
    fireEvent.click(btn())
    fireEvent.mouseDown(pop()!)
    expect(pop()).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(pop()).toBeNull()
    expect(document.activeElement).toBe(btn())
    fireEvent.click(btn())
    fireEvent.mouseDown(screen.getByTestId('out'))
    expect(pop()).toBeNull()
    // 再点电源键:开合
    fireEvent.click(btn())
    fireEvent.click(btn())
    expect(pop()).toBeNull()
  })

  it('Tab leaving the popover closes it, also when focus goes nowhere (null relatedTarget); moving within it does not', () => {
    render(<div><button data-testid="out">x</button><PowerButton state={st()} {...handlers()} /></div>)
    fireEvent.click(btn())
    const sw = screen.getByRole('switch', { name: '后台' })
    fireEvent.focusOut(btn(), { relatedTarget: sw })
    expect(pop()).not.toBeNull()
    fireEvent.focusOut(sw, { relatedTarget: null })
    expect(pop()).toBeNull()
    fireEvent.click(btn())
    fireEvent.focusOut(screen.getByRole('switch', { name: '后台' }), { relatedTarget: screen.getByTestId('out') })
    expect(pop()).toBeNull()
  })

  it('rows: 后台 + chip + switch, 版本, 内存, 插件 N 个 and N 有问题, 重启, 开机自启, 重启后台', () => {
    const h = handlers()
    render(
      <PowerButton
        state={st({ rssMb: 112, supervisor: sup('running', { version: '0.8.2', restarts: 3 }), autostart: true })}
        info={{ status: status({ plugins: [{ id: 'a', state: 'active' }, { id: 'b', state: 'failed' }, { id: 'c', state: 'active' }, { id: 'd', state: 'disabled' }] }) }}
        {...h}
      />,
    )
    fireEvent.click(btn())
    const p = within(pop() as HTMLElement)
    expect(p.getByText('后台')).toBeInTheDocument()
    expect(p.getByText('运行中')).toBeInTheDocument()
    expect((p.getByRole('switch', { name: '后台' }) as HTMLInputElement).checked).toBe(true)
    for (const t of ['版本', '内存', '插件', '重启']) expect(p.getByText(t)).toBeInTheDocument()
    expect(p.getByText('0.8.2')).toBeInTheDocument()
    expect(p.getByText('112 MB')).toBeInTheDocument()
    expect(p.getByText('4 个')).toBeInTheDocument()
    expect(p.getByText('2 有问题')).toBeInTheDocument()
    expect(p.getByText('3')).toBeInTheDocument()
    expect((p.getByRole('switch', { name: '开机自启' }) as HTMLInputElement).checked).toBe(true)
    expect(p.getByText('重启后台')).toBeInTheDocument()
  })

  it('anomaly chips use the header chips\' conditions', () => {
    const r = render(<PowerButton state={st()} info={{ status: status() }} {...handlers()} />)
    fireEvent.click(btn())
    for (const t of ['代理已改', '明文存储', '数据库未收紧', '开发插件 · 完全访问', '开发插件已跳过']) expect(within(pop() as HTMLElement).queryByText(t)).toBeNull()
    r.unmount()
    render(
      <PowerButton
        state={st({ proxyStale: true })}
        info={{ status: status({ plugins: [{ id: 'm', state: 'active', trust: 'dev' }], problems: ['dev_crashed'], dbUnprotected: true, secretsBackend: 'plaintext-file' }) }}
        {...handlers()}
      />,
    )
    fireEvent.click(btn())
    for (const t of ['代理已改', '明文存储', '数据库未收紧', '开发插件 · 完全访问', '开发插件已跳过']) expect(within(pop() as HTMLElement).getByText(t)).toBeInTheDocument()
  })

  it('switches and 重启后台 call the matching handler once', () => {
    const h = handlers()
    const r = render(<PowerButton state={st({ autostart: false })} {...h} />)
    fireEvent.click(btn())
    fireEvent.click(screen.getByRole('switch', { name: '后台' }))
    expect(h.onDisable).toHaveBeenCalledTimes(1)
    expect(h.onEnable).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: '开机自启' }))
    expect(h.onAutostart).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByText('重启后台'))
    expect(h.onRestart).toHaveBeenCalledTimes(1)
    expect(h.onResetTrip).not.toHaveBeenCalled()
    r.unmount()
    // 停用时:后台开关是启用;没有重启后台
    const h2 = handlers()
    render(<PowerButton state={st({ enabled: false, running: false, supervisor: undefined })} {...h2} />)
    fireEvent.click(btn())
    expect((screen.getByRole('switch', { name: '后台' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByText('重启后台')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: '后台' }))
    expect(h2.onEnable).toHaveBeenCalledTimes(1)
    expect(h2.onDisable).not.toHaveBeenCalled()
  })

  it('重启后台 is resetTrip when tripped and compatible, restart otherwise; hidden while op', () => {
    const h = handlers()
    const r = render(<PowerButton state={st({ running: false, supervisor: sup('tripped', { trippedReason: 'oom' }) })} {...h} />)
    fireEvent.click(btn())
    fireEvent.click(screen.getByText('重启后台'))
    expect(h.onResetTrip).toHaveBeenCalledTimes(1)
    expect(h.onRestart).not.toHaveBeenCalled()
    r.unmount()
    const h2 = handlers()
    const r2 = render(<PowerButton state={st({ running: false, compatible: false, supervisor: sup('tripped') })} {...h2} />)
    fireEvent.click(btn())
    fireEvent.click(screen.getByText('重启后台'))
    expect(h2.onRestart).toHaveBeenCalledTimes(1)
    expect(h2.onResetTrip).not.toHaveBeenCalled()
    r2.unmount()
    render(<PowerButton state={st({ op: 'restart' })} {...handlers()} />)
    fireEvent.click(btn())
    expect(screen.queryByText('重启后台')).toBeNull()
  })
})

describe('power popover in MffaiView (host channels only)', () => {
  beforeEach(() => route.set({ page: 'tasks' }))
  const calls = { status: status() }
  const open = async () => { await screen.findByTestId('mffai-page-tasks'); fireEvent.click(btn()) }
  const channelCalls = (f: ReturnType<typeof installFakeForge>) => f.calls.map((c) => c.method).filter((m) => /enable|disable|restart|trip|autostart|wipe/i.test(m))

  it('opening calls nothing; the off switch calls mffai.disable once and no worker call', async () => {
    const f = installFakeForge({ calls })
    render(<MffaiView />)
    await open()
    const n = f.mffai.state.mock.calls.length
    expect(f.mffai.disable).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: '后台' }))
    expect(f.mffai.disable).toHaveBeenCalledTimes(1)
    expect(f.mffai.enable).not.toHaveBeenCalled()
    expect(f.mffai.restart).not.toHaveBeenCalled()
    expect(f.forge.setSettings).not.toHaveBeenCalled()
    expect(channelCalls(f)).toEqual([])
    expect(f.mffai.state.mock.calls.length).toBeGreaterThanOrEqual(n)
  })

  it('开机自启 while enabled is mffai.setAutostart, not setSettings', async () => {
    const f = installFakeForge({ calls })
    render(<MffaiView />)
    await open()
    fireEvent.click(screen.getByRole('switch', { name: '开机自启' }))
    expect(f.mffai.setAutostart).toHaveBeenCalledWith(true)
    expect(f.mffai.setAutostart).toHaveBeenCalledTimes(1)
    expect(f.forge.setSettings).not.toHaveBeenCalled()
    expect(channelCalls(f)).toEqual([])
  })

  it('重启后台 with a stale proxy calls the respawning restart', async () => {
    const f = installFakeForge({ calls, state: { proxyStale: true } })
    render(<MffaiView />)
    await open()
    fireEvent.click(screen.getByText('重启后台'))
    expect(f.mffai.restart).toHaveBeenCalledTimes(1)
    expect(f.mffai.resetTrip).not.toHaveBeenCalled()
  })

  it('disabled: the on switch saves settings then enables, like the enable hero; 开机自启 is setSettings', async () => {
    const f = installFakeForge({ calls, state: { enabled: false, running: false, supervisor: undefined, autostart: false, dataDir: '/d' } })
    render(<MffaiView />)
    await waitFor(() => expect(btn()).not.toBeNull())
    fireEvent.click(btn())
    fireEvent.click(screen.getByRole('switch', { name: '开机自启' }))
    expect(f.forge.setSettings).toHaveBeenLastCalledWith({ mffai: { enabled: false, autostart: true } })
    expect(f.mffai.setAutostart).not.toHaveBeenCalled()
    f.setState({ autostart: true })
    fireEvent.click(screen.getByRole('switch', { name: '后台' }))
    await waitFor(() => expect(f.mffai.enable).toHaveBeenCalledTimes(1))
    expect(f.forge.setSettings).toHaveBeenLastCalledWith({ mffai: { enabled: false, autostart: true } })
    expect(f.mffai.disable).not.toHaveBeenCalled()
    expect(channelCalls(f)).toEqual([])
  })

  it('the popover opens beside the rail, not over it: it is outside .mffai-nav and keyboard reachable', async () => {
    installFakeForge({ calls })
    render(<MffaiView />)
    await open()
    expect(pop()!.closest('.mffai-nav')).toBeNull()
    expect(document.querySelectorAll('.mffai-nav button')).toHaveLength(7)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(pop()).toBeNull()
    await act(async () => {})
  })
})
