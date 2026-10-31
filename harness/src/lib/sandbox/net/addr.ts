// 设计参考 anthropic-experimental/sandbox-runtime(Apache-2.0)
// 代理的地址检查(spec §11):拒绝类地址。IPv6 里嵌着的 IPv4 按 IPv4 判;198.18.0.0/15(fake-ip)不拒
import { BlockList, isIPv4 } from 'node:net'

export type DeniedClass =
  | 'loopback' | 'unspecified' | 'link_local' | 'multicast' | 'broadcast'
  | 'private' | 'cgnat' | 'ula' | 'metadata' | 'local_interface'

export interface ParsedIp {
  family: 4 | 6
  /** 规范写法:IPv4 点分十进制;IPv6 小写压缩(WHATWG 序列化,内嵌 IPv4 写成十六进制) */
  text: string
}

/**
 * 解析 IP 字面量,接受浏览器 / inet_aton 认的全部写法:`0x7f.1`、`2130706433`、`017700000001`、`127.1`、`[::1]`。
 * 用 WHATWG URL 的 host 解析器,和客户端对同一字符串的理解一致。不是 IP → undefined
 */
export function parseIp(s: string): ParsedIp | undefined {
  if (typeof s !== 'string' || s === '' || /[\s%@/?#\\]/.test(s)) return undefined
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s
  if (inner.includes('[') || inner.includes(']')) return undefined
  const v6 = inner.includes(':')
  let host: string
  try {
    host = new URL(`http://${v6 ? `[${inner}]` : inner}/`).hostname
  } catch {
    return undefined
  }
  if (v6) return host.startsWith('[') ? { family: 6, text: host.slice(1, -1) } : undefined
  return isIPv4(host) ? { family: 4, text: host } : undefined
}

/** 规范 IPv6 → 16 个 16 位组(只接受 parseIp 的输出,没有点分尾巴) */
function groups(text: string): number[] {
  const [head, tail] = text.split('::')
  const h = head ? head.split(':') : []
  const t = tail === undefined ? [] : tail ? tail.split(':') : []
  const fill = tail === undefined ? [] : Array<string>(8 - h.length - t.length).fill('0')
  return [...h, ...fill, ...t].map(g => parseInt(g, 16))
}

const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`

/** IPv6 里嵌着的 IPv4:映射 ::ffff:0:0/96、SIIT ::ffff:0:0:0/96、兼容 ::/96、NAT64 64:ff9b::/96、6to4 2002::/16 */
function embeddedV4(g: number[]): string | undefined {
  const zero = (from: number, to: number) => g.slice(from, to).every(x => x === 0)
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6], g[7])
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7])
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7])
  if (g[0] === 0x2002) return v4(g[1], g[2])
  // 兼容地址;:: 与 ::1 是 IPv6 自己的未指定 / 回环
  if (zero(0, 6) && !(g[6] === 0 && g[7] <= 1)) return v4(g[6], g[7])
  return undefined
}

type Table = [DeniedClass, string, number][]

// 先查的先报:元数据比链路本地 / CGNAT 更具体
const V4: Table = [
  ['metadata', '169.254.169.254', 32], // AWS / GCP / Azure / OCI / OpenStack
  ['metadata', '169.254.170.2', 32], // ECS 任务
  ['metadata', '100.100.100.200', 32], // 阿里云
  ['metadata', '168.63.129.16', 32], // Azure WireServer(公网段)
  ['unspecified', '0.0.0.0', 8],
  ['loopback', '127.0.0.0', 8],
  ['link_local', '169.254.0.0', 16],
  ['multicast', '224.0.0.0', 4],
  ['broadcast', '240.0.0.0', 4], // 保留段,含 255.255.255.255
  ['private', '10.0.0.0', 8],
  ['private', '172.16.0.0', 12],
  ['private', '192.168.0.0', 16],
  ['cgnat', '100.64.0.0', 10],
]

const V6: Table = [
  ['metadata', 'fd00:ec2::254', 128], // AWS IMDS(IPv6)
  ['unspecified', '::', 128],
  ['loopback', '::1', 128],
  ['link_local', 'fe80::', 10],
  ['private', 'fec0::', 10], // 已废弃的 site-local
  ['private', '64:ff9b:1::', 48], // RFC 8215 本地 NAT64,内嵌位置不固定 → 整段拒
  ['multicast', 'ff00::', 8],
  ['ula', 'fc00::', 7],
]

const compile = (table: Table, type: 'ipv4' | 'ipv6') =>
  table.map(([cls, net, prefix]) => {
    const b = new BlockList()
    b.addSubnet(net, prefix, type)
    return [cls, b] as const
  })

const V4_LISTS = compile(V4, 'ipv4')
const V6_LISTS = compile(V6, 'ipv6')

/** 判成 IPv4 的规范写法(嵌着 IPv4 的 IPv6 取出 IPv4),供分类与本机地址比较 */
function effective(ip: ParsedIp): ParsedIp {
  if (ip.family === 4) return ip
  const e = embeddedV4(groups(ip.text))
  return e ? { family: 4, text: e } : ip
}

/**
 * 地址的拒绝类;undefined = 可以连。`local` 是本机网卡地址(任意写法)。
 * 不是 IP 的输入一律当拒绝(`unspecified`),宁可多拒。IPv6 的 zone(`%en0`)去掉后再判
 */
export function deniedClass(ip: string, local: string[]): DeniedClass | undefined {
  const pct = typeof ip === 'string' ? ip.indexOf('%') : -1
  const parsed = parseIp(pct > 0 && ip.includes(':') ? ip.slice(0, pct) : ip)
  if (!parsed) return 'unspecified'
  const e = effective(parsed)
  const lists = e.family === 4 ? V4_LISTS : V6_LISTS
  const type = e.family === 4 ? 'ipv4' : 'ipv6'
  for (const [cls, b] of lists) if (b.check(e.text, type)) return cls
  for (const l of local) {
    const p = parseIp(l)
    if (p && effective(p).text === e.text) return 'local_interface'
  }
  return undefined
}
