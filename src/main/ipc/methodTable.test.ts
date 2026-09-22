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
    // 200 → 206:MCP 面板六条(mcp:overview / login-start / login-paste / login-wait /
    //   login-cancel / logout)。MCP 服务器配在**主机**上、凭据也落在主机上,所以全是 host 方法。
    // 206 → 207:加载项重做 —— 加了 addons:scan / addons:remove(+2),删了 skills:list(-1)。
    //   `skills:list` 的唯一使用者是设置里的「Skill」页,而那一页已经并进「加载项」了
    //   (用户原话:「加载项里好像有 skill,所以 skill 是不是多余?」)。
    // 207 → 210:技能 / 插件市场三条(cli-plugins:list / install / uninstall)。装的是**主机上**
    //   那个 CLI 的插件,所以是 host 方法。
    // 另外两处计数互为佐证:210 = 45(CLIENT_ONLY)+ 165(host),daemonTable = 210 - 45 - 2。
    // 210 → 211:workspace:add-workflow-from-template —— 把一条全局模板物化进已建好的工作区
    //   (2026-09-09;以前只有新建向导能做这件事,两端都缺这条路)。
    // 211 → 212:net:check-app-exit-ip —— 「应用自身的网络」那条代理的出口检测(2026-09-11)。
    //   和 net:check-exit-ip 分成两条,是因为路由按 channel 分两端:agent 的出口在主机上测,
    //   app 自己的出口只能在这台设备上测。
    // ★2026-09-14 一度加过 chat:compact(手动压缩上下文),又撤掉了:codex 的协议路径在实验室
    //   跑得通、到用户机器上就是不成,而一个时灵时不灵的按钮比没有更糟。所以这里仍是 212。
    // 212 → 214:gate:list / gate:resolve(门总线)。★无头 daemon 上**必须**有这两个 ——
    //   建区 Hook 在那台机器上等门时,能回答它的只有连过去的客户端。
    // 214 → 215:update:apply(下载完之后选「空闲就装 / 等跑完 / 直接中断」)。
    expect(Object.keys(table).length).toBe(215)
  })
})
