/**
 * 「这条通知刚刚是不是已经处理过了」。**零 import** —— 和 `tapTarget.ts` 一样,
 * 这样它能被 `mobile` 那套 vitest(environment: 'node')收进去。
 *
 * ★★为什么需要它(2026-10-06 用户在 iOS 上撞到的无限跳转):
 *  `getLastNotificationResponseAsync()` 给的是**最后一次**点击,而且它一直留着 ——
 *  每次重新订阅都会把同一条再播一遍。配上一个会重新订阅的 effect,就是一个闭环:
 *  跳转 → 改 store → effect 重订阅 → 重播同一条 → 再跳转……用户看到的是连跳十几次,
 *  而每跳一次都把正在加载的会话打断,于是「正在读这个会话」永远读不完。
 *  订阅那边要修(别因为改了 store 就重订阅),但这里也必须挡一道:
 *  只修订阅的话,任何一次真实的重新挂载(冷启动、app 重启)仍然会重复跳。
 *
 * ★认不出 id 时**放行**:挡错了就是「点了通知没反应」,那比多跳一次糟得多。
 */
export function makeTapGate(limit = 32): (id: string | undefined | null) => boolean {
  // 顺序表:新的往后加,超了从前面丢。通知量很小,数组够用,不值得上 Set + 队列两份结构。
  const seen: string[] = []
  return (id) => {
    if (!id) return true
    if (seen.includes(id)) return false
    seen.push(id)
    if (seen.length > limit) seen.shift()
    return true
  }
}
