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
    // 165(handlers.ts 里的 `on(CH.x, …)`,`grep -c 'on(CH\.' src/main/ipc/handlers.ts`)
    // + 22(run2Handlers.ts 里的 `onInvoke(CH.x, …)`,经注入写进同一张表)= 187。
    // ★这两个数是数出来的,不是抄文档的:`grep -c 'ipcMain\.handle'`(不带括号)会把两行提到它的
    // 注释、以及 run2 那行注入本身也算进去 —— 文档里那些对不上的计数就是这么来的。
    // ★这行加数以前写的是 162+22(=184),对不上断言里的 186:那是历史上加 channel 时只改了总数、
    // 没跟着改分解,已按今日实测重新数过。改这个数就要在 commit message 里说清楚加/删了哪个 channel。
    // 186 → 187:手机端二期的跨设备未读加了 `chat:mark-seen`(`chat:seen` 是纯广播,没有 handler,不进表)。
    // 另外两处计数互为佐证:187 = 45(CLIENT_ONLY)+ 142(host),daemonTable = 187 - 45 - 2。
    expect(Object.keys(table).length).toBe(187)
  })
})
