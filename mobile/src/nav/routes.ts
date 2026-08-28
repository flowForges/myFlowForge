/**
 * 全 app **唯一**的路由字符串来源。
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
  /** 主机。tab ②。★2026-08-28 从「设置 → 主机」整块挪出来的。 */
  hosts: '/hosts',
  /** 设置。tab ③。 */
  settings: '/settings',

  // ── 以下都是从某一格**推出去**的次级屏(在根栈里,盖在 tab bar 上面) ──
  chat: '/chat',
  exec: '/exec',
  workflow: '/workflow',
  gate: '/gate',
  newWorkspace: '/new-workspace',
  addHost: '/add-host',
  scan: '/scan',
  host: '/host',
  archived: '/archived',
  about: '/about',
} as const
