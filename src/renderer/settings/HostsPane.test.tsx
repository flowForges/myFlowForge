import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { HostsPane, normalizeAddress } from './HostsPane'
import type { HostStatusView, RemoteHostView } from '@shared/remote/hostView'

const LOCAL: HostStatusView = { hostId: null, label: '本机', state: { status: 'local' }, methods: [] }
const MOBILE_OFF = { running: false, host: '0.0.0.0', port: 6789, token: '', addresses: [], clients: 0, error: '' }
let hosts: RemoteHostView[] = []
const hostsUpsert = vi.fn(async (h: unknown) => { void h; return hosts })

beforeEach(() => {
  hosts = []
  vi.clearAllMocks()
  ;(window as unknown as { forge: unknown }).forge = {
    hostsList: vi.fn(async () => hosts),
    hostsStatus: vi.fn(async () => LOCAL),
    onHostStatus: () => () => {},
    hostsUpsert,
    hostsRemove: vi.fn(async () => hosts),
    hostsConnect: vi.fn(async () => LOCAL),
    hostsDisconnect: vi.fn(async () => LOCAL),
    hostsExport: vi.fn(async () => '{}'),
    hostsImport: vi.fn(async () => ({ ok: true, added: 1 })),
    // 「手机端」那一节现在也在这一屏里(它是同一件事的反向:别的设备连进来)。
    mobileStatus: vi.fn(async () => MOBILE_OFF),
    mobileApply: vi.fn(async () => MOBILE_OFF),
    mobileRegenToken: vi.fn(async () => MOBILE_OFF),
    onMobileStatus: () => () => {},
  }
})

const openForm = async () => {
  render(<HostsPane />)
  await waitFor(() => expect(screen.getAllByText('添加主机').length).toBeGreaterThan(0))
  await act(async () => { fireEvent.click(screen.getAllByText('添加主机')[0]!) })
}
const type = (label: string, value: string) => {
  const input = screen.getByText(label).parentElement!.querySelector('input')!
  fireEvent.change(input, { target: { value } })
}
const save = async () => { await act(async () => { fireEvent.click(screen.getByText('保存')) }) }
/**
 * 挑一项下拉。★这两个控件 2026-09-03 从原生 `<select>` 换成了自绘的(`Select.tsx`)——
 * 原生 select 展开的那张单子是**系统画的**,CSS 管不着,在三套皮肤 + 壁纸取色的界面里
 * 是唯一一处对不上的东西。所以这里也不能再 `querySelector('select')` 了。
 * ★按 `role` 找,不是按 class:class 改名不该让这一串测试红,而「有一个能选的选项」才是要钉的。
 */
const choose = (label: string, option: string) => {
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}
/** 挑一枚主机标识(原来是手打表情的输入框,现在是六选一)。 */
const pickIcon = (ariaLabel: string) => fireEvent.click(screen.getByRole('radio', { name: ariaLabel }))

describe('HostsPane 保存校验', () => {
  it('★名称为空时:按钮**能点**,并且说清楚缺什么(而不是静静地灰着)', async () => {
    // 第一版是「名称空就 disabled」。真机验收就卡在这儿:填完地址点保存毫无反应、也没解释,
    // 看起来就是按钮坏了 —— 于是一台主机都没存进去,后面全部步骤白做,
    // 而用户看到的现象是「没有状态条」,完全指不到原因。
    await openForm()
    await save()
    expect(screen.getByText(/起个名字/)).toBeInTheDocument()
    expect(hostsUpsert).not.toHaveBeenCalled()
  })

  it('★把 ws:// 填进 SSH 目标要当场拦住并指出填错了框', async () => {
    // 真机验收就栽在这儿:ssh 真的去连了一台叫「ws://127.0.0.1」的机器,
    // 报错是一长串 ssh 命令行 —— 完全指不到「你填错框了」这个真实原因。
    await openForm()
    type('名称', '云服务器')
    type('SSH 目标', 'ws://127.0.0.1')
    await save()
    expect(screen.getByText(/不要写 ws:\/\//)).toBeInTheDocument()
    expect(hostsUpsert).not.toHaveBeenCalled()
  })

  it('SSH 的远端端口只收数字', async () => {
    await openForm()
    type('名称', 'x')
    type('SSH 目标', 'me@1.2.3.4')
    type('远端 daemon 端口', 'ws://x')
    await save()
    expect(screen.getByText(/只填数字/)).toBeInTheDocument()
  })

  it('直连模式下填了 user@host 要提示他选错了方式', async () => {
    await openForm()
    type('名称', 'x')
    choose('连接方式', '直接连接(局域网 / Tailscale / 本机自测)')
    type('地址', 'me@1.2.3.4')
    await save()
    expect(screen.getByText(/看起来是 SSH 目标/)).toBeInTheDocument()
  })

  it('SSH 模式:目标为空要点出来', async () => {
    await openForm()
    type('名称', '云服务器')
    await save()
    expect(screen.getByText(/SSH 目标不能为空/)).toBeInTheDocument()
  })

  it('直连模式:地址为空要点出来 —— 存下来也连不上,不如当场拦住', async () => {
    await openForm()
    type('名称', '本机 daemon')
    choose('连接方式', '直接连接(局域网 / Tailscale / 本机自测)')
    type('地址', '')
    await save()
    expect(screen.getByText(/地址不能为空/)).toBeInTheDocument()
  })

  it('填全了就真的存下去', async () => {
    await openForm()
    type('名称', '本机 daemon')
    choose('连接方式', '直接连接(局域网 / Tailscale / 本机自测)')
    type('地址', 'ws://127.0.0.1:6789')
    await save()
    expect(hostsUpsert).toHaveBeenCalledWith(expect.objectContaining({ label: '本机 daemon', kind: 'direct', address: 'ws://127.0.0.1:6789', display: 'both' }))
  })

  it('★不带 ws:// 的地址自动补上 —— 很多人就是直接写 127.0.0.1:6789', async () => {
    // 不补的话 new WebSocket('127.0.0.1:6789') 当场抛,错误信息还跟「地址写法」毫无关系。
    await openForm()
    type('名称', 'x')
    choose('连接方式', '直接连接(局域网 / Tailscale / 本机自测)')
    type('地址', '127.0.0.1:6789')
    await save()
    expect(hostsUpsert).toHaveBeenCalledWith(expect.objectContaining({ address: 'ws://127.0.0.1:6789' }))
  })

  it('空态里就能直接添加,不用先找按钮', async () => {
    render(<HostsPane />)
    await waitFor(() => expect(screen.getByText('还没有添加任何远程主机')).toBeInTheDocument())
    expect(screen.getAllByText('添加主机').length).toBeGreaterThan(0)
  })
})

describe('normalizeAddress', () => {
  it.each([
    ['127.0.0.1:6789', 'ws://127.0.0.1:6789'],
    ['ws://127.0.0.1:6789', 'ws://127.0.0.1:6789'],
    ['wss://x.com', 'wss://x.com'],
    ['WS://X.com', 'WS://X.com'],
    ['  1.2.3.4:80  ', 'ws://1.2.3.4:80'],
    ['', ''],
  ])('%s → %s', (a, b) => { expect(normalizeAddress(a)).toBe(b) })
})

describe('校验提示的位置', () => {
  it('★提示要挨着「保存」按钮,不能只出现在面板顶部', async () => {
    // 真机验收在这儿卡了两轮:用户滚到表单点保存,提示渲染在面板顶部、在视野之外,
    // 看到的现象就是「点了没反应」。
    await openForm()
    await save()
    const msg = screen.getByText(/起个名字/)
    const btn = screen.getByText('保存')
    // 二者必须在同一个表单块里,且提示紧贴按钮那一行的上方
    const group = btn.closest('.set-group')!
    expect(group.contains(msg)).toBe(true)
    expect(msg.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('重新打开表单时旧提示要清掉', async () => {
    await openForm()
    await save()
    expect(screen.getByText(/起个名字/)).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('取消')) })
    await act(async () => { fireEvent.click(screen.getAllByText('添加主机')[0]!) })
    expect(screen.queryByText(/起个名字/)).toBeNull()
  })

  it('标识可以留空(有默认),不该当成必填拦住', async () => {
    // 标识只是个方便认的东西,强制填反而多一道门槛。
    await openForm()
    type('名称', 'x')
    choose('连接方式', '直接连接(局域网 / Tailscale / 本机自测)')
    type('地址', 'ws://127.0.0.1:1')
    await save()
    expect(hostsUpsert).toHaveBeenCalledWith(expect.objectContaining({ icon: '' }))
  })

  it('填了标识和显示方式就存下去', async () => {
    await openForm()
    type('名称', '云服务器')
    pickIcon('服务器')
    choose('标题栏上显示', '只显示标识')
    choose('连接方式', '直接连接(局域网 / Tailscale / 本机自测)')
    type('地址', 'ws://1.2.3.4:6767')
    await save()
    expect(hostsUpsert).toHaveBeenCalledWith(expect.objectContaining({ icon: '☁️', display: 'icon' }))
  })
})

describe('★★走中转的主机必须一眼看得出来', () => {
  /**
   * 用户配好了跨网络的第二台电脑,然后问「它这种是不是没走中转?我那边好像还是本地」。
   * 配对码里明明带着中转地址,连接也真的走了中转 —— **但界面把它标成「直接连接」,
   * 副标题还写着那台机器的局域网地址**。连接方式是看不见的属性,界面不说就没有第二个地方能说。
   */
  const relayed: RemoteHostView = {
    id: 'h1', label: '书房的 Mac', kind: 'direct',
    address: 'ws://192.168.1.20:6789', sshTarget: '', icon: '🖥️', display: 'both',
    token: 't', pubKey: 'k', relay: 'wss://relay.example.workers.dev',
  } as RemoteHostView

  it('标的是「经中转」,不是「直接连接」', async () => {
    hosts = [relayed]
    render(<HostsPane />)
    await waitFor(() => expect(screen.getByText('书房的 Mac')).toBeTruthy())
    expect(screen.getByText('经中转')).toBeTruthy()
    expect(screen.queryByText('直接连接')).toBeNull()
  })

  it('副标题给的是**中转地址**,不是那台机器的局域网地址', async () => {
    // 走中转时拨的是中转;`address` 只是「这台机器以后出现在局域网里时的地址」的一份记录。
    // 把它当成连接目标显示出来,就是在说一件不成立的事 —— 而人正是照着这一行判断
    // 「我到底连的是哪条路」。
    hosts = [relayed]
    render(<HostsPane />)
    await waitFor(() => expect(screen.getByText('书房的 Mac')).toBeTruthy())
    expect(screen.getByText('wss://relay.example.workers.dev')).toBeTruthy()
    expect(screen.queryByText('ws://192.168.1.20:6789')).toBeNull()
  })

  it('没有中转的照旧 —— 别把普通直连也改了', async () => {
    hosts = [{ ...relayed, relay: '' } as RemoteHostView]
    render(<HostsPane />)
    await waitFor(() => expect(screen.getByText('书房的 Mac')).toBeTruthy())
    expect(screen.getByText('直接连接')).toBeTruthy()
    expect(screen.getByText('ws://192.168.1.20:6789')).toBeTruthy()
  })
})

describe('自绘下拉框', () => {
  it('点开、挑一项、关掉', async () => {
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: '连接方式' }))
    expect(screen.getAllByRole('option').length).toBe(2)
    fireEvent.click(screen.getByRole('option', { name: '直接连接(局域网 / Tailscale / 本机自测)' }))
    // 选完就收起来,而且按钮上显示的是刚选的那一项
    expect(screen.queryAllByRole('option').length).toBe(0)
    expect(screen.getByRole('button', { name: '连接方式' }).textContent).toContain('直接连接')
  })

  it('★键盘也能用 —— 原生 select 白送的这些,自绘就得自己补', async () => {
    await openForm()
    const btn = screen.getByRole('button', { name: '标题栏上显示' })
    fireEvent.keyDown(btn, { key: 'ArrowDown' })          // 打开
    expect(screen.getAllByRole('option').length).toBe(3)
    fireEvent.keyDown(btn, { key: 'ArrowDown' })          // 移到「只显示标识」
    fireEvent.keyDown(btn, { key: 'Enter' })
    expect(btn.textContent).toContain('只显示标识')
  })

  it('Esc 关掉,并且**不改值**', async () => {
    await openForm()
    const btn = screen.getByRole('button', { name: '标题栏上显示' })
    fireEvent.keyDown(btn, { key: 'ArrowDown' })
    fireEvent.keyDown(btn, { key: 'ArrowDown' })
    fireEvent.keyDown(btn, { key: 'Escape' })
    expect(screen.queryAllByRole('option').length).toBe(0)
    expect(btn.textContent).toContain('标识 + 名称')
  })
})
