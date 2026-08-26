/**
 * 「现在该不该告诉主机『这条会话我看过了』?」—— 跨设备未读的上报闸门。
 *
 * ★这个文件刻意**不 import 任何东西**(和 sessionStatus.ts / autoScroll.ts 同一套纪律)。
 *  真正的判断本来内联在 `useUnread.ts` 里,而那个 hook 依赖 `useConn()` → 一路 import 到
 *  react-native,vitest 的 mobile project 是 node 环境,渲染不了 —— 于是这三条判断
 *  (最要紧的那条查方法表)一行覆盖都没有。抽成纯函数就能单测,hook 那边只剩接线。
 */
export function shouldReportSeen(
  viewing: { wsPath: string; sessionId: string } | null,
  methods: ReadonlySet<string>,
  channel: string,
): boolean {
  // 没在看任何会话(首页 / 还没连上)。
  if (!viewing) return false
  // ★空 id 是真会出现的,不是防御性编程:切主机那一瞬客户端的 viewing 就是两个空串。
  //  照发的话每台设备都会拿一个空 key 去 clearUnread —— 无害,但是一条纯噪音广播。
  if (!viewing.wsPath || !viewing.sessionId) return false
  // ★决策 B-2:对不上的能力**跳过**,不要点了报一句看不懂的错。
  //  老主机(二期以前的 daemon / 旧版 app 的网关)方法表里没有 `chat:mark-seen`,
  //  不查就发的话,每打开一条会话都会多一个被拒的 promise —— 功能上无害,但那是一条
  //  会一直刷屏的假错误。查不到就退化成一期行为(两端各看各的未读),不出错。
  //  注意 `methods` 只在连接 ready 时才非空,所以「还没连上」在这里也自动是 false。
  return methods.has(channel)
}
