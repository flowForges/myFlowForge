/**
 * 连上远程 host 之后,每一刀该由谁接。
 *
 * 分两类:
 * - **client**:永远由**正在显示像素的那台机器**接。外观、宠物、字体、壁纸、app 自身更新、
 *   「用默认程序打开」—— 这些跟设备走(决策 8),连去哪台 host 都不该变。
 * - **host**:跟着当前连的那台机器走。会话、工作区、agent、工作流、git、插件 …… 全在这一类。
 *
 * ★**没列进 CLIENT_ONLY 的一律走 host**,而 `channelRouting.test.ts` 钉死了 host 那边的条数。
 * 新加一个 channel 会让那条断言挂 —— 逼你当场决定它归谁,而不是默默继承一个可能错的默认值。
 */
export const CLIENT_ONLY: ReadonlySet<string> = new Set([
  // 桌面外壳自身
  'app-icon:options',
  'update:check', 'update:get', 'update:start',
  // 调试日志:B 阶段先看本机这份。远程 daemon 的日志留到 D 阶段(那时要能选看哪一端)。
  'app-log:clear', 'app-log:export', 'app-log:get',
  // 外观跟设备(决策 8)
  'appearance:pick-bg-image',
  'fonts:delete', 'fonts:download', 'fonts:list-downloaded',
  'wallpaper:catalog', 'wallpaper:install', 'wallpaper:preview',
  // ★B 阶段设置暂不拆:路由到远程会让你一连过去主题/壁纸/字号全变成那台机器的。
  //   C 阶段(Q1–Q7)再把 host 那一半正式切过去。
  'config:get-settings', 'config:set-settings',
  'config:get-client-settings', 'config:set-client-settings',   // 跟设备那半边,永远本机答
  // 宠物整块是桌面外壳(决策 12:手机不做;Linux 也不需要)
  'pet:pick-image', 'pet:pick-pack', 'pet-pack:growth-install', 'growth:pet-import',
  'petpack:catalog', 'petpack:install', 'petpack:preview',
  'codex-pet:import', 'codex-pet:list', 'codex-pet:pick',
  'codex-market:catalog', 'codex-market:install', 'codex-market:preview',
  // NSFW:授权码是「这个人」的,装出来的内容也落在客户端本地
  'nsfw:bg-exists', 'nsfw:catalog', 'nsfw:gallery', 'nsfw:install-bg',
  'nsfw:install-pet', 'nsfw:preview', 'nsfw:validate',
  // 「打开位置」跟设备,且远程时不成立(Q5:编辑器在你手上这台,路径在那台)
  'openers:detect', 'openers:open',
  // 「用默认程序打开」「在访达里显示」「开浏览器」—— 永远在有人看着屏幕的那台执行
  'file:open-path', 'shell:open-external', 'shell:reveal-path',
  // 聊天附件选的是**客户端**上的文件(手机上该是相册)
  'dialog:open-files',
  // 落盘永远在客户端:保存对话框要弹在有人看着的那块屏幕上(内容由 host 出,见 router.ts)
  'client:save-file',
])

/**
 * daemon(无头)**不提供**的方法。客户端拿到 ready.methods 后据此把对应入口置灰(决策 B-2)。
 *
 * 这三个都是「在 host 上定位一个已存在的目录/可执行文件」,需要一个服务端目录选择器 ——
 * 那是 D 阶段的事。B 阶段与其让用户点了没反应,不如**明确置灰并说明原因**。
 */
export const DAEMON_UNSUPPORTED: ReadonlySet<string> = new Set([
  // 这两个本质就是「弹一个系统对话框」,无头机器上不存在这回事。远程时客户端改用服务端目录
  // 选择器(fs:browse)选好路径,再走带路径的入口 —— 所以 workspaces:open-dir 不再列在这里:
  // 它现在接受一个显式路径,无头机器上照样能用。
  'dialog:pick-directory',
  'dialog:pick-file',
])

import type { MethodTable } from './invokeCtx'

/**
 * daemon 对外提供的那张表:剔掉「跟设备走」的,再剔掉无头环境做不了的。
 *
 * 剔掉而不是「留着但会失败」是有意的 —— 这张表的 key 就是握手时发给客户端的方法清单,
 * 客户端据此置灰(决策 B-2)。**一个说明了原因的灰按钮,好过一个点了没反应的亮按钮。**
 */
export function daemonTable(table: MethodTable): MethodTable {
  const out: MethodTable = {}
  for (const [ch, fn] of Object.entries(table)) {
    if (CLIENT_ONLY.has(ch) || DAEMON_UNSUPPORTED.has(ch)) continue
    out[ch] = fn
  }
  return out
}

export type Route = 'client' | 'host'

export const routeOf = (channel: string): Route => (CLIENT_ONLY.has(channel) ? 'client' : 'host')

/**
 * 广播事件里,**永远来自本机**的那几条。
 *
 * 连着远程 host 时,界面只该看到那台机器的内容(决策 2)—— 本机 agent 还在跑,它的
 * `chat:event` 要是漏进界面,你会看到一条不属于当前 host 的回复凭空冒出来,而且完全
 * 无从判断它是哪儿来的。所以:**本机事件默认丢弃,只有这张表里的放行。**
 *
 * 判断标准是「这条事件描述的是这台设备本身,还是那台机器上的活」:
 * 调试日志、菜单、快捷键、app 自身更新、设置(B 阶段设置跟设备)—— 是前者。
 */
export const CLIENT_EVENT_CHANNELS: ReadonlySet<string> = new Set([
  'app-log:event',
  'menu:action',
  'settings:changed',
  'shortcuts:status',
  'update:done', 'update:error', 'update:progress',
])

export const isClientEvent = (channel: string): boolean => CLIENT_EVENT_CHANNELS.has(channel)
