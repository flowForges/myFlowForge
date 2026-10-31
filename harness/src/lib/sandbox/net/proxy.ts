// 设计参考 anthropic-experimental/sandbox-runtime(Apache-2.0)
// 会话网络代理(spec §11):CONNECT 隧道 + 绝对形式的 HTTP 转发,只放白名单里的主机;可经上游 HTTP 代理(一律 CONNECT)。
// 每一步(解析、直连、上游 CONNECT、NO_PROXY、拒绝事件)只用 checkHost 返回的规范主机名,不用请求原文;
// 直连时解析一次、检查每个地址、连的就是检查过的那个 IP(不二次解析,挡 DNS rebinding)
import { lookup as dnsLookup } from 'node:dns/promises'
import { chmodSync, unlinkSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { BlockList, connect, createServer as createNetServer, type Server, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { deniedClass, parseIp } from './addr'
import { checkHost, normalizeHost } from './domains'

export type LookupFn = (host: string) => Promise<{ address: string; family?: number }[]>

export interface Upstream {
  /** 上游地址,不含 userinfo */
  url: URL
  /** base64(user:pass);不可枚举,JSON / 日志里不会带出 */
  auth?: string
  /** 参数是规范主机名 */
  noProxy: (host: string) => boolean
}

export type DenyReason = 'not_allowed' | 'private_address' | 'bad_request'
export interface DenyEvent { host: string; port: number; reason: DenyReason }

export interface ProxyOptions {
  /** 每个请求现读 */
  allow(): string[]
  upstream?: Upstream
  lookup?: LookupFn
  /** 直连源站;只会拿到通过了地址检查的规范 IP。上游连接不经它 */
  dial?: (host: string, port: number) => Socket
  onDeny(d: DenyEvent): void
  /** posix:另外在这个 Unix socket 上听(Linux 沙箱里的中转用) */
  unixPath?: string
  /** 并发客户端连接上限,默认 64;超出回 503 */
  maxConns?: number
  /** 收齐请求头、解析、连接、上游握手各自的期限,默认 30 s */
  connectTimeoutMs?: number
  /** 隧道 / 连接无数据多久断开,默认 10 分钟 */
  tunnelIdleMs?: number
  /** 没有连接且没有 touch() 满这么久就自己关掉,默认 10 分钟;<= 0 不自关 */
  idleMs?: number
  /** 本机网卡地址;默认读 os.networkInterfaces()(5 s 缓存) */
  localAddrs?: () => string[]
}

export interface ProxyHandle {
  port: number
  close(): Promise<void>
  /** 有新的 plan() 用到它:推迟空闲关闭 */
  touch(): void
  /** 关掉(close() 或空闲)后 resolve */
  closed: Promise<void>
}

const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request', 403: 'Forbidden', 502: 'Bad Gateway', 503: 'Service Unavailable' }
const bodyFor = (status: number) => (status === 403 ? 'denied' : '')

function rawResponse(status: number): string {
  const body = bodyFor(status)
  return `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
}

class ProxyError extends Error {
  constructor(readonly status: number, readonly deny?: DenyEvent) {
    super(String(status))
  }
}

const bad = () => new ProxyError(400, { host: '', port: 0, reason: 'bad_request' })

/** `host:port` / `[v6]:port`;没有端口时用 defaultPort(CONNECT 必须带端口)。userinfo、%、空白、路径字符 → undefined */
function parseAuthority(s: string, defaultPort?: number): { host: string; port: number } | undefined {
  if (!s || /[@%\s/\\?#]/.test(s)) return undefined
  let host: string
  let portStr: string | undefined
  if (s.startsWith('[')) {
    const i = s.indexOf(']')
    if (i < 0) return undefined
    host = s.slice(0, i + 1)
    const rest = s.slice(i + 1)
    if (rest !== '') {
      if (!rest.startsWith(':')) return undefined
      portStr = rest.slice(1)
    }
  } else {
    const parts = s.split(':')
    if (parts.length > 2) return undefined
    ;[host, portStr] = parts
  }
  if (!host) return undefined
  if (portStr === undefined) return defaultPort === undefined ? undefined : { host, port: defaultPort }
  if (!/^\d{1,5}$/.test(portStr)) return undefined
  const port = Number(portStr)
  return port >= 1 && port <= 65535 ? { host, port } : undefined
}

/** `http://authority[/path]`;别的形态(源形式、https、带 # 的)→ undefined */
function parseAbsolute(url: string): { host: string; port: number; path: string } | undefined {
  const m = /^http:\/\/([^/?#]*)([/?][^#]*)?$/i.exec(url)
  if (!m) return undefined
  const a = parseAuthority(m[1], 80)
  if (!a) return undefined
  const p = m[2] ?? '/'
  return { ...a, path: p.startsWith('?') ? `/${p}` : p }
}

const authority = (host: string, port: number) => `${host.includes(':') ? `[${host}]` : host}:${port}`

let ifCache: { at: number; addrs: string[] } | undefined
function interfaceAddrs(): string[] {
  if (!ifCache || Date.now() - ifCache.at > 5000) {
    const addrs = Object.values(networkInterfaces()).flatMap(l => (l ?? []).map(i => i.address))
    ifCache = { at: Date.now(), addrs }
  }
  return ifCache.addrs
}

const defaultLookup: LookupFn = h => dnsLookup(h, { all: true })

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms) }),
  ]).finally(() => clearTimeout(t))
}

/** 等套接字连上;出错、关闭或超时 → 销毁并抛 502 */
function connected(s: Socket, ms: number): Promise<void> {
  if (!s.pending && !s.connecting) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const fail = () => {
      cleanup()
      s.destroy()
      reject(new ProxyError(502))
    }
    const ok = () => {
      cleanup()
      resolve()
    }
    const t = setTimeout(fail, ms)
    const cleanup = () => {
      clearTimeout(t)
      s.off('connect', ok)
      s.off('error', fail)
      s.off('close', fail)
    }
    s.once('connect', ok)
    s.once('error', fail)
    s.once('close', fail)
  })
}

/** 读上游对 CONNECT 的响应头;2xx → 剩下的字节放回流里 */
function upstreamReply(s: Socket, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const fail = () => {
      cleanup()
      s.destroy()
      reject(new ProxyError(502))
    }
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c])
      const i = buf.indexOf('\r\n\r\n')
      if (i < 0) {
        if (buf.length > 16 * 1024) fail()
        return
      }
      cleanup()
      s.pause()
      if (!/^HTTP\/1\.[01] 2\d\d /.test(buf.subarray(0, i + 2).toString('latin1'))) {
        s.destroy()
        return reject(new ProxyError(502))
      }
      const rest = buf.subarray(i + 4)
      if (rest.length) s.unshift(rest)
      resolve()
    }
    const t = setTimeout(fail, ms)
    const cleanup = () => {
      clearTimeout(t)
      s.off('data', onData)
      s.off('error', fail)
      s.off('close', fail)
    }
    s.on('data', onData)
    s.once('error', fail)
    s.once('close', fail)
  })
}

// 逐跳头,外加 Connection 里点名的;Proxy-* 一律去掉
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'expect'])

function forwardable(raw: string[]): string[] {
  const named = new Set<string>()
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === 'connection') for (const t of raw[i + 1].split(',')) named.add(t.trim().toLowerCase())
  }
  const out: string[] = []
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i].toLowerCase()
    if (HOP.has(k) || named.has(k) || k.startsWith('proxy-')) continue
    out.push(raw[i], raw[i + 1])
  }
  return out
}

export async function startProxy(o: ProxyOptions): Promise<ProxyHandle> {
  const maxConns = o.maxConns ?? 64
  const connectTimeoutMs = o.connectTimeoutMs ?? 30_000
  const tunnelIdleMs = o.tunnelIdleMs ?? 600_000
  const idleMs = o.idleMs ?? 600_000
  const lookup = o.lookup ?? defaultLookup
  const dial = o.dial ?? ((host: string, port: number) => connect({ host, port }))
  const localAddrs = o.localAddrs ?? interfaceAddrs

  const clients = new Set<Socket>() // 计入上限的客户端连接
  const others = new Set<Socket>() // 出站连接与被 503 的连接
  const deadlines = new Map<Socket, NodeJS.Timeout>()
  const served = new WeakSet<Socket>()
  let closing = false
  let idleTimer: NodeJS.Timeout | undefined
  let resolveClosed!: () => void
  const closed = new Promise<void>(r => { resolveClosed = r })

  const track = (s: Socket) => {
    others.add(s)
    s.on('close', () => others.delete(s))
    s.on('error', () => {})
    return s
  }

  const armIdle = () => {
    clearTimeout(idleTimer)
    if (closing || clients.size > 0 || !(idleMs > 0)) return
    idleTimer = setTimeout(() => void close(), idleMs)
  }

  const clearDeadline = (s: Socket) => {
    clearTimeout(deadlines.get(s))
    deadlines.delete(s)
  }

  const deny = (e: unknown): number => {
    const err = e instanceof ProxyError ? e : new ProxyError(502)
    if (err.deny) {
      try {
        o.onDeny(err.deny)
      } catch {
        // 事件回调出错不影响拒绝
      }
    }
    return err.status
  }

  /** 白名单 + 地址检查,然后直连或经上游打通到 host:port;返回连好的套接字与被检查的主机名 */
  async function route(rawHost: string, port: number): Promise<{ sock: Socket; host: string }> {
    const c = checkHost(o.allow(), rawHost, port)
    if (!c.host) throw bad()
    const host = c.host
    const local = localAddrs()
    const isIp = parseIp(host) !== undefined
    if (!c.allowed) throw new ProxyError(403, { host, port, reason: isIp && deniedClass(host, local) ? 'private_address' : 'not_allowed' })
    const privateAddr = () => new ProxyError(403, { host, port, reason: 'private_address' })
    const via = o.upstream && !o.upstream.noProxy(host) ? o.upstream : undefined

    let addrs: string[] | undefined
    if (isIp) addrs = [host]
    else {
      try {
        const r = await withTimeout(lookup(host), via ? Math.min(5000, connectTimeoutMs) : connectTimeoutMs)
        addrs = r.map(a => a.address)
      } catch {
        addrs = undefined
      }
      if (addrs?.length === 0) addrs = undefined
    }
    if (closing) throw new ProxyError(502)

    if (via) {
      // 尽力检查:本地解析出任何拒绝类地址就拒(上游选哪个不由我们定);解析失败交给上游
      if (addrs?.some(a => deniedClass(a, local) !== undefined)) throw privateAddr()
      return { sock: await viaUpstream(via, host, port), host }
    }
    if (!addrs) throw new ProxyError(502)
    const target = addrs.map(a => (deniedClass(a, local) === undefined ? parseIp(a) : undefined)).find(ip => ip !== undefined)
    if (!target) throw privateAddr()
    const sock = track(dial(target.text, port))
    await connected(sock, connectTimeoutMs)
    return { sock, host }
  }

  async function viaUpstream(u: Upstream, host: string, port: number): Promise<Socket> {
    const uhost = u.url.hostname.replace(/^\[(.*)\]$/, '$1')
    const sock = track(connect({ host: uhost, port: Number(u.url.port) || 80 }))
    await connected(sock, connectTimeoutMs)
    const target = authority(host, port)
    sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${u.auth ? `Proxy-Authorization: Basic ${u.auth}\r\n` : ''}\r\n`)
    await upstreamReply(sock, connectTimeoutMs)
    return sock
  }

  function splice(a: Socket, b: Socket) {
    const kill = () => {
      a.destroy()
      b.destroy()
    }
    a.on('close', kill)
    b.on('close', kill)
    b.setTimeout(tunnelIdleMs, kill)
    a.pipe(b)
    b.pipe(a)
  }

  async function onConnect(req: IncomingMessage, sock: Socket, head: Buffer) {
    clearDeadline(sock)
    try {
      const t = parseAuthority(req.url ?? '')
      if (!t) throw bad()
      const { sock: remote } = await route(t.host, t.port)
      if (sock.destroyed || closing) return void remote.destroy()
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) remote.write(head)
      splice(sock, remote)
    } catch (e) {
      const status = deny(e)
      if (!sock.destroyed) sock.end(rawResponse(status))
    }
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    const sock = req.socket
    clearDeadline(sock)
    res.shouldKeepAlive = false
    // 每个客户端连接只转发一个请求;流水线上的后续请求不处理
    if (served.has(sock)) return void req.resume()
    served.add(sock)
    const fail = (status: number) => {
      if (res.headersSent) return void res.destroy()
      const body = bodyFor(status)
      res.writeHead(status, { 'Content-Type': 'text/plain', 'Content-Length': body.length }).end(body)
    }
    let remote: Socket
    let host: string
    let target: { host: string; port: number; path: string } | undefined
    try {
      target = parseAbsolute(req.url ?? '')
      if (!target) throw bad()
      ;({ sock: remote, host } = await route(target.host, target.port))
    } catch (e) {
      return fail(deny(e))
    }
    if (sock.destroyed || closing) return void remote.destroy()
    const hostHeader = target.port === 80 ? (host.includes(':') ? `[${host}]` : host) : authority(host, target.port)
    const headers = ['Host', hostHeader, ...forwardable(req.rawHeaders)]
    if (req.headers['transfer-encoding']) headers.push('Transfer-Encoding', 'chunked')
    const out = httpRequest({ createConnection: () => remote, method: req.method, path: target.path, headers, setHost: false })
    // 上游握手后套接字是暂停的
    out.once('socket', s => s.resume())
    out.on('response', (up) => {
      const h = forwardable(up.rawHeaders)
      res.writeHead(up.statusCode ?? 502, up.statusMessage, h)
      up.pipe(res)
      up.on('error', () => res.destroy())
    })
    out.on('error', () => {
      remote.destroy()
      fail(502)
    })
    remote.setTimeout(tunnelIdleMs, () => remote.destroy())
    req.pipe(out)
  }

  const http = createHttpServer({ requestTimeout: 0 })
  http.on('connect', (req: IncomingMessage, sock: Socket, head: Buffer) => void onConnect(req, sock, head))
  http.on('request', (req: IncomingMessage, res: ServerResponse) => void onRequest(req, res))
  http.on('clientError', (_err, sock: Socket) => {
    if (sock.writable) sock.end(rawResponse(400))
    else sock.destroy()
  })

  const onConnection = (sock: Socket) => {
    sock.on('error', () => {})
    if (closing || clients.size >= maxConns) {
      track(sock)
      sock.resume()
      sock.end(rawResponse(503))
      return
    }
    clients.add(sock)
    clearTimeout(idleTimer)
    sock.on('close', () => {
      clients.delete(sock)
      clearDeadline(sock)
      armIdle()
    })
    // 收齐请求头的总期限:一点点地写不会延长它(slowloris)
    deadlines.set(sock, setTimeout(() => sock.destroy(), connectTimeoutMs))
    http.emit('connection', sock)
    sock.setTimeout(tunnelIdleMs, () => sock.destroy())
  }

  const servers: Server[] = []
  const listen = (s: Server, ...args: unknown[]) => new Promise<void>((resolve, reject) => {
    s.once('error', reject)
    s.listen(...(args as [number, string]), () => {
      s.off('error', reject)
      resolve()
    })
  })

  async function close(): Promise<void> {
    if (closing) return closed
    closing = true
    clearTimeout(idleTimer)
    for (const t of deadlines.values()) clearTimeout(t)
    deadlines.clear()
    for (const s of clients) s.destroy()
    for (const s of others) s.destroy()
    await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))))
    resolveClosed()
  }

  try {
    const tcp = createNetServer(onConnection)
    servers.push(tcp)
    await listen(tcp, 0, '127.0.0.1')
    if (o.unixPath) {
      try {
        unlinkSync(o.unixPath)
      } catch {
        // 不存在
      }
      const unix = createNetServer(onConnection)
      servers.push(unix)
      await listen(unix, o.unixPath)
      chmodSync(o.unixPath, 0o600)
    }
  } catch (e) {
    await close()
    throw e
  }
  const addr = servers[0].address()
  const port = addr && typeof addr === 'object' ? addr.port : 0
  armIdle()
  return {
    port,
    close,
    touch: () => {
      if (clients.size === 0) armIdle()
    },
    closed,
  }
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** NO_PROXY:`*` 全部;`d` / `.d` / `*.d` 匹配 d 及其子域;端口忽略;IP 逐个;CIDR 只套在 IP 上 */
function noProxyMatcher(spec: string | undefined): (host: string) => boolean {
  const entries = (spec ?? '').split(/[\s,]+/).filter(Boolean)
  if (entries.includes('*')) return () => true
  const names: string[] = []
  const ips = new BlockList()
  for (let e of entries) {
    const slash = e.indexOf('/')
    if (slash > 0) {
      const ip = parseIp(e.slice(0, slash))
      const bits = e.slice(slash + 1)
      if (ip && /^\d{1,3}$/.test(bits) && Number(bits) <= (ip.family === 4 ? 32 : 128)) ips.addSubnet(ip.text, Number(bits), ip.family === 4 ? 'ipv4' : 'ipv6')
      continue
    }
    if (e.startsWith('*.')) e = e.slice(2)
    else if (e.startsWith('.')) e = e.slice(1)
    if (e.startsWith('[')) {
      const i = e.indexOf(']')
      if (i > 0) e = e.slice(0, i + 1)
    } else if (e.split(':').length === 2) e = e.slice(0, e.indexOf(':'))
    const ip = parseIp(e)
    if (ip) {
      ips.addAddress(ip.text, ip.family === 4 ? 'ipv4' : 'ipv6')
      continue
    }
    const h = normalizeHost(e)
    if (h) names.push(h)
  }
  return (host) => {
    const ip = parseIp(host)
    if (ip) return ips.check(ip.text, ip.family === 4 ? 'ipv4' : 'ipv6')
    return names.some(n => host === n || host.endsWith(`.${n}`))
  }
}

/**
 * 从环境变量取上游(R15):HTTPS_PROXY、https_proxy、HTTP_PROXY、http_proxy、ALL_PROXY、all_proxy 依次,取第一个 http: 的;
 * 不带 scheme 当 http。只有 socks 的 → 没有上游并给出警告。userinfo 转成 Basic,不留在 url 里
 */
export function upstreamFromEnv(env: Record<string, string | undefined>): { upstream?: Upstream; warning?: 'socks_upstream_unsupported' } {
  let socks = false
  for (const name of PROXY_VARS) {
    const v = env[name]?.trim()
    if (!v) continue
    let url: URL
    try {
      url = new URL(v.includes('://') ? v : `http://${v}`)
    } catch {
      continue
    }
    if (url.protocol.startsWith('socks')) socks = true
    if (url.protocol !== 'http:' || !url.hostname) continue
    const auth = url.username || url.password ? Buffer.from(`${decode(url.username)}:${decode(url.password)}`).toString('base64') : undefined
    const clean = new URL(`http://${url.host}/`)
    const upstream: Upstream = { url: clean, noProxy: noProxyMatcher(env.NO_PROXY ?? env.no_proxy) }
    if (auth) Object.defineProperty(upstream, 'auth', { value: auth, enumerable: false })
    return { upstream }
  }
  return socks ? { warning: 'socks_upstream_unsupported' } : {}
}
