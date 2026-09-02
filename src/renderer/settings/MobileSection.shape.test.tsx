import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MobileSection } from './MobileSection'

vi.mock('./QrCode', () => ({ QrCode: () => <svg className="qr" /> }))

const RUNNING = {
  running: true, host: '0.0.0.0', port: 6789, token: 'tok-ABC_123',
  addresses: ['192.168.110.133'], clients: 0, error: '', name: '书房的 Mac',
}

const mount = async () => {
  ;(window as unknown as { forge: unknown }).forge = {
    mobileStatus: vi.fn(async () => RUNNING),
    mobileApply: vi.fn(async () => RUNNING),
    mobileRegenToken: vi.fn(async () => RUNNING),
    onMobileStatus: () => () => {},
    relayStatus: vi.fn(async () => ({ enabled: false, url: '', detail: { status: 'off' }, publicKey: '', token: 't' })),
    onRelayStatus: () => () => {},
    relayApply: vi.fn(async () => ({})),
    pushDevices: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({ push: { enabled: false, gate: true, done: false } })),
    setSettings: vi.fn(async () => {}),
  }
  render(<MobileSection />)
  await waitFor(() => expect(screen.getByText('让手机连进来')).toBeTruthy())
}

beforeEach(() => vi.clearAllMocks())

/**
 * ★★2026-09-02 用户原话:「又乱又杂,还有很多文案,都不知道怎么配置了」。
 *  那不是一个能靠「我觉得清爽多了」验收的东西 —— 这一组把它变成能测的:
 *  **默认摊开在人眼前的东西有多少**。没有这组断言,下一次往这一屏塞点什么,
 *  它会悄悄涨回去,而每一次单独看都「只多了一句」。
 */
describe('这一屏默认摆出来多少东西', () => {
  /**
   * ★量**字数**而不是段数:用户抱怨的是「很多文案」,而那是体积不是条目数。
   *  每个开关配一句话是对的密度(手机端的通知屏就是这么排的);十句话里有一句写了三行才是问题。
   * ★这个上限是**照着改完之后的真实值 + 一点余量**定的,不是先拍一个数再去凑。
   *  它防的是「下一次往这儿塞点什么」—— 每次单独看都只多了一句,攒起来就是改之前那样。
   */
  it('★默认摊在眼前的说明文字总量有上限', async () => {
    await mount()
    const open = [...document.querySelectorAll('.set-desc, .set-row .d')].filter((e) => !e.closest('details'))
    const chars = open.reduce((n, e) => n + (e.textContent ?? '').trim().length, 0)
    expect(chars, open.map((e) => e.textContent?.slice(0, 16)).join(' | ')).toBeLessThanOrEqual(320)
  })

  it('★没有哪一段是一大坨 —— 超过 60 字的解释属于折叠里', async () => {
    await mount()
    for (const e of [...document.querySelectorAll('.set-desc, .set-row .d')].filter((e) => !e.closest('details'))) {
      expect((e.textContent ?? '').trim().length, e.textContent?.slice(0, 24)).toBeLessThanOrEqual(60)
    }
  })

  /**
   * ★★2026-09-02:**推送搬去通知页了**,所以这一屏只剩两个开关。
   *  理由:通知页本来就按「跟设备走 / 跟机器走」分组,而且它第二组的说明原文写着
   *  「连着这台机器的所有设备(**包括以后的手机**)都不会再收到该类通知」——
   *  它早就把手机算进去了,而那三个开关却待在主机页。同一件事被拆在两页,
   *  其中一页还在替另一页做承诺。
   */
  it('★这一屏只管「连进来」这件事:两个开关,推送不在这儿', async () => {
    await mount()
    const toggles = [...document.querySelectorAll('button.toggle')].filter((e) => !e.closest('details'))
    expect(toggles.map((e) => e.getAttribute('aria-label'))).toEqual(['让手机连进来', '出门也能连'])
  })

  it('★推送的任何痕迹都不许留在这一屏 —— 留一半比整块留着更难找', async () => {
    await mount()
    const all = document.body.textContent ?? ''
    for (const gone of ['推送', 'Expo', '已登记']) expect(all, gone).not.toContain(gone)
  })

  it('★★「配错了才来动」的那些**全在折叠里**:端口 / 局域网可见 / 令牌 / 手填地址', async () => {
    await mount()
    const adv = document.querySelector('details.hosts-adv')!
    expect(adv).toBeTruthy()
    expect(adv.querySelector('#mobPort'), '端口').toBeTruthy()
    expect(adv.querySelector('#mobAddr'), '手填地址').toBeTruthy()
    expect(adv.querySelector('#mobToken'), '令牌').toBeTruthy()
    expect(adv.querySelector('[aria-label="局域网可见"]'), '局域网可见').toBeTruthy()
    expect(adv.textContent, '换一把令牌').toContain('换一把令牌')
  })

  it('★折叠**默认是收起的** —— 收进去又默认展开等于什么都没做', async () => {
    await mount()
    expect(document.querySelector('details.hosts-adv')?.hasAttribute('open')).toBe(false)
  })

  it('★★收进去的东西一个都没删 —— 端口被占、令牌泄了、相机坏了,那几条路都还得在', async () => {
    await mount()
    const all = document.body.textContent ?? ''
    for (const must of ['端口', '局域网可见', '访问令牌', '换一把令牌']) {
      expect(all, must).toContain(must)
    }
  })

  it('每次都要碰的那两样留在外面:主开关 + 显示配对二维码', async () => {
    await mount()
    const outside = (sel: string) =>
      [...document.querySelectorAll(sel)].some((e) => !e.closest('details'))
    expect(outside('[aria-label="让手机连进来"]')).toBe(true)
    expect(
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent === '显示配对二维码' && !b.closest('details'),
      ),
    ).toBe(true)
  })
})
