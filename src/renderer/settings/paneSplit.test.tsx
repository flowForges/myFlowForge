import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8')

/**
 * ★★2026-09-02 用户原话:「要分开,一部分是本机 daemon 启动然后让手机去连,还有一部分是本机去连
 *  其他的 daemon……这部分要分开,不然看起来很乱」。已经拆成两页了(`PhonePane` / `HostsPane`)。
 *
 *  这一组钉的是**拆完之后别再长回去**。它查的是源码而不是渲染结果 —— 因为「又混回一页」不会
 *  让任何行为断掉:两边都照常工作,只是又变回一页里两件不相干的事,而那正是没人会当 bug 报的那种退化。
 */
describe('主机设置拆成两页之后,别再混回去', () => {
  it('★「手机」页只管连进来:不碰远程主机清单(hostsConnect / hostsRemove / hostsExport)', () => {
    const src = read('PhonePane.tsx')
    for (const api of ['hostsConnect', 'hostsRemove', 'hostsExport', 'hostsImport', 'hostsAdd']) {
      expect(src, api).not.toContain(api)
    }
  })

  it('★「远程主机」页只管连出去:不碰网关 / 中转 / 配对码', () => {
    const src = read('HostsPane.tsx')
    for (const api of ['MobileSection', 'mobileApply', 'relayApply', 'buildPairingLink', 'QrCode']) {
      expect(src, api).not.toContain(api)
    }
  })

  /**
   * ★★推送搬去「通知」了。留在手机页里的任何一半都比整块留着更难找 ——
   *  人会在两页之间来回找那个开关,而两页看起来都「应该有」。
   */
  it('★推送整块在通知页,手机页里一点痕迹都没有', () => {
    const phone = read('PhonePane.tsx') + read('MobileSection.tsx')
    for (const api of ['pushDevices', 'PushDevice', 'iosPush']) {
      expect(phone, api).not.toContain(api)
    }
    const notif = read('NotificationsPane.tsx')
    for (const api of ['pushDevices', 'PushDevice']) {
      expect(notif, api).toContain(api)
    }
  })

  /**
   * ★★这条是 dump 结构时抓到的:推送那一块搬过来时**没有自己的 `<h4>`**,
   *  于是它浮在「跟机器走」和「窗口」两个标题之间 —— 界面上会读成上一组的一部分,
   *  而那一组管的是「这台机器上哪类事件值得通知」,完全是另一件事。
   *  ★分组头是这一页唯一的结构信号(同手机端设置屏那条),一块没有头的控件等于挂在了上一个头底下。
   */
  it('★推送在通知页里是**自己一组**,不是挂在上一组底下', () => {
    const src = read('NotificationsPane.tsx')
    expect(src).toContain('手机收哪些')
    // 「跟设备走 / 跟机器走 / 跟那台手机走」——三格轴,缺一格就会有控件无家可归。
    for (const h of ['跟设备走', '跟机器走', '跟那台手机走']) expect(src, h).toContain(h)
  })

  it('★两页都在设置导航里,而且「主机」那个词不再同时指两个方向', () => {
    const nav = read('SettingsModal.tsx')
    expect(nav).toContain("key: 'phone'")
    expect(nav).toContain("label: '手机'")
    // 「主机」→「远程主机」:光叫「主机」的时候,它同时是「我这台」和「别人那台」。
    expect(nav).toContain("label: '远程主机'")
  })

  it('★★两页都真的接线了 —— 注册了 key 却没在 App 里分发,点进去是一片空白', () => {
    const app = read('../App.tsx')
    expect(app).toContain("case 'phone':")
    expect(app).toContain("case 'hosts':")
  })
})
