// 设计参考 anthropic-experimental/sandbox-runtime(Apache-2.0)
// 网络白名单匹配(spec §11):`host` → 80/443,`host:port`,`host:*`,`*.d` 只配子域;IP 字面量逐字且不在拒绝类
import { deniedClass, parseIp } from './addr'

const LABEL = /^[a-z0-9_-]{1,63}$/

/**
 * 规范化主机名:小写、IDN 转 punycode(WHATWG URL 的 host 解析,含全角点等映射)、去一个结尾的点、去 IPv6 方括号,
 * 老式 IPv4 写法(`0x7f.1`、`2130706433`)转成点分十进制。拒绝 `%`、`@`、空白、空输入、空标签、超过 63 字符的标签
 */
export function normalizeHost(h: string): string | undefined {
  if (typeof h !== 'string' || h === '' || /[%@\s\u0000-\u001f\u007f/?#\\*]/.test(h)) return undefined
  if (h.startsWith('[') || h.includes(':')) {
    const ip = parseIp(h)
    return ip?.family === 6 ? ip.text : undefined
  }
  let host: string
  try {
    host = new URL(`http://${h}/`).hostname
  } catch {
    return undefined
  }
  // 结尾的点在解析之后去,全角 / 句号式的点(`。`、`．`)已被映射成 `.`
  if (host.endsWith('.')) host = host.slice(0, -1)
  const ip = parseIp(host)
  if (ip) return ip.text
  if (host.length > 253 || !host.split('.').every(l => LABEL.test(l))) return undefined
  return host
}

type Ports = 'web' | 'any' | number

interface Entry {
  kind: 'host' | 'subdomains' | 'ip'
  host: string
  ports: Ports
}

/** 条目语法:`[通配 *.]主机[:端口|:*]`,IPv6 写 `[v6]:端口`(不带端口时也可裸写);无效 → undefined */
function parseEntry(s: unknown): Entry | undefined {
  if (typeof s !== 'string' || s === '') return undefined
  let hostPart = s
  let portPart: string | undefined
  if (s.startsWith('[')) {
    const close = s.indexOf(']')
    if (close < 0) return undefined
    hostPart = s.slice(0, close + 1)
    const rest = s.slice(close + 1)
    if (rest !== '') {
      if (!rest.startsWith(':')) return undefined
      portPart = rest.slice(1)
    }
  } else if (s.split(':').length === 2) {
    const i = s.indexOf(':')
    hostPart = s.slice(0, i)
    portPart = s.slice(i + 1)
  }
  let ports: Ports = 'web'
  if (portPart === '*') ports = 'any'
  else if (portPart !== undefined) {
    if (!/^[1-9][0-9]{0,4}$/.test(portPart) || Number(portPart) > 65535) return undefined
    ports = Number(portPart)
  }

  const wild = hostPart.startsWith('*.')
  const host = normalizeHost(wild ? hostPart.slice(2) : hostPart)
  if (!host) return undefined
  const ip = parseIp(host)
  if (ip) {
    // 通配不配 IP;拒绝类地址永远不放行,写进来就是错
    if (wild || deniedClass(ip.text, []) !== undefined) return undefined
    return { kind: 'ip', host: ip.text, ports }
  }
  if (isLoopbackName(host)) return undefined // 与拒绝类 IP 条目同理:永远不会被放行
  return { kind: wild ? 'subdomains' : 'host', host, ports }
}

/** RFC 6761:`localhost` 与 `*.localhost` 总是回环;经上游时可能被上游解析成它自己的回环 */
const isLoopbackName = (h: string) => h === 'localhost' || h.endsWith('.localhost')

const portOk = (ports: Ports, port: number) => ports === 'any' || (ports === 'web' ? port === 80 || port === 443 : ports === port)

export interface HostCheck {
  allowed: boolean
  /** 规范化后的主机名;之后的解析、直连、上游 CONNECT、NO_PROXY、netDenied 都只能用它,不能用原始字符串 */
  host?: string
}

/** 白名单检查并给出被检查的那个主机名。两边按同一规范化比较;空表全拒;拒绝类 IP 与 localhost 列出了也拒 */
export function checkHost(list: string[], host: string, port: number): HostCheck {
  const h = normalizeHost(host)
  if (!h) return { allowed: false }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { allowed: false, host: h }
  const isIp = parseIp(h) !== undefined
  if (isIp ? deniedClass(h, []) !== undefined : isLoopbackName(h)) return { allowed: false, host: h }
  for (const raw of list) {
    const e = parseEntry(raw)
    if (!e || !portOk(e.ports, port)) continue
    if (isIp ? e.kind === 'ip' && e.host === h : (e.kind === 'host' && e.host === h) || (e.kind === 'subdomains' && h.endsWith(`.${e.host}`))) return { allowed: true, host: h }
  }
  return { allowed: false, host: h }
}

/** 只要布尔值时用;要连接的一方用 checkHost 拿规范化主机名 */
export const allowedBy = (list: string[], host: string, port: number): boolean => checkHost(list, host, port).allowed

/** permissions.set / 加载时校验 network.allow 的一条 */
export const validateNetworkEntry = (s: unknown): boolean => parseEntry(s) !== undefined
