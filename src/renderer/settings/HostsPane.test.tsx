import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { HostsPane, normalizeAddress } from './HostsPane'
import type { HostStatusView, RemoteHostView } from '@shared/remote/hostView'

const LOCAL: HostStatusView = { hostId: null, label: '本机', state: { status: 'local' }, methods: [] }
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
    expect(hostsUpsert).toHaveBeenCalledWith(expect.objectContaining({ label: '本机 daemon', kind: 'direct', address: 'ws://127.0.0.1:6789' }))
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
