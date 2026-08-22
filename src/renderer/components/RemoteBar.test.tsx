import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { RemoteBar } from './RemoteBar'
import type { HostStatusView } from '@shared/remote/hostView'

const listeners: ((s: HostStatusView) => void)[] = []
const LOCAL: HostStatusView = { hostId: null, label: '本机', state: { status: 'local' }, methods: [] }

beforeEach(() => {
  listeners.length = 0
  ;(window as unknown as { forge: unknown }).forge = {
    hostsStatus: vi.fn(async () => LOCAL),
    onHostStatus: (cb: (s: HostStatusView) => void) => { listeners.push(cb); return () => {} },
    hostsDisconnect: vi.fn(async () => LOCAL),
  }
})

const push = async (s: HostStatusView) => { await act(async () => { listeners.forEach((l) => l(s)) }) }

describe('RemoteBar', () => {
  it('★本机状态下什么都不渲染 —— 不连远程的人界面完全不变', async () => {
    const { container } = render(<RemoteBar onOpenHosts={() => {}} />)
    await act(async () => {})
    expect(container.innerHTML).toBe('')
  })

  it('连上远程后显示主机名和状态', async () => {
    render(<RemoteBar onOpenHosts={() => {}} />)
    await push({ hostId: 'h1', label: '云服务器', state: { status: 'ready', version: '1.1.2', methods: [] }, methods: [] })
    expect(screen.getByText('云服务器')).toBeInTheDocument()
    expect(screen.getByText(/已连接/)).toBeInTheDocument()
  })

  it('★断线时条子变成警示态并说明情况,不许静悄悄', async () => {
    const { container } = render(<RemoteBar onOpenHosts={() => {}} />)
    await push({ hostId: 'h1', label: '云服务器', state: { status: 'retrying', attempt: 1, error: '连接断开(1006)', nextInMs: 2000 }, methods: [] })
    expect(container.querySelector('.remote-bar.bad')).toBeTruthy()
    expect(screen.getByText(/已断开/)).toBeInTheDocument()
  })

  it('切回本机后条子消失', async () => {
    const { container } = render(<RemoteBar onOpenHosts={() => {}} />)
    await push({ hostId: 'h1', label: '云服务器', state: { status: 'ready', version: '1.1.2', methods: [] }, methods: [] })
    expect(container.querySelector('.remote-bar')).toBeTruthy()
    await push(LOCAL)
    expect(container.innerHTML).toBe('')
  })
})
