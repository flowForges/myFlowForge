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
])

/**
 * daemon(无头)**不提供**的方法。客户端拿到 ready.methods 后据此把对应入口置灰(决策 B-2)。
 *
 * 这三个都是「在 host 上定位一个已存在的目录/可执行文件」,需要一个服务端目录选择器 ——
 * 那是 D 阶段的事。B 阶段与其让用户点了没反应,不如**明确置灰并说明原因**。
 */
export const DAEMON_UNSUPPORTED: ReadonlySet<string> = new Set([
  'dialog:pick-directory',
  'dialog:pick-file',
  'workspaces:open-dir',
])

export type Route = 'client' | 'host'

export const routeOf = (channel: string): Route => (CLIENT_ONLY.has(channel) ? 'client' : 'host')
