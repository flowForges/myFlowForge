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
    fireEvent.change(screen.getByText('连接方式').parentElement!.querySelector('select')!, { target: { value: 'direct' } })
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
    fireEvent.change(screen.getByText('连接方式').parentElement!.querySelector('select')!, { target: { value: 'direct' } })
    type('地址', '')
    await save()
    expect(screen.getByText(/地址不能为空/)).toBeInTheDocument()
  })

  it('填全了就真的存下去', async () => {
    await openForm()
    type('名称', '本机 daemon')
    fireEvent.change(screen.getByText('连接方式').parentElement!.querySelector('select')!, { target: { value: 'direct' } })
    type('地址', 'ws://127.0.0.1:6789')
    await save()
    expect(hostsUpsert).toHaveBeenCalledWith(expect.objectContaining({ label: '本机 daemon', kind: 'direct', address: 'ws://127.0.0.1:6789', display: 'both' }))
  })

  it('★不带 ws:// 的地址自动补上 —— 很多人就是直接写 127.0.0.1:6789', async () => {
    // 不补的话 new WebSocket('127.0.0.1:6789') 当场抛,错误信息还跟「地址写法」毫无关系。
    await openForm()
    type('名称', 'x')
    fireEvent.change(screen.getByText('连接方式').parentElement!.querySelector('select')!, { target: { value: 'direct' } })
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
    fireEvent.change(screen.getByText('连接方式').parentElement!.querySelector('select')!, { target: { value: 'direct' } })
    type('地址', 'ws://127.0.0.1:1')
    await save()
    expect(hostsUpsert).toHaveBeenCalledWith(expect.objectContaining({ icon: '' }))
  })

  it('填了标识和显示方式就存下去', async () => {
    await openForm()
    type('名称', '云服务器')
    type('标识(一个表情)', '🌩')
    fireEvent.change(screen.getByText('标题栏上显示').parentElement!.querySelector('select')!, { target: { value: 'icon' } })
    fireEvent.change(screen.getByText('连接方式').parentElement!.querySelector('select')!, { target: { value: 'direct' } })
    type('地址', 'ws://1.2.3.4:6767')
    await save()
    expect(hostsUpsert).toHaveBeenCalledWith(expect.objectContaining({ icon: '🌩', display: 'icon' }))
  })
})
