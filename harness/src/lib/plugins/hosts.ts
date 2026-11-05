// 内网主机名(09 spec §6.3、§8.1):只看名字,不解析。解析到内网地址的公网名字挡不住
const HOST_SHAPE = /^[A-Za-z0-9.-]+$/
const DOTTED_IPV4 = /^\d+\.\d+\.\d+\.\d+$/
const INTERNAL_SUFFIX = /(?:^|\.)(?:localhost|local|internal|lan|home\.arpa|corp|intranet|private|home|in-addr\.arpa|ip6\.arpa|localdomain)$/

/**
 * 字面 IP(含 2852039166、0xa9.0xfe.0xa9.0xfe、127.1 这类写法,先按 URL 规则归一)、内网后缀、单段名字都算内网。
 * 不是一个主机名(带端口、账号、路径、IPv6 方括号)也算:拿不准就拒
 */
export function isInternalHost(host: string): boolean {
  if (!HOST_SHAPE.test(host)) return true
  let name: string
  try {
    name = new URL(`https://${host}/`).hostname.toLowerCase()
  } catch {
    return true
  }
  if (name.endsWith('.')) name = name.slice(0, -1)
  return !name.includes('.') || DOTTED_IPV4.test(name) || INTERNAL_SUFFIX.test(name)
}
