import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { HostsPane, normalizeAddress } from './HostsPane'
import type { HostDisplay, HostStatusView, RemoteHostView } from '@shared/remote/hostView'

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

/**
 * 页面级那条设置(底部主机按钮显示成什么样)的两个 prop。
 * ★包一层**真有 state** 的壳:它是受控组件,拿 `vi.fn()` 当 onChange 的话选完值不会变,
 *  于是「挑一项」这类用例会假绿(按钮上的字永远是初始值)。
 */
const chipChange = vi.fn()
function Harness() {
  const [chip, setChip] = useState<HostDisplay>('both')
  return <HostsPane hostChip={chip} onHostChipChange={(v) => { chipChange(v); setChip(v) }} />
}
const renderPane = () => render(<Harness />)

const openForm = async () => {
  renderPane()
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
    renderPane()
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

  it('挑了图标就存下去', async () => {
    await openForm()
    type('名称', '云服务器')
    pickIcon('服务器')
    choose('连接方式', '直接连接(局域网 / Tailscale / 本机自测)')
    type('地址', 'ws://1.2.3.4:6767')
    await save()
    expect(hostsUpsert).toHaveBeenCalledWith(expect.objectContaining({ icon: '☁️' }))
  })

  it('★「显示图标还是名称」不再是每台主机自己的事 —— 表单里不该再有那个框', async () => {
    // 它是**那枚按钮**的设置,一份、全局。留在表单里就会出现「同一枚按钮切台主机换副长相」。
    await openForm()
    expect(screen.queryByRole('button', { name: '标题栏上显示' })).toBeNull()
  })
})

describe('★底部那枚主机按钮的显示方式 = 页面级、一份', () => {
  it('挑一项就报上去', async () => {
    renderPane()
    await waitFor(() => expect(screen.getByRole('button', { name: '主机按钮显示' })).toBeTruthy())
    choose('主机按钮显示', '只显示图标')
    expect(chipChange).toHaveBeenCalledWith('icon')
  })

  it('★一台主机都没配也在 —— 它管的是那枚按钮,不是某台主机', async () => {
    // 主机列表为空(beforeEach 的默认),这条设置照样要能改:没配主机时按钮仍然画着。
    hosts = []
    renderPane()
    await waitFor(() => expect(screen.getByRole('button', { name: '主机按钮显示' })).toBeTruthy())
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
    renderPane()
    await waitFor(() => expect(screen.getByText('书房的 Mac')).toBeTruthy())
    expect(screen.getByText('经中转')).toBeTruthy()
    expect(screen.queryByText('直接连接')).toBeNull()
  })

  it('副标题给的是**中转地址**,不是那台机器的局域网地址', async () => {
    // 走中转时拨的是中转;`address` 只是「这台机器以后出现在局域网里时的地址」的一份记录。
    // 把它当成连接目标显示出来,就是在说一件不成立的事 —— 而人正是照着这一行判断
    // 「我到底连的是哪条路」。
    hosts = [relayed]
    renderPane()
    await waitFor(() => expect(screen.getByText('书房的 Mac')).toBeTruthy())
    expect(screen.getByText('wss://relay.example.workers.dev')).toBeTruthy()
    expect(screen.queryByText('ws://192.168.1.20:6789')).toBeNull()
  })

  it('没有中转的照旧 —— 别把普通直连也改了', async () => {
    hosts = [{ ...relayed, relay: '' } as RemoteHostView]
    renderPane()
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
    const btn = screen.getByRole('button', { name: '主机按钮显示' })
    fireEvent.keyDown(btn, { key: 'ArrowDown' })          // 打开
    expect(screen.getAllByRole('option').length).toBe(3)
    fireEvent.keyDown(btn, { key: 'ArrowDown' })          // 移到「只显示图标」
    fireEvent.keyDown(btn, { key: 'Enter' })
    expect(btn.textContent).toContain('只显示图标')
  })

  it('Esc 关掉,并且**不改值**', async () => {
    await openForm()
    const btn = screen.getByRole('button', { name: '主机按钮显示' })
    fireEvent.keyDown(btn, { key: 'ArrowDown' })
    fireEvent.keyDown(btn, { key: 'ArrowDown' })
    fireEvent.keyDown(btn, { key: 'Escape' })
    expect(screen.queryAllByRole('option').length).toBe(0)
    expect(btn.textContent).toContain('图标 + 名称')
  })
})

describe('★★表单里「连接方式」也不许把中转说成直连', () => {
  /**
   * 用户第二次问的是同一件事的上一层:「连接方式 哪有中转啊?」
   *
   * 他去那个框里找是完全对的 —— 到达一台主机就是三条路(SSH 隧道 / 直连 / 中转),而这个框
   * 自称「连接方式」却只列两条。更糟的是:粘完带中转的配对码之后 `kind` 被设成 `direct`,
   * 于是这个框**明明白白显示「直接连接」**。这和列表里那枚标签是同一个错,只是我上一轮
   * 只修了列表那一层。
   */
  const RELAY_LINK =
    'myflowforge://add-host?v=1&a=192.168.1.20%3A6789&t=tok123&n=%E4%B9%A6%E6%88%BF%E7%9A%84Mac' +
    '&k=' + encodeURIComponent('A'.repeat(43) + '=') +
    '&r=' + encodeURIComponent('wss://relay.example.workers.dev')

  const pasteRelayCode = async () => {
    await openForm()
    const box = screen.getByPlaceholderText(/myflowforge:\/\/add-host/)
    fireEvent.change(box, { target: { value: RELAY_LINK } })
    await act(async () => { fireEvent.click(screen.getByText('填进表单')) })
  }

  it('粘完带中转的码:连接方式显示「经中转」+ 中转地址,而不是「直接连接」', async () => {
    await pasteRelayCode()
    expect(screen.getByText(/经中转 · wss:\/\/relay\.example\.workers\.dev/)).toBeTruthy()
    expect(screen.queryByText(/直接连接\(局域网/)).toBeNull()
  })

  it('★这时候它是**只读**的 —— 中转地址和公钥只能从码里来,不给手填', async () => {
    await pasteRelayCode()
    // 那个可点开的下拉框没了(它只在没有中转时出现)
    expect(screen.queryByRole('button', { name: '连接方式' })).toBeNull()
  })

  it('★令牌不许跟着藏掉 —— 走中转那条路**一定要**令牌', async () => {
    // 藏了的话人没法确认它填上没有,而它没填上的现象是「握手之后被 4403 断开」,
    // 界面上只写着「连接失败」。
    await pasteRelayCode()
    const token = screen.getByText('访问令牌').parentElement!.querySelector('input')!
    expect((token as HTMLInputElement).value).toBe('tok123')
  })

  it('地址那一栏改口说清它现在**不是**连接目标', async () => {
    await pasteRelayCode()
    expect(screen.getByText('局域网地址(备用,现在不走它)')).toBeTruthy()
  })

  it('「改用直连」清掉中转,下拉框回来', async () => {
    await pasteRelayCode()
    await act(async () => { fireEvent.click(screen.getByText('改用直连')) })
    expect(screen.getByRole('button', { name: '连接方式' })).toBeTruthy()
  })

  it('★没有中转时,那两个选项旁边要说清「不在一个网络该怎么办」', async () => {
    // 不说的话,人只会在 SSH 和直连之间来回猜 —— 而正确答案是「哪个都不选,去粘配对码」。
    await openForm()
    expect(screen.getByText(/不在同一个网络/)).toBeTruthy()
  })
})
