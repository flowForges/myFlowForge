import { describe, it, expect, vi, beforeEach } from 'vitest'

// expo-router 会把整个 react-native 拖进来,node 环境跑不了 —— 所以整个 mock 掉。
// 只留下我们真正关心的几个方法,断言「点了之后调的是哪一个、参数是什么」。
// ★用 vi.hoisted 包一层:vi.mock 的工厂函数会被提到文件最顶上先执行,直接引用下面的
//  顶层 const 会撞上 TDZ(`Cannot access 'router' before initialization`)。
const router = vi.hoisted(() => ({
  back: vi.fn(),
  replace: vi.fn(),
  navigate: vi.fn(),
  dismissAll: vi.fn(),
  canGoBack: vi.fn(() => true),
  canDismiss: vi.fn(() => true),
}))
vi.mock('expo-router', () => ({ router }))

import { goBack, goToHosts } from './nav'

beforeEach(() => {
  router.back.mockClear()
  router.replace.mockClear()
  router.navigate.mockClear()
  router.dismissAll.mockClear()
  router.canGoBack.mockReturnValue(true)
  router.canDismiss.mockReturnValue(true)
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
  // ★2026-08-28 tab 化之后 `/hosts` 不再是根栈里的一层,`dismissTo` 找不到目标 ——
  //  改成先 dismissAll 弹掉根栈上压着的 add-host/scan(回到 tabs),再 navigate 到主机那一格。
  it('能弹时先 dismissAll 再 navigate 到 /hosts', () => {
    router.canDismiss.mockReturnValue(true)
    goToHosts()
    expect(router.dismissAll).toHaveBeenCalledTimes(1)
    expect(router.navigate).toHaveBeenCalledWith('/hosts')
    expect(router.back).not.toHaveBeenCalled()
    expect(router.replace).not.toHaveBeenCalled()
  })
  it('canDismiss 是假(深链冷启动,根栈里没有 tabs)时跳过 dismissAll,直接 navigate', () => {
    router.canDismiss.mockReturnValue(false)
    goToHosts()
    expect(router.dismissAll).not.toHaveBeenCalled()
    expect(router.navigate).toHaveBeenCalledWith('/hosts')
  })
})
