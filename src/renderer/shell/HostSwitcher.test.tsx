import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { HostSwitcher } from './HostSwitcher'
import type { HostStatusView, RemoteHostView } from '@shared/remote/hostView'

const listeners: ((s: HostStatusView) => void)[] = []
const LOCAL: HostStatusView = { hostId: null, label: '本机', state: { status: 'local' }, methods: [] }
const ON_CLOUD: HostStatusView = { hostId: 'h1', label: '云服务器', state: { status: 'ready', version: '1.1.2', methods: [] }, methods: [], icon: '🌩', display: 'both' }
const DOWN: HostStatusView = { hostId: 'h1', label: '云服务器', state: { status: 'retrying', attempt: 1, error: '连接断开(1006)', nextInMs: 3000 }, methods: [], icon: '🌩', display: 'both' }
const ICON_ONLY: HostStatusView = { ...ON_CLOUD, display: 'icon' }
const ICON_ONLY_DOWN: HostStatusView = { ...DOWN, display: 'icon' }

const HOSTS: RemoteHostView[] = [
  { id: 'h1', label: '云服务器', kind: 'ssh', address: '6767', sshTarget: 'me@1.2.3.4', icon: '🌩', display: 'both', token: '', lastConnectedAt: 0 },
  { id: 'h2', label: '家里的Windows', kind: 'direct', address: 'ws://192.168.1.20:6767', sshTarget: '', icon: '🏠', display: 'icon', token: '', lastConnectedAt: 0 },
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

  describe('标识与显示方式', () => {
    it('「标识 + 名称」时两个都显示', async () => {
      render(<HostSwitcher onOpenHosts={() => {}} />)
      await push(ON_CLOUD)
      expect(screen.getByText('🌩')).toBeInTheDocument()
      expect(screen.getByText('云服务器')).toBeInTheDocument()
    })

    it('★只显示标识时:芯片缩成一枚圆的,名字不出现', async () => {
      // 标题栏正中挂一串主机名太抢眼。一个自己认得的表情就够了。
      const { container } = render(<HostSwitcher onOpenHosts={() => {}} />)
      await push(ICON_ONLY)
      expect(container.querySelector('.hs-chip.iconly')).toBeTruthy()
      expect(screen.getByText('🌩')).toBeInTheDocument()
      expect(screen.queryByText('云服务器')).toBeNull()
    })

    it('★只显示标识时不再挂圆点 —— 状态由光圈表达,两套说同一件事是冗余', async () => {
      const { container } = render(<HostSwitcher onOpenHosts={() => {}} />)
      await push(ICON_ONLY)
      expect(container.querySelector('.hs-chip .dot')).toBeNull()
    })

    it('★只显示标识时,断线仍然看得出来(光圈变红,类名带 bad)', async () => {
      // 缩成一枚表情之后,「断线态要显式」这条约束不能跟着缩掉。
      const { container } = render(<HostSwitcher onOpenHosts={() => {}} />)
      await push(ICON_ONLY_DOWN)
      expect(container.querySelector('.hs-chip.iconly.bad')).toBeTruthy()
      // 文字没地方放了,但读屏和悬停仍然拿得到完整状态
      expect(container.querySelector('.hs-chip')!.getAttribute('title')).toContain('已断开')
    })

    it('没设标识的主机用默认图标,不会渲染成空白', async () => {
      hosts = [{ ...HOSTS[0]!, icon: '' }]
      render(<HostSwitcher onOpenHosts={() => {}} />)
      await push({ ...ON_CLOUD, icon: '', display: 'icon' })
      expect(screen.getByText('🖥️')).toBeInTheDocument()
    })

    it('菜单里每台主机都带自己的标识', async () => {
      render(<HostSwitcher onOpenHosts={() => {}} />)
      await push(ON_CLOUD)
      await openMenu()
      expect(screen.getByText('💻')).toBeInTheDocument()   // 本机
      expect(screen.getAllByText('🌩').length).toBeGreaterThan(0)
      expect(screen.getByText('🏠')).toBeInTheDocument()
    })
  })

  describe('点击不该抖也不该白闪', () => {
    it('★点当前这台 = 什么都不做(不重连)', async () => {
      // 重连一次既没意义,还会让界面白闪一轮(断开 → 连接中 → 已连接),看起来像点坏了。
      render(<HostSwitcher onOpenHosts={() => {}} />)
      await push(ON_CLOUD)
      await openMenu()
      await act(async () => { fireEvent.click(screen.getAllByText('云服务器')[0]!) })
      expect(hostsConnect).not.toHaveBeenCalled()
      expect(hostsDisconnect).not.toHaveBeenCalled()
    })

    it('在本机时点「本机」也一样不动作', async () => {
      render(<HostSwitcher onOpenHosts={() => {}} />)
      await push(LOCAL)
      await openMenu()
      await act(async () => { fireEvent.click(screen.getAllByText('本机')[0]!) })
      expect(hostsDisconnect).not.toHaveBeenCalled()
    })

    it('★状态那一格常驻 —— 已连接/连接中/已断开 之间切换不改变宽度(芯片居中,宽度一变就在抖)', async () => {
      const { container } = render(<HostSwitcher onOpenHosts={() => {}} />)
      await push(ON_CLOUD)
      expect(container.querySelector('.hs-chip .st')).toBeTruthy()   // ready 时 short 为空,格子仍在
      await push(DOWN)
      expect(container.querySelector('.hs-chip .st')!.textContent).toBe('已断开')
    })
  })
})
