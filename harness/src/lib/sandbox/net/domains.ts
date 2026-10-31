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
  const bare = h.endsWith('.') ? h.slice(0, -1) : h
  if (bare === '' || bare.endsWith('.')) return undefined
  let host: string
  try {
    host = new URL(`http://${bare}/`).hostname
  } catch {
    return undefined
  }
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
  return { kind: wild ? 'subdomains' : 'host', host, ports }
}

const portOk = (ports: Ports, port: number) => ports === 'any' || (ports === 'web' ? port === 80 || port === 443 : ports === port)

/** 白名单是否放行 host:port。两边按同一规范化比较;空表全拒;拒绝类 IP 列出了也拒 */
export function allowedBy(list: string[], host: string, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  const h = normalizeHost(host)
  if (!h) return false
  const isIp = parseIp(h) !== undefined
  if (isIp && deniedClass(h, []) !== undefined) return false
  for (const raw of list) {
    const e = parseEntry(raw)
    if (!e || !portOk(e.ports, port)) continue
    if (isIp ? e.kind === 'ip' && e.host === h : (e.kind === 'host' && e.host === h) || (e.kind === 'subdomains' && h.endsWith(`.${e.host}`))) return true
  }
  return false
}

/** permissions.set / 加载时校验 network.allow 的一条 */
export const validateNetworkEntry = (s: unknown): boolean => parseEntry(s) !== undefined
