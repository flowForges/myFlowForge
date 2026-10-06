/**
 * 一台远程主机同时有局域网和中转两条路时,「此刻该走哪条」。**零依赖** —— 桌面主进程和手机端
 * 都直接引这一份,判断只写一遍(两条路同一件事两种行为,是这个项目里最贵的那类 bug)。
 *
 * ★★为什么要有它(2026-10-07):配对码里本来两条都带(`a=` 局域网、`r=` 中转,见 pairingLink.ts),
 *  但两端的客户端都是 `relayUrl || url` —— 有中转就**无条件**走中转。人在家里,局域网明明快得多,
 *  却一直绕公网;出门回来想换回局域网只能手动切。用户要的是:在家自动局域网,出门自动中转,
 *  回家自动迁回去,全程无感。
 *
 * ★探测的开销是刻意压到最低的(用户专门问过耗不耗电、耗不耗流量):
 *  · 已经在局域网上 → **一次都不探**;
 *  · 在后台 → 不探(iOS 后台本来就会把连接收掉);
 *  · 只有「前台 + 正走中转」才探,至多每 60 秒一次,一次就是一个连接尝试;
 *  · 刚回到前台时立刻探一次(出门回来那一刻最可能迁回去),但冷却期内照样不探。
 */

export type Route = 'lan' | 'relay'

/** 建连时局域网最多等多久。在外网连 192.168.x.x 常常是**挂着**而不是被拒,不设上限要等几十秒。 */
export const LAN_CONNECT_BUDGET_MS = 1500
/** 后台探测局域网时的上限。没人在等它,可以比建连宽松,免得慢一点的 Wi-Fi 永远迁不回来。 */
export const LAN_PROBE_BUDGET_MS = 3000
/** 走中转时多久探一次局域网。 */
export const LAN_PROBE_INTERVAL_MS = 60_000
/** 迁到局域网后这么短时间内就断 = 信号边缘,不是出门。 */
export const LAN_FLAP_WINDOW_MS = 60_000
/** 信号边缘时局域网的冷却期。没有它就会在两条路之间来回横跳,每跳一次都是一次重连。 */
export const LAN_COOLDOWN_MS = 5 * 60_000

/** 一台主机在这个进程里的选路记忆。只在内存里:冷却是「此刻这个网络环境」的事,不该跨重启。 */
export type RouteMemory = { cooldownUntil: number; lastProbeAt: number; lanSince: number | null }

export const freshMemory = (): RouteMemory => ({ cooldownUntil: 0, lastProbeAt: 0, lanSince: null })

/**
 * 这台主机有哪几条路,按先后。
 * @param lanUsable 码里的局域网地址是不是真的地址。分享时一个局域网地址都没有,码里填的是回环
 *                  (MobileSection.tsx 的 `qrAddr`)—— 那不是一条路,手机去连它等于连自己。
 */
export function routesFor(h: { lanUsable: boolean; relay?: string; pubKey?: string }): Route[] {
  const relay = !!h.relay?.trim()
  if (!relay) return ['lan']
  // ★有中转却没有公钥是配置错误。照旧只给中转,让客户端那一层报出「请重新生成配对码」——
  //  绝不在这里悄悄降级成明文直连。
  if (!h.pubKey?.trim()) return ['relay']
  return h.lanUsable ? ['lan', 'relay'] : ['relay']
}

/** 建连时先拨哪条。冷却期内跳过局域网,不白等那 1.5 秒。 */
export function firstRoute(routes: readonly Route[], m: RouteMemory, now: number): Route {
  if (routes.length > 1 && routes[0] === 'lan' && now < m.cooldownUntil) return routes[1]
  return routes[0]
}

/** 走着中转时,要不要去看一眼局域网。`force` = 刚回到前台。 */
export function shouldProbeLan(
  m: RouteMemory,
  a: { route: Route; routes: readonly Route[]; foreground: boolean; now: number; force?: boolean },
): boolean {
  if (a.route !== 'relay' || !a.routes.includes('lan') || !a.foreground) return false
  if (a.now < m.cooldownUntil) return false
  return !!a.force || a.now - m.lastProbeAt >= LAN_PROBE_INTERVAL_MS
}

/** 局域网那条断了。迁过去没多久就断 → 冷却;稳定用了很久才断(出门了)→ 不冷却。 */
export function afterLanDrop(m: RouteMemory, now: number): RouteMemory {
  if (m.lanSince === null) return m
  const flapped = now - m.lanSince < LAN_FLAP_WINDOW_MS
  return { ...m, lanSince: null, cooldownUntil: flapped ? now + LAN_COOLDOWN_MS : m.cooldownUntil }
}
