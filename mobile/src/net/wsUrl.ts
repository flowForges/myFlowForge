/**
 * 解析 `ws://host:port` —— **自己写,不用 `new URL()`**。
 *
 * ★为什么:React Native 自带的 URL 是个**残缺实现**
 * (`react-native/Libraries/Blob/URL.js`),它的 `hostname` / `host` getter 正则写死了
 * `^https?:\/\/` —— 对 `ws://` 一律返回**空字符串**。
 *
 * 后果不是「某处显示不对」,是**真机上整个「添加主机」屏废掉**:校验里
 * `if (!u.hostname) return 缺主机名` 会把每一个合法地址都判死,而你永远加不进第一台主机。
 * 浏览器里跑测试**永远照不出来** —— 浏览器的 URL 是完整实现。这就是「只在 web 上验」的代价。
 *
 * 这里只认我们真正需要的那一种形状,不做通用 URL 解析:
 *   scheme://host[:port]     scheme ∈ {ws, wss}
 * host 可以是 IPv4、主机名,或者方括号包起来的 IPv6。
 */

export type WsUrlParts = { protocol: 'ws:' | 'wss:'; hostname: string; port: string }

const RE = /^(wss?):\/\/(\[[0-9a-fA-F:.]+\]|[^/?#:\s]+)(?::(\d+))?\/?$/

export function parseWsUrl(raw: string): WsUrlParts | null {
  const m = RE.exec(raw.trim())
  if (!m) return null
  return { protocol: `${m[1]}:` as 'ws:' | 'wss:', hostname: m[2], port: m[3] ?? '' }
}

/**
 * 严格四段 IPv4 的回环判定 + 几个回环别名。
 * ★不能用 `startsWith('127.')` —— 那会把 `127.0.0.1.evil.com` 判成回环,
 *  而「是不是回环」决定的是**要不要强制令牌**,判错等于开一个免凭据的控制端口。
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  return m.slice(1).every((n) => +n <= 255) && m[1] === '127'
}
