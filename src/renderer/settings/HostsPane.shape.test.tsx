import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { HostsPane } from './HostsPane'
import type { HostStatusView, RemoteHostView } from '@shared/remote/hostView'

const LOCAL: HostStatusView = { hostId: null, label: '本机', state: { status: 'local' }, methods: [] }
const HOST: RemoteHostView = {
  id: 'h1', label: '书房', kind: 'direct', address: 'ws://192.168.1.20:6789', sshTarget: '',
  icon: '🖥️', display: 'both', token: '', pubKey: '', relay: '', lastConnectedAt: 0,
} as RemoteHostView

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { forge: unknown }).forge = {
    hostsList: async () => [HOST],
    hostsStatus: async () => LOCAL,
    onHostStatus: () => () => {},
    hostsUpsert: vi.fn(), hostsRemove: vi.fn(), hostsConnect: vi.fn(), hostsDisconnect: vi.fn(),
    hostsExport: async () => '{}', hostsImport: async () => ({ ok: true, added: 1 }),
  }
})

const mount = async () => {
  const r = render(<HostsPane hostChip="both" onHostChipChange={() => {}} />)
  await waitFor(() => expect(r.container.querySelectorAll('.host-row')).toHaveLength(1))
  return r
}
/** 「摊在眼前」= 不在任何 <details> 里的说明文字。折叠里的不算(那是去找才看的)。 */
const openCopy = () => [...document.querySelectorAll('.set-desc, .set-row .d')].filter((e) => !e.closest('details'))

/**
 * ★★和 `MobileSection.shape.test.tsx` 是同一组约束,照搬到这一屏。
 *  用户 2026-09-09 原话:「你的说明文字也非常多,我们到时候会写使用文档的,没必要在 APP 设置里
 *  写这么多文字,一般没人看」。改之前这一屏默认摊开 323 字,其中 78 字是在**解释另一个界面元素**
 *  (底部那枚按钮上的圆点是什么颜色)—— 设置页不该给别处的控件写说明书。
 *  ★没有这组断言,它会一次一句地涨回去,而每一次单独看都「只多了一句」。
 */
describe('远程主机这一屏默认摆出来多少字', () => {
  it('★默认摊在眼前的说明文字总量有上限', async () => {
    await mount()
    const open = openCopy()
    const chars = open.reduce((n, e) => n + (e.textContent ?? '').trim().length, 0)
    expect(chars, open.map((e) => e.textContent?.slice(0, 16)).join(' | ')).toBeLessThanOrEqual(60)
  })

  it('★没有哪一段是一大坨 —— 超过 40 字的解释属于折叠里或者文档里', async () => {
    await mount()
    for (const e of openCopy()) {
      expect((e.textContent ?? '').trim().length, e.textContent?.slice(0, 24)).toBeLessThanOrEqual(40)
    }
  })

  /**
   * ★「配一次就再也不碰」的两件事必须在折叠里。它们不是可删的功能,只是不该挡在
   *  「我要连另一台机器」这条主路上。
   */
  it('按钮显示方式 和 搬清单 都在折叠里,而且折叠默认是收起的', async () => {
    const { container } = await mount()
    const adv = container.querySelector('details.hosts-adv')!
    expect(adv, '这一屏必须有「高级」折叠 —— 和「手机」那一屏同一副骨架').toBeTruthy()
    expect(adv.hasAttribute('open'), '默认收起').toBe(false)
    expect(adv.textContent).toContain('底部那枚主机按钮')
    expect(adv.textContent).toContain('导出(含令牌)')
  })

  /** ★主路上必须留着的:机器列表 + 添加入口。折叠不能把这两样也吞进去。 */
  it('主路上留着的是「已配的机器」和「添加主机」', async () => {
    const { container } = await mount()
    const main = [...container.children].filter((e) => !e.matches('details'))
    const text = main.map((e) => e.textContent ?? '').join('')
    expect(text).toContain('已配的机器')
    expect(text).toContain('添加主机')
  })
})
