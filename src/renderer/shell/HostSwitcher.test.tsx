import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { HostSwitcher } from './HostSwitcher'
import type { HostStatusView, RemoteHostView } from '@shared/remote/hostView'

const listeners: ((s: HostStatusView) => void)[] = []
const LOCAL: HostStatusView = { hostId: null, label: '本机', state: { status: 'local' }, methods: [] }
const ON_CLOUD: HostStatusView = { hostId: 'h1', label: '云服务器', state: { status: 'ready', version: '1.1.2', methods: [] }, methods: [] }
const DOWN: HostStatusView = { hostId: 'h1', label: '云服务器', state: { status: 'retrying', attempt: 1, error: '连接断开(1006)', nextInMs: 3000 }, methods: [] }

const HOSTS: RemoteHostView[] = [
  { id: 'h1', label: '云服务器', kind: 'ssh', address: '6767', sshTarget: 'me@1.2.3.4', token: '', lastConnectedAt: 0 },
  { id: 'h2', label: '家里的Windows', kind: 'direct', address: 'ws://192.168.1.20:6767', sshTarget: '', token: '', lastConnectedAt: 0 },
]

const hostsConnect = vi.fn(async () => ON_CLOUD)
const hostsDisconnect = vi.fn(async () => LOCAL)
let hosts = HOSTS

beforeEach(() => {
  listeners.length = 0
  hosts = HOSTS
  vi.clearAllMocks()
  ;(window as unknown as { forge: unknown }).forge = {
    hostsStatus: vi.fn(async () => LOCAL),
    hostsList: vi.fn(async () => hosts),
    onHostStatus: (cb: (s: HostStatusView) => void) => { listeners.push(cb); return () => {} },
    onSettingsChangedBy: () => () => {},
    hostsConnect, hostsDisconnect,
  }
})

const push = async (s: HostStatusView) => { await act(async () => { listeners.forEach((l) => l(s)) }) }
const openMenu = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { expanded: false })) }) }

describe('HostSwitcher', () => {
  it('★一台主机都没配过时什么都不渲染 —— 不用远程的人界面完全不变', async () => {
    hosts = []
    const { container } = render(<HostSwitcher onOpenHosts={() => {}} />)
    await act(async () => {})
    expect(container.innerHTML).toBe('')
  })

  it('配过主机就显示,哪怕现在在本机(否则你没法从本机切出去)', async () => {
    render(<HostSwitcher onOpenHosts={() => {}} />)
    await waitFor(() => expect(screen.getByText('本机')).toBeInTheDocument())
  })

  it('连着远程时显示主机名', async () => {
    render(<HostSwitcher onOpenHosts={() => {}} />)
    await push(ON_CLOUD)
    expect(screen.getByText('云服务器')).toBeInTheDocument()
  })

  it('★断线时整枚变红并写出状态,不能拿缓存假装在线', async () => {
    const { container } = render(<HostSwitcher onOpenHosts={() => {}} />)
    await push(DOWN)
    expect(container.querySelector('.hs-chip.bad')).toBeTruthy()
    expect(screen.getByText('已断开')).toBeInTheDocument()
  })

  it('★点开是切换菜单:本机 + 全部主机,当前那台打勾', async () => {
    render(<HostSwitcher onOpenHosts={() => {}} />)
    await push(ON_CLOUD)
    await openMenu()
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('本机'),
      expect.stringContaining('云服务器'),
      expect.stringContaining('家里的Windows'),
    ])
    expect(items[1]!.getAttribute('aria-checked')).toBe('true')   // 当前这台
    expect(items[0]!.getAttribute('aria-checked')).toBe('false')
  })

  it('点一台主机就切过去', async () => {
    render(<HostSwitcher onOpenHosts={() => {}} />)
    await push(ON_CLOUD)
    await openMenu()
    await act(async () => { fireEvent.click(screen.getByText('家里的Windows')) })
    expect(hostsConnect).toHaveBeenCalledWith('h2')
  })

  it('点「本机」就断开回本机', async () => {
    render(<HostSwitcher onOpenHosts={() => {}} />)
    await push(ON_CLOUD)
    await openMenu()
    await act(async () => { fireEvent.click(screen.getByText('本机')) })
    expect(hostsDisconnect).toHaveBeenCalled()
  })

  it('★「主机设置」和切换项之间有分割线,且它不是一个切换项', async () => {
    // 它不是「切到哪台」,是「去配置」。混在一起会让人误点。
    const onOpenHosts = vi.fn()
    const { container } = render(<HostSwitcher onOpenHosts={onOpenHosts} />)
    await push(ON_CLOUD)
    await openMenu()
    expect(document.querySelector('.hs-sep')).toBeTruthy()
    const setting = screen.getByText('主机设置…')
    expect(setting.closest('[role="menuitemradio"]')).toBeNull()
    await act(async () => { fireEvent.click(setting) })
    expect(onOpenHosts).toHaveBeenCalled()
    expect(hostsConnect).not.toHaveBeenCalled()
    void container
  })

  it('★切换失败要当面说,不能只留在控制台', async () => {
    hostsConnect.mockRejectedValueOnce(new Error('SSH 隧道超时'))
    render(<HostSwitcher onOpenHosts={() => {}} />)
    await push(ON_CLOUD)
    await openMenu()
    await act(async () => { fireEvent.click(screen.getByText('家里的Windows')) })
    expect(await screen.findByRole('alert')).toHaveTextContent('SSH 隧道超时')
  })

  it('Esc 关掉菜单', async () => {
    render(<HostSwitcher onOpenHosts={() => {}} />)
    await push(ON_CLOUD)
    await openMenu()
    expect(screen.getAllByRole('menuitemradio').length).toBe(3)
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryAllByRole('menuitemradio').length).toBe(0)
  })
})
