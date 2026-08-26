import { describe, it, expect, vi, beforeEach } from 'vitest'

// expo-router 会把整个 react-native 拖进来,node 环境跑不了 —— 所以整个 mock 掉。
// 只留下我们真正关心的三个方法,断言「点了之后调的是哪一个、参数是什么」。
// ★用 vi.hoisted 包一层:vi.mock 的工厂函数会被提到文件最顶上先执行,直接引用下面的
//  顶层 const 会撞上 TDZ(`Cannot access 'router' before initialization`)。
const router = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), canGoBack: vi.fn(() => true) }))
vi.mock('expo-router', () => ({ router }))

import { goBack, goToHosts } from './nav'

beforeEach(() => {
  router.back.mockClear(); router.replace.mockClear()
  router.dismissTo.mockClear(); router.canGoBack.mockReturnValue(true)
})

describe('goBack', () => {
  it('有返回栈就退一层', () => {
    goBack()
    expect(router.back).toHaveBeenCalledTimes(1)
    expect(router.replace).not.toHaveBeenCalled()
  })
  it('★没有返回栈时退回根视图,而不是静默什么都不做', () => {
    router.canGoBack.mockReturnValue(false)
    goBack()
    expect(router.back).not.toHaveBeenCalled()
    expect(router.replace).toHaveBeenCalledWith('/')
  })
})

describe('goToHosts', () => {
  // ★为什么不是 goBack():扫码那条路会在栈里留下两个 /add-host(Scanner 把自己 replace 成了
  //  第二个),goBack() 弹掉带参那个之后落回下面那个空的 —— 真机上报的「加完停在空白页」。
  //  dismissTo 一路弹到已有的 /hosts;栈里没有 /hosts(深链冷启动)时它退化成 replace。
  it('回主机列表用 dismissTo,不用 back / 不用 push', () => {
    goToHosts()
    expect(router.dismissTo).toHaveBeenCalledWith('/hosts')
    expect(router.back).not.toHaveBeenCalled()
    expect(router.replace).not.toHaveBeenCalled()
  })
  it('canGoBack 是假(深链冷启动)时也一样走 dismissTo —— 它自己会退化成 replace', () => {
    router.canGoBack.mockReturnValue(false)
    goToHosts()
    expect(router.dismissTo).toHaveBeenCalledWith('/hosts')
  })
})
