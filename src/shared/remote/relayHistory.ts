/**
 * 中转地址的历史清单 —— 纯函数,好在 node 下直接测。
 *
 * ★★★**只进地址,不进令牌。** 地址是公开信息(它就印在配对二维码里),令牌不是:
 *  令牌能起 agent、替人答权限门、开终端。为了"下次不用重敲"把令牌一起留在盘上,
 *  等于用便利换一个「谁拿到这台机器就能用」的后门。这个模块的签名里压根没有令牌这个参数,
 *  所以也就不存在「哪天顺手加上去」这条路。
 */

/** 上限。★没有上限的话,手滑敲错的地址会永远留在下拉里。 */
export const RELAY_URL_HISTORY_MAX = 8

/** 归一化:去掉首尾空白和末尾多余的斜杠。★只做这两件,不动大小写 —— 路径是大小写敏感的。 */
export function normalizeRelayUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/**
 * 把刚用过的地址记进历史。返回**新数组**(不改入参)。
 *
 * ★最近用的排最前:下拉里第一条就该是你上次用的那个。
 * ★去重按归一化后的值 —— `wss://x.com` 和 `wss://x.com/` 是同一个地方,
 *  存两条的话下拉里会出现两个看起来一样的选项。
 * ★空字符串不进历史:它不是一个地址,是「还没填」。
 */
export function rememberRelayUrl(history: readonly string[], url: string): string[] {
  const v = normalizeRelayUrl(url)
  if (!v) return [...history]
  const rest = history.filter((h) => normalizeRelayUrl(h) !== v)
  return [v, ...rest].slice(0, RELAY_URL_HISTORY_MAX)
}

/** 从历史里删掉一条(下拉里给个叉)。 */
export function forgetRelayUrl(history: readonly string[], url: string): string[] {
  const v = normalizeRelayUrl(url)
  return history.filter((h) => normalizeRelayUrl(h) !== v)
}

/**
 * 像不像一个中转地址:`ws://` 或 `wss://` 开头,后面跟着主机名。
 * ★只判形状,不判连不连得上 —— 能不能连是开关打开之后中转那边的事,那里有完整的报错。
 *  这里只拦住「明显不是地址」的输入(漏了协议、多了空格、贴成 https://),免得它进了下拉。
 */
export function isRelayUrl(url: string): boolean {
  return /^wss?:\/\/[^\s/]+/i.test(normalizeRelayUrl(url))
}

/**
 * 这条能不能删。★**正在用的那条不许删**:删了它下拉里就看不到「现在连的是哪」,
 *  而中转照样连着 —— 界面和实际状态对不上。要删先切到别的。
 */
export function canForgetRelayUrl(url: string, current: string): boolean {
  const v = normalizeRelayUrl(url)
  return v !== '' && v !== normalizeRelayUrl(current)
}

/**
 * 下拉里实际摆出来的条目:当前那条 + 历史,去重、当前排最前。
 * ★当前那条**可能不在历史里**(历史有上限,最老的会被挤掉;或者是老版本留下的配置),
 *  但它必须出现在下拉里 —— 否则下拉看起来像「什么都没选」,而中转明明连着。
 */
export function relayUrlChoices(current: string, history: readonly string[]): string[] {
  const out: string[] = []
  for (const u of [current, ...history]) {
    const v = normalizeRelayUrl(u)
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}
