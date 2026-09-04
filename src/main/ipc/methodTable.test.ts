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
    // 187 → 192:推送(第三期收尾)加了五个 —— push:register / unregister / devices / presence / test。
    //   ★它们全走 host:调用方是手机,要把令牌登记到**那台机器**上,并由那台机器发推送。
    // 192 → 196:终端搬进方法表 —— term:create / write / resize / kill。
    //   ★以前它们是 `src/main/index.ts` 里直接 ipcMain 注册的,**不在表里** ⇒ 连着远程主机时
    //   开出来的是本机的 shell。这四条全走 host:shell 长在那台机器上。
    //   注册点在 `terminal/terminalService.ts`,不是 handlers.ts 里的 `on(CH.…)`,所以上面
    //   那个 grep 加数不包含它们:196 = 165 + 22 + 5(push,同样不在 grep 里)+ 4。
    // 196 → 197:`chat:tool-output` —— 历史里大于 1KB 的工具输出不再下发,点开那张卡才来取这一条
    //   (见 chat/toolOutputCap.ts:实测最大会话 389KB → 67KB)。它读的是**主机上**的会话文件,
    //   所以是 host 方法,跟着 CLIENT_ONLY 之外那一半走。
    // 197 → 200:手机端工作流编辑器 —— workflow:stage-catalog / workspace:save-workflow /
    //   workspace:delete-workflow。改的是**主机上**那个工作区的 workspace.json,三条全走 host。
    // 另外两处计数互为佐证:200 = 45(CLIENT_ONLY)+ 155(host),daemonTable = 200 - 45 - 2。
    expect(Object.keys(table).length).toBe(200)
  })
})
