import { describe, it, expect, vi } from 'vitest'

// registerIpc 目前仍会 import electron 的 dialog/app/shell(Task 3 才拆),所以这里照 handlers.update.test.ts
// 的前置给一份最小假 electron。ipcMain 这一项是给**重构前**的 registerIpc 用的:没有它,函数会在
// 第一次 ipcMain.handle 上就抛,红就红在「mock 不全」而不是「没有返回方法表」上,那种红不算数。
vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  dialog: {},
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp' },
  shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
}))
// 更新检查器在 registerIpc 里就被造出来,别让它去够真的 GitHub。
vi.mock('../update/githubSource', () => ({
  fetchLatestRelease: async () => ({ version: '2.4.0', notes: 'n', assetUrl: 'u', assetSize: 6, assetName: 'a.dmg' }),
}))

import { registerIpc } from './handlers'
import { CH } from './channels'
import { fakeHost } from '../host/fakeHost'

describe('方法表', () => {
  it('registerIpc 返回一张纯对象方法表,而不是往 ipcMain 上挂', () => {
    const table = registerIpc(() => {}, {}, fakeHost())
    expect(typeof table).toBe('object')
    expect(Object.getPrototypeOf(table)).toBe(Object.prototype)
    expect(typeof table[CH.configGetSettings]).toBe('function')
  })

  it('每个 key 都是 channels.ts 里声明过的常量 —— 防止手滑写错字符串', () => {
    const table = registerIpc(() => {}, {}, fakeHost())
    const known = new Set<string>(Object.values(CH))
    expect(Object.keys(table).filter((k) => !known.has(k))).toEqual([])
  })

  it('表里方法数与今日实测一致 —— 少一个就是搬运时漏了', () => {
    const table = registerIpc(() => {}, {}, fakeHost())
    // 162(handlers.ts 里的 on(CH.x, …);C 加了设置两个半边的 4 个,D 加了目录浏览的 2 个)
    // + 22(run2Handlers.ts,经注入的 onInvoke 写进同一张表)。
    // ★这两个数是数出来的,不是抄文档的:`grep -c 'ipcMain\.handle'`(不带括号)会把两行提到它的
    // 注释、以及 run2 那行注入本身也算进去,于是得到 159 —— 文档里那些偏大的计数就是这么来的。
    // 改这个数就要在 commit message 里说清楚加/删了哪个 channel。
    expect(Object.keys(table).length).toBe(184)
  })
})
