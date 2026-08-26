import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MobileSection } from './MobileSection'
import { parsePairingLink } from '@shared/remote/pairingLink'

const RUNNING = {
  running: true, host: '0.0.0.0', port: 6789, token: 'tok-ABC_123',
  addresses: ['192.168.110.133', '10.211.55.2'], clients: 0, error: '', name: '书房的 Mac',
}

const mount = async (status: unknown) => {
  ;(window as unknown as { forge: unknown }).forge = {
    mobileStatus: vi.fn(async () => status),
    mobileApply: vi.fn(async () => status),
    mobileRegenToken: vi.fn(async () => status),
    onMobileStatus: () => () => {},
  }
  render(<MobileSection />)
  await waitFor(() => expect(screen.getByText('让手机连进来')).toBeTruthy())
}

beforeEach(() => vi.clearAllMocks())

describe('配对二维码', () => {
  it('★默认不画 —— 码里带着令牌,不能替人在共享屏幕上把钥匙亮出来', async () => {
    await mount(RUNNING)
    expect(document.querySelector('svg.qr')).toBeNull()
    expect(screen.getByText('显示配对二维码')).toBeTruthy()
  })

  it('点开之后画出来的码,解回来就是地址 + 令牌 + 机器名', async () => {
    await mount(RUNNING)
    await act(async () => { fireEvent.click(screen.getByText('显示配对二维码')) })

    const svg = document.querySelector('svg.qr')
    expect(svg).toBeTruthy()
    // 码的内容不能从像素里读回来,但 aria-label 是同一份数据算出来的,能钉住「画的是这台机器」。
    expect(svg?.getAttribute('aria-label')).toBe('配对二维码 · 192.168.110.133:6789')
    // 真正的往返在 pairingLink.test.ts 里钉;这里只确认这一屏喂进去的是**第一个**地址
    // (虚拟网卡 10.211.55.x 是 Parallels 的,手机永远连不上那个)。
    const r = parsePairingLink(
      `myflowforge://add-host?v=1&a=${encodeURIComponent('192.168.110.133:6789')}&t=tok-ABC_123&n=${encodeURIComponent('书房的 Mac')}`,
    )
    expect(r.ok && r.value).toEqual({ address: '192.168.110.133:6789', token: 'tok-ABC_123', label: '书房的 Mac' })
  })

  it('能收回去', async () => {
    await mount(RUNNING)
    await act(async () => { fireEvent.click(screen.getByText('显示配对二维码')) })
    await act(async () => { fireEvent.click(screen.getByText('收起二维码')) })
    expect(document.querySelector('svg.qr')).toBeNull()
  })

  it('★连着一台跑旧版本的主机(status 里没有 name)不能把整屏炸成白板', async () => {
    const { name: _drop, ...old } = RUNNING
    await mount(old)
    await act(async () => { fireEvent.click(screen.getByText('显示配对二维码')) })
    expect(document.querySelector('svg.qr')).toBeTruthy()
    expect(screen.getByText('让手机连进来')).toBeTruthy()
  })

  it('网关没开着就没有码可扫', async () => {
    await mount({ ...RUNNING, running: false })
    expect(screen.queryByText('显示配对二维码')).toBeNull()
  })
})

describe('「我手机连上没有」', () => {
  it('★答案在开关旁边,不在二维码底下 —— 而且是**没展开二维码时**就看得见', async () => {
    await mount({ ...RUNNING, clients: 1 })
    // 二维码还折着
    expect(document.querySelector('svg.qr')).toBeNull()
    const live = document.querySelector('.hosts-live')!
    expect(live.textContent).toContain('现在连着')
    expect(live.textContent).toContain('1')
    expect(live.className).toContain('on')
  })

  it('没有设备连着时说的是「在哪个地址上等着」,不是干巴巴一个 0', async () => {
    await mount({ ...RUNNING, clients: 0 })
    const live = document.querySelector('.hosts-live')!
    expect(live.textContent).toContain('192.168.110.133:6789')
    expect(live.textContent).toContain('还没有设备连上来')
    expect(live.className).not.toContain('on')
  })

  it('网关关着就没有这条 —— 关着的时候「0 台设备」是废话', async () => {
    await mount({ ...RUNNING, running: false })
    expect(document.querySelector('.hosts-live')).toBeNull()
  })
})
