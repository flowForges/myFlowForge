import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { HostSwitcher } from './HostSwitcher'
import type { HostStatusView, RemoteHostView } from '@shared/remote/hostView'

const listeners: ((s: HostStatusView) => void)[] = []
const LOCAL: HostStatusView = { hostId: null, label: '本机', state: { status: 'local' }, methods: [] }
const ON_CLOUD: HostStatusView = { hostId: 'h1', label: '云服务器', state: { status: 'ready', version: '1.1.2', methods: [] }, methods: [], icon: '🌩', display: 'both' }
const DOWN: HostStatusView = { hostId: 'h1', label: '云服务器', state: { status: 'retrying', attempt: 1, error: '连接断开(1006)', nextInMs: 3000 }, methods: [], icon: '🌩', display: 'both' }

const HOSTS: RemoteHostView[] = [
  { id: 'h1', label: '云服务器', kind: 'ssh', address: '6767', sshTarget: 'me@1.2.3.4', icon: '🌩', display: 'both', token: '', pubKey: '', relay: '', lastConnectedAt: 0 },
  { id: 'h2', label: '家里的Windows', kind: 'direct', address: 'ws://192.168.1.20:6767', sshTarget: '', icon: '🏠', display: 'icon', token: '', pubKey: '', relay: '', lastConnectedAt: 0 },
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
const chip = (c: HTMLElement) => c.querySelector('.sb-host')!

describe('HostSwitcher', () => {
  it('★一台主机都没配过时:只画一枚图标,不写字', async () => {
    // 原来是整个组件不渲染,可那样这个功能就彻底没有入口了。缩成一枚图标既不占地方,
    // 点开又能走到「主机设置…」。「本机」那两个字对从不用远程的人是废话,所以省掉的是字不是图标。
    hosts = []
    const { container } = render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
    await waitFor(() => expect(chip(container)).toBeTruthy())
    expect(screen.getByText('💻')).toBeInTheDocument()
    expect(screen.queryByText('本机')).toBeNull()
  })

  it('★没配过主机时那枚点也是亮的 —— 本机从定义上就在线', async () => {
    hosts = []
    const { container } = render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
    await waitFor(() => expect(chip(container)).toBeTruthy())
    expect(chip(container).className).toContain('ok')
  })

  it('配过主机就显示,哪怕现在在本机(否则你没法从本机切出去)', async () => {
    render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
    await waitFor(() => expect(screen.getByText('本机')).toBeInTheDocument())
  })

  it('连着远程时显示主机名', async () => {
    render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
    await push(ON_CLOUD)
    expect(screen.getByText('云服务器')).toBeInTheDocument()
  })

  it('★断线时整枚变红并写出状态,不能拿缓存假装在线', async () => {
    const { container } = render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
    await push(DOWN)
    expect(container.querySelector('.sb-host.bad')).toBeTruthy()
    expect(screen.getByText('已断开')).toBeInTheDocument()
  })

  it('★点开是切换菜单:本机 + 全部主机,当前那台打勾', async () => {
    render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
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
    render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
    await push(ON_CLOUD)
    await openMenu()
    await act(async () => { fireEvent.click(screen.getByText('家里的Windows')) })
    expect(hostsConnect).toHaveBeenCalledWith('h2')
  })

  it('点「本机」就断开回本机', async () => {
    render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
    await push(ON_CLOUD)
    await openMenu()
    await act(async () => { fireEvent.click(screen.getByText('本机')) })
    expect(hostsDisconnect).toHaveBeenCalled()
  })

  it('★「主机设置」和切换项之间有分割线,且它不是一个切换项', async () => {
    // 它不是「切到哪台」,是「去配置」。混在一起会让人误点。
    const onOpenHosts = vi.fn()
    const { container } = render(<HostSwitcher display="both" onOpenHosts={onOpenHosts} />)
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
    render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
    await push(ON_CLOUD)
    await openMenu()
    await act(async () => { fireEvent.click(screen.getByText('家里的Windows')) })
    expect(await screen.findByRole('alert')).toHaveTextContent('SSH 隧道超时')
  })

  it('Esc 关掉菜单', async () => {
    render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
    await push(ON_CLOUD)
    await openMenu()
    expect(screen.getAllByRole('menuitemradio').length).toBe(3)
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryAllByRole('menuitemradio').length).toBe(0)
  })

  /**
   * ★★显示方式是**这枚按钮的全局设置**(`appearance.hostChip`),不是每台主机自己的属性。
   *  旧版存在每台主机上,后果用户当场撞上了两条:同一枚按钮切一台主机就换一副长相;
   *  而本机根本没地方存,只能写死成「只显示名称」——「我设置了只显示图标,但是本机还是显示
   *  一个大按钮」。所以下面这组用例全部是「按 prop 走,不看 status.display」。
   */
  describe('图标与名称怎么显示', () => {
    it('「图标 + 名称」时两个都显示', async () => {
      render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
      await push(ON_CLOUD)
      expect(screen.getByText('🌩')).toBeInTheDocument()
      expect(screen.getByText('云服务器')).toBeInTheDocument()
    })

    it('「只显示图标」时名字不出现', async () => {
      render(<HostSwitcher display="icon" onOpenHosts={() => {}} />)
      await push(ON_CLOUD)
      expect(screen.getByText('🌩')).toBeInTheDocument()
      expect(screen.queryByText('云服务器')).toBeNull()
    })

    it('「只显示名称」时图标不出现', async () => {
      render(<HostSwitcher display="name" onOpenHosts={() => {}} />)
      await push(ON_CLOUD)
      expect(screen.getByText('云服务器')).toBeInTheDocument()
      // 菜单没开,🌩 只可能来自按钮本身
      expect(screen.queryByText('🌩')).toBeNull()
    })

    it('★★本机也照办 —— 旧版把本机写死成「只显示名称」,于是设了只显示图标它依然是一大坨字', async () => {
      render(<HostSwitcher display="icon" onOpenHosts={() => {}} />)
      await push(LOCAL)
      expect(screen.getByText('💻')).toBeInTheDocument()
      expect(screen.queryByText('本机')).toBeNull()
    })

    it('★★切主机不改变长相 —— 每台主机自己带的 display 一律不作数', async () => {
      // 这条钉的就是「一个控件只该有一种长相」。两台主机的 display 一个 both 一个 icon,
      // 按钮设成 icon,那就两台都只画图标。
      render(<HostSwitcher display="icon" onOpenHosts={() => {}} />)
      await push(ON_CLOUD)                       // 它自己带的是 display:'both'
      expect(screen.queryByText('云服务器')).toBeNull()
    })

    it('★只显示图标时,断线仍然看得出来(点变红,类名带 bad)', async () => {
      // 缩成一枚图标之后,「断线态要显式」这条约束不能跟着缩掉。
      const { container } = render(<HostSwitcher display="icon" onOpenHosts={() => {}} />)
      await push(DOWN)
      expect(container.querySelector('.sb-host.bad')).toBeTruthy()
      // 文字没地方放了,但读屏和悬停仍然拿得到完整状态
      expect(chip(container).getAttribute('title')).toContain('已断开')
    })

    it('没设图标的主机用默认图标,不会渲染成空白', async () => {
      hosts = [{ ...HOSTS[0]!, icon: '' }]
      render(<HostSwitcher display="icon" onOpenHosts={() => {}} />)
      await push({ ...ON_CLOUD, icon: '' })
      expect(screen.getByText('🖥️')).toBeInTheDocument()
    })

    it('菜单里每台主机都带自己的图标', async () => {
      render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
      await push(ON_CLOUD)
      await openMenu()
      expect(screen.getByText('💻')).toBeInTheDocument()   // 本机
      expect(screen.getAllByText('🌩').length).toBeGreaterThan(0)
      expect(screen.getByText('🏠')).toBeInTheDocument()
    })
  })

  /** 圆点=连接状态。用户点名的三档:亮=连上了、红=连不上、灰=没连。 */
  describe('★那枚圆点', () => {
    it('连上远程 = 绿', async () => {
      const { container } = render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
      await push(ON_CLOUD)
      expect(chip(container).className).toContain('ok')
    })

    it('★在本机 = 绿,不是灰 —— 本机从定义上就在线', async () => {
      const { container } = render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
      await push(LOCAL)
      expect(chip(container).className).toContain('ok')
      expect(chip(container).className).not.toContain('idle')
    })

    it('连接中 = 黄', async () => {
      const { container } = render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
      await push({ ...ON_CLOUD, state: { status: 'connecting', attempt: 1 } })
      expect(chip(container).className).toContain('warn')
    })

    it('连不上 = 红', async () => {
      const { container } = render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
      await push({ ...ON_CLOUD, state: { status: 'failed', error: '连不上' } })
      expect(chip(container).className).toContain('bad')
    })

    it('对面主动关了 = 灰', async () => {
      const { container } = render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
      await push({ ...ON_CLOUD, state: { status: 'closed' } })
      expect(chip(container).className).toContain('idle')
    })
  })

  describe('点击不该抖也不该白闪', () => {
    it('★点当前这台 = 什么都不做(不重连)', async () => {
      // 重连一次既没意义,还会让界面白闪一轮(断开 → 连接中 → 已连接),看起来像点坏了。
      render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
      await push(ON_CLOUD)
      await openMenu()
      await act(async () => { fireEvent.click(screen.getAllByText('云服务器')[0]!) })
      expect(hostsConnect).not.toHaveBeenCalled()
      expect(hostsDisconnect).not.toHaveBeenCalled()
    })

    it('在本机时点「本机」也一样不动作', async () => {
      render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
      await push(LOCAL)
      await openMenu()
      await act(async () => { fireEvent.click(screen.getAllByText('本机')[0]!) })
      expect(hostsDisconnect).not.toHaveBeenCalled()
    })

    it('★连上了不写状态,断了才写 —— 「已连接」这三个字绿点已经说过了', async () => {
      // 搬到状态栏之后不再需要为「防止居中抖动」留一个常驻空格子(旧版 .st 是空的也占位)。
      const { container } = render(<HostSwitcher display="both" onOpenHosts={() => {}} />)
      await push(ON_CLOUD)
      expect(container.querySelector('.sb-host .st')).toBeNull()
      await push(DOWN)
      expect(container.querySelector('.sb-host .st')!.textContent).toBe('已断开')
    })
  })
})
