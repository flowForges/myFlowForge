/**
 * 全 app 路由字符串的**唯一来源**。
 *
 * ★这句话一度是假的:仓库里同时散着十几处字面量(`router.push('/hosts')` 这种),
 *  `(tabs)/index.tsx` 里「新建工作区」那颗按钮甚至两种写法并存。2026-09-02 全部迁完 ——
 *  `router.push/replace/navigate` 现在一律走这张表,`routes.test.ts` 里有一条**扫全仓**的
 *  断言钉着它,再混进一个字面量就会红。
 *
 * ★为什么要有它:2026-08-28 加底部 tab bar 时,首页/主机/设置三屏搬进了 `app/(tabs)/`。
 *  expo-router 的圆括号目录是**分组**,不进 URL —— 所以路由字符串其实没变。
 *  但「没变」这件事全靠这一条知识,而它原来散在 `nav.ts` 和十几个 `router.push('...')` 里。
 *  写错了**不会报错**:`router.replace('/(tabs)/index')` 只是静默什么也不做。
 *  `goBack()` 的兜底正是靠它 —— 症状是「没有返回栈时点返回,屏幕一动不动」,
 *  而那个函数当初就是为了修这个才写的。
 *
 * ★零 import,能在 node 那套 vitest 里被直接测。
 */
export const ROUTES = {
  /** 会话列表。tab ①,也是冷启动落点。 */
  home: '/',
  /**
   * 工作区。tab ②。★★2026-09-02 顶替了原来的「主机」那一格 —— 主机是配一次的东西,
   * 工作区是每天都在动的东西(新建/置顶/改名/归档/已归档,原来散在三处)。
   */
  workspaces: '/workspaces',
  /** 设置。tab ③。 */
  settings: '/settings',

  // ── 以下都是从某一格**推出去**的次级屏(在根栈里,盖在 tab bar 上面) ──
  /**
   * 主机。★★2026-09-02 从底部第二格**退回次级屏**(设置 → 主机)。理由见 `(tabs)/_layout.tsx`。
   * 这也让 2026-08-28「设置里不许再有通往主机的入口」那条作废 —— 当时搬出去是因为设置屏太长。
   */
  hosts: '/hosts',
  chat: '/chat',
  exec: '/exec',
  workflow: '/workflow',
  /**
   * 改工作流本身(新建 / 加删阶段 / 换代理)。★和 `workflow`(启动屏,只改这一次)是两件事,
   * 别把两个名字看成一个屏 —— 一个跑完就没了,一个存回主机、以后每次都这么跑。
   */
  flowEdit: '/flow-edit',
  gate: '/gate',
  newWorkspace: '/new-workspace',
  addHost: '/add-host',
  scan: '/scan',
  host: '/host',
  archived: '/archived',
  /**
   * 通知。★2026-08-31 从设置屏里整组搬出来的 —— 它是四个开关 + 三段解释,
   * 摊在设置那一列里会把整屏变成「通知设置屏,附带几个别的」。
   */
  notifications: '/notifications',
  about: '/about',
} as const
