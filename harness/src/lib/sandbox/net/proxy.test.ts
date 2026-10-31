import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect, isIP, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeOrigin, startFakeUpstream, type FakeServer } from '../../../../test/fakeUpstream'
import { startProxy, upstreamFromEnv, type LookupFn, type ProxyHandle, type Upstream } from './proxy'

// 不碰真网络:域名全走注入的 lookup,"互联网"是 127.0.0.1 上的假上游 / 假源站

const closers: (() => Promise<void>)[] = []
const tmpDirs: string[] = []
const clients = new Set<Socket>()

afterEach(async () => {
  for (const c of clients) c.destroy()
  clients.clear()
  while (closers.length) await closers.pop()!()
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  // 没有留下任何监听
  await waitFor(() => !process.getActiveResourcesInfo().some(r => r === 'TCPServerWrap' || r === 'PipeServerWrap'))
  expect(process.getActiveResourcesInfo().filter(r => r === 'TCPServerWrap' || r === 'PipeServerWrap')).toEqual([])
})

async function waitFor(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 10))
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

async function fake(kind: 'upstream' | 'origin', o: { status?: number; established?: string; reply?: string } = {}): Promise<FakeServer> {
  const s = kind === 'upstream' ? await startFakeUpstream(o) : await startFakeOrigin(o)
  closers.push(s.close)
  return s
}

const PUBLIC = '93.184.216.34'

/** 注入的解析:表里有就给,没有 → ENOTFOUND。记下每次调用 */
function fakeLookup(table: Record<string, string[] | (() => string[])>) {
  const calls: string[] = []
  const lookup: LookupFn = async (h) => {
    calls.push(h)
    const v = table[h]
    const list = typeof v === 'function' ? v() : v
    if (!list) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
    return list.map(address => ({ address, family: isIP(address) }))
  }
  return { lookup, calls }
}

/** 注入的直连:记下目标,实际连到假源站 */
function fakeDial(origin: FakeServer) {
  const calls: [string, number][] = []
  const dial = (host: string, port: number) => {
    calls.push([host, port])
    return connect(origin.port, '127.0.0.1')
  }
  return { dial, calls }
}

async function proxy(o: Parameters<typeof startProxy>[0]): Promise<ProxyHandle & { denies: { host: string; port: number; reason: string }[] }> {
  const denies: { host: string; port: number; reason: string }[] = []
  const onDeny = o.onDeny
  const p = await startProxy({ ...o, onDeny: (d) => { denies.push(d); onDeny(d) } })
  closers.push(p.close)
  return Object.assign(p, { denies })
}

type Addr = number | string

function open(addr: Addr): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = typeof addr === 'number' ? connect(addr, '127.0.0.1') : connect(addr)
    clients.add(s)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
}

/** 发一段原始请求,读到响应头结束;返回状态码、整段头、头之后的字节和套接字 */
async function send(addr: Addr, text: string): Promise<{ status: number; head: string; rest: Buffer; sock: Socket }> {
  const sock = await open(addr)
  sock.write(text)
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0)
    const done = () => {
      const i = buf.indexOf('\r\n\r\n')
      const head = (i < 0 ? buf : buf.subarray(0, i)).toString('latin1')
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(head)
      resolve({ status: m ? Number(m[1]) : 0, head, rest: i < 0 ? Buffer.alloc(0) : buf.subarray(i + 4), sock })
    }
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c])
      if (buf.includes('\r\n\r\n')) {
        sock.off('data', onData)
        sock.off('close', done)
        done()
      }
    }
    sock.on('data', onData)
    sock.once('close', done)
    sock.on('error', () => {})
  })
}

const connectReq = (addr: Addr, target: string, host = target, extra = '') =>
  send(addr, `CONNECT ${target} HTTP/1.1\r\nHost: ${host}\r\n${extra}\r\n`)

/** 读完整个响应(到对端关闭) */
async function exchange(addr: Addr, text: string): Promise<string> {
  const sock = await open(addr)
  sock.write(text)
  return new Promise((resolve) => {
    let buf = ''
    sock.on('data', (c: Buffer) => { buf += c.toString('latin1') })
    sock.once('close', () => resolve(buf))
    sock.on('error', () => {})
  })
}

/** 往隧道里写,读回同样多的字节 */
function echo(sock: Socket, data: string, already: Buffer = Buffer.alloc(0)): Promise<string> {
  return new Promise((resolve) => {
    let buf = already
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c])
      if (buf.length >= data.length) {
        sock.off('data', onData)
        resolve(buf.toString('latin1'))
      }
    }
    sock.on('data', onData)
    sock.write(data)
  })
}

const closedWithin = async (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), delay(ms).then(() => false)])

function upstreamAt(u: FakeServer, env: Record<string, string> = {}): Upstream {
  const r = upstreamFromEnv({ HTTPS_PROXY: `http://127.0.0.1:${u.port}`, ...env })
  if (!r.upstream) throw new Error('no upstream')
  return r.upstream
}

const NPM = ['registry.npmjs.org']

describe('startProxy — with an upstream (Review Focus 2)', () => {
  it('a host not on the list → 403 "denied" and the upstream records nothing', async () => {
    const up = await fake('upstream')
    const p = await proxy({ allow: () => NPM, upstream: upstreamAt(up), onDeny: () => {} })
    const r = await connectReq(p.port, 'evil.example:443')
    expect(r.status).toBe(403)
    const body = r.rest.toString()
    expect(body).toBe('denied')
    expect(up.connects).toEqual([])
    expect(p.denies).toEqual([{ host: 'evil.example', port: 443, reason: 'not_allowed' }])
  })

  it('an allowed host reaches the upstream as exactly that CONNECT line and bytes round-trip', async () => {
    const up = await fake('upstream')
    const { lookup } = fakeLookup({ 'registry.npmjs.org': [PUBLIC] })
    const p = await proxy({ allow: () => NPM, upstream: upstreamAt(up), lookup, onDeny: () => {} })
    const r = await connectReq(p.port, 'registry.npmjs.org:443')
    expect(r.status).toBe(200)
    expect(await echo(r.sock, 'hello through the tunnel', r.rest)).toBe('hello through the tunnel')
    expect(up.connects.map(c => c.line)).toEqual(['CONNECT registry.npmjs.org:443 HTTP/1.1'])
    expect(up.connects[0].headers.host).toBe('registry.npmjs.org:443')
    expect(p.denies).toEqual([])
  })

  it('the upstream only ever sees the normalised host, never the raw request text', async () => {
    const up = await fake('upstream')
    const p = await proxy({ allow: () => ['github.com'], upstream: upstreamAt(up), lookup: fakeLookup({}).lookup, onDeny: () => {} })
    const r = await connectReq(p.port, 'GitHub.COM.:443')
    expect(r.status).toBe(200)
    expect(up.connects.map(c => c.line)).toEqual(['CONNECT github.com:443 HTTP/1.1'])
    // 非 ASCII 的请求目标(软连字符会折叠成 github.com)在 HTTP 解析器那里就是 400,到不了白名单
    expect((await send(p.port, 'CONNECT git\u00adhub.com:443 HTTP/1.1\r\nHost: x\r\n\r\n')).status).toBe(400)
    expect((await send(p.port, 'GET http://git\u00adhub.com/ HTTP/1.1\r\nHost: x\r\n\r\n')).status).toBe(400)
    expect(up.connects.length).toBe(1)
  })

  it('an empty allowlist denies registry.npmjs.org', async () => {
    const up = await fake('upstream')
    const p = await proxy({ allow: () => [], upstream: upstreamAt(up), onDeny: () => {} })
    expect((await connectReq(p.port, 'registry.npmjs.org:443')).status).toBe(403)
    expect(up.connects).toEqual([])
  })

  it('the allowlist is read per request', async () => {
    const up = await fake('upstream')
    let list: string[] = []
    const p = await proxy({ allow: () => list, upstream: upstreamAt(up), lookup: fakeLookup({}).lookup, onDeny: () => {} })
    expect((await connectReq(p.port, 'registry.npmjs.org:443')).status).toBe(403)
    list = NPM
    expect((await connectReq(p.port, 'registry.npmjs.org:443')).status).toBe(200)
  })

  it('a local lookup that gives a denied address → 403 before the upstream is contacted (any denied address counts)', async () => {
    const up = await fake('upstream')
    const { lookup } = fakeLookup({ 'ok.test': ['10.0.0.5'], 'mixed.test': [PUBLIC, '127.0.0.1'] })
    const p = await proxy({ allow: () => ['ok.test', 'mixed.test'], upstream: upstreamAt(up), lookup, onDeny: () => {} })
    expect((await connectReq(p.port, 'ok.test:443')).status).toBe(403)
    expect((await connectReq(p.port, 'mixed.test:443')).status).toBe(403)
    expect(up.connects).toEqual([])
    expect(p.denies.map(d => d.reason)).toEqual(['private_address', 'private_address'])
  })

  it('a lookup failure with an upstream is forwarded to it', async () => {
    const up = await fake('upstream')
    const { lookup, calls } = fakeLookup({})
    const p = await proxy({ allow: () => NPM, upstream: upstreamAt(up), lookup, onDeny: () => {} })
    const r = await connectReq(p.port, 'registry.npmjs.org:443')
    expect(r.status).toBe(200)
    expect(calls).toEqual(['registry.npmjs.org'])
    expect(up.connects.map(c => c.line)).toEqual(['CONNECT registry.npmjs.org:443 HTTP/1.1'])
  })

  it('upstream userinfo becomes Proxy-Authorization: Basic and never shows in the Upstream url', async () => {
    const up = await fake('upstream')
    const { upstream } = upstreamFromEnv({ HTTPS_PROXY: `http://u:p@127.0.0.1:${up.port}` })
    expect(upstream!.auth).toBe('dTpw')
    expect(upstream!.url.href).not.toContain('u:p')
    expect(JSON.stringify(upstream)).not.toContain('u:p')
    const p = await proxy({ allow: () => NPM, upstream, lookup: fakeLookup({}).lookup, onDeny: () => {} })
    // 客户端自带的 Proxy-Authorization 不往外传
    expect((await connectReq(p.port, 'registry.npmjs.org:443', undefined, 'Proxy-Authorization: Basic Y2xpZW50OnNlY3JldA==\r\n')).status).toBe(200)
    expect(up.connects[0].headers['proxy-authorization']).toBe('Basic dTpw')
  })

  it('the upstream refusing the tunnel → 502 to the client, without its details', async () => {
    const up = await fake('upstream', { status: 407 })
    const p = await proxy({ allow: () => NPM, upstream: upstreamAt(up), lookup: fakeLookup({}).lookup, onDeny: () => {} })
    const r = await connectReq(p.port, 'registry.npmjs.org:443')
    expect(r.status).toBe(502)
    expect(r.head).not.toContain('407')
  })

  it('a loopback upstream is fine, but CONNECT to that same loopback address is denied', async () => {
    const up = await fake('upstream')
    const p = await proxy({ allow: () => [...NPM, `127.0.0.1:${up.port}`, 'localhost:*'], upstream: upstreamAt(up), lookup: fakeLookup({}).lookup, onDeny: () => {} })
    expect((await connectReq(p.port, `127.0.0.1:${up.port}`)).status).toBe(403)
    expect((await connectReq(p.port, `localhost:${up.port}`)).status).toBe(403)
    expect((await connectReq(p.port, `[::ffff:127.0.0.1]:${up.port}`)).status).toBe(403)
    expect(up.connects).toEqual([])
    expect((await connectReq(p.port, 'registry.npmjs.org:443')).status).toBe(200)
    expect(up.connects.length).toBe(1)
  })

  it('plain GET http://registry.npmjs.org/x → CONNECT registry.npmjs.org:80, then the origin-form request inside the tunnel', async () => {
    const up = await fake('upstream')
    const p = await proxy({ allow: () => NPM, upstream: upstreamAt(up), lookup: fakeLookup({}).lookup, onDeny: () => {} })
    const res = await exchange(p.port, 'GET http://registry.npmjs.org/x?y=1 HTTP/1.1\r\nHost: registry.npmjs.org\r\nProxy-Authorization: Basic Y2xpZW50OnNlY3JldA==\r\nProxy-Connection: keep-alive\r\nAccept: */*\r\n\r\n')
    expect(res).toMatch(/^HTTP\/1\.1 200/)
    expect(res).toContain('ok /x?y=1')
    expect(up.connects.map(c => c.line)).toEqual(['CONNECT registry.npmjs.org:80 HTTP/1.1'])
    expect(up.inner.map(i => i.line)).toEqual(['GET /x?y=1 HTTP/1.1'])
    expect(up.inner[0].headers.host).toBe('registry.npmjs.org')
    expect(up.inner[0].headers.accept).toBe('*/*')
    expect(up.inner[0].headers['proxy-authorization']).toBeUndefined()
    expect(up.inner[0].headers['proxy-connection']).toBeUndefined()
  })

  it('NO_PROXY=registry.npmjs.org → direct via the injected dial to the looked-up address', async () => {
    const up = await fake('upstream')
    const origin = await fake('origin')
    const { lookup } = fakeLookup({ 'registry.npmjs.org': [PUBLIC] })
    const { dial, calls } = fakeDial(origin)
    const p = await proxy({ allow: () => NPM, upstream: upstreamAt(up, { NO_PROXY: 'registry.npmjs.org' }), lookup, dial, onDeny: () => {} })
    const r = await connectReq(p.port, 'registry.npmjs.org:443')
    expect(r.status).toBe(200)
    expect(await echo(r.sock, 'direct', r.rest)).toBe('direct')
    expect(calls).toEqual([[PUBLIC, 443]])
    expect(up.connects).toEqual([])
  })
})

describe('startProxy — direct (no upstream)', () => {
  it('a lookup to 10.0.0.5 or ::ffff:127.0.0.1 → 403 and dial is never called', async () => {
    const origin = await fake('origin')
    const { lookup } = fakeLookup({ 'ok.test': ['10.0.0.5'], 'ok2.test': ['::ffff:127.0.0.1'] })
    const { dial, calls } = fakeDial(origin)
    const p = await proxy({ allow: () => ['ok.test', 'ok2.test'], lookup, dial, onDeny: () => {} })
    for (const t of ['ok.test:443', 'ok2.test:443']) {
      const r = await connectReq(p.port, t)
      expect(r.status).toBe(403)
      expect(r.rest.toString()).toBe('denied')
      expect(r.head + r.rest.toString()).not.toMatch(/10\.0\.0\.5|127\.0\.0\.1/)
    }
    expect(calls).toEqual([])
    expect(p.denies).toEqual([
      { host: 'ok.test', port: 443, reason: 'private_address' },
      { host: 'ok2.test', port: 443, reason: 'private_address' },
    ])
  })

  it('drops denied addresses and dials the first remaining one', async () => {
    const origin = await fake('origin')
    const { lookup } = fakeLookup({ 'ok.test': ['127.0.0.1', '10.0.0.5', PUBLIC, '8.8.8.8'] })
    const { dial, calls } = fakeDial(origin)
    const p = await proxy({ allow: () => ['ok.test'], lookup, dial, onDeny: () => {} })
    const r = await connectReq(p.port, 'ok.test:443')
    expect(r.status).toBe(200)
    expect(calls).toEqual([[PUBLIC, 443]])
  })

  it('DNS rebinding: resolves once and dials that address, so a second answer is never used', async () => {
    const origin = await fake('origin')
    let n = 0
    const { lookup, calls: lookups } = fakeLookup({ 'ok.test': () => (n++ === 0 ? [PUBLIC] : ['127.0.0.1']) })
    const { dial, calls } = fakeDial(origin)
    const p = await proxy({ allow: () => ['ok.test'], lookup, dial, onDeny: () => {} })
    const r = await connectReq(p.port, 'ok.test:443')
    expect(r.status).toBe(200)
    expect(lookups).toEqual(['ok.test'])
    expect(calls).toEqual([[PUBLIC, 443]])
    // 下一次解析给回环 → 拒,dial 不再被调
    expect((await connectReq(p.port, 'ok.test:443')).status).toBe(403)
    expect(calls).toEqual([[PUBLIC, 443]])
  })

  it('this machine\'s own interface addresses are denied after lookup and for IP literals', async () => {
    const origin = await fake('origin')
    const { lookup } = fakeLookup({ 'ok.test': ['203.0.113.7'] })
    const { dial, calls } = fakeDial(origin)
    const p = await proxy({ allow: () => ['ok.test', '203.0.113.7'], lookup, dial, localAddrs: () => ['203.0.113.7'], onDeny: () => {} })
    expect((await connectReq(p.port, 'ok.test:443')).status).toBe(403)
    expect((await connectReq(p.port, '203.0.113.7:443')).status).toBe(403)
    expect(calls).toEqual([])
    expect(p.denies.map(d => d.reason)).toEqual(['private_address', 'private_address'])
  })

  it('CONNECT to an IP literal: listed public IP dials it without a lookup; denied classes never dial', async () => {
    const origin = await fake('origin')
    const { lookup, calls: lookups } = fakeLookup({})
    const { dial, calls } = fakeDial(origin)
    const p = await proxy({ allow: () => ['203.0.113.9', '[2001:db8::9]:*'], lookup, dial, localAddrs: () => [], onDeny: () => {} })
    expect((await connectReq(p.port, '203.0.113.9:443')).status).toBe(200)
    expect((await connectReq(p.port, '[2001:DB8::9]:22')).status).toBe(200)
    expect(calls).toEqual([['203.0.113.9', 443], ['2001:db8::9', 22]])
    for (const t of ['127.0.0.1:443', '0x7f.1:443', '2130706433:443', '[::1]:443', '[::ffff:10.0.0.1]:443', '169.254.169.254:80', '203.0.113.10:443']) {
      expect((await connectReq(p.port, t)).status, t).toBe(403)
    }
    expect(calls.length).toBe(2)
    expect(lookups).toEqual([])
    expect(p.denies.map(d => d.host)).toEqual(['127.0.0.1', '127.0.0.1', '127.0.0.1', '::1', '::ffff:a00:1', '169.254.169.254', '203.0.113.10'])
  })

  it('a lookup failure without an upstream → 502; dial errors → 502', async () => {
    const { lookup } = fakeLookup({ 'down.test': [PUBLIC] })
    const p = await proxy({
      allow: () => [...NPM, 'down.test'],
      lookup,
      dial: () => connect(1, '127.0.0.1'), // 端口 1 无人监听 → ECONNREFUSED
      onDeny: () => {},
    })
    expect((await connectReq(p.port, 'registry.npmjs.org:443')).status).toBe(502)
    expect((await connectReq(p.port, 'down.test:443')).status).toBe(502)
    expect(p.denies).toEqual([])
  })

  it('a dial that never connects → 502 after connectTimeoutMs', async () => {
    const { lookup } = fakeLookup({ 'slow.test': [PUBLIC] })
    const { Socket: NetSocket } = await import('node:net')
    const p = await proxy({ allow: () => ['slow.test'], lookup, dial: () => new NetSocket(), connectTimeoutMs: 100, onDeny: () => {} })
    const t0 = Date.now()
    expect((await connectReq(p.port, 'slow.test:443')).status).toBe(502)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('HTTP absolute-form: forwarded in origin form, Proxy-* and hop-by-hop headers stripped', async () => {
    const origin = await fake('origin')
    const { lookup } = fakeLookup({ 'registry.npmjs.org': [PUBLIC] })
    const { dial, calls } = fakeDial(origin)
    const p = await proxy({ allow: () => NPM, lookup, dial, onDeny: () => {} })
    const res = await exchange(p.port, 'GET http://registry.npmjs.org/pkg HTTP/1.1\r\nHost: registry.npmjs.org\r\nProxy-Authorization: Basic eA==\r\nConnection: keep-alive, X-Drop\r\nX-Drop: 1\r\nX-Keep: 2\r\n\r\n')
    expect(res).toMatch(/^HTTP\/1\.1 200/)
    expect(res).toMatch(/x-origin: fake/i)
    expect(res).toMatch(/\r\n\r\nok \/pkg$/)
    expect(calls).toEqual([[PUBLIC, 80]])
    expect(origin.inner.map(i => i.line)).toEqual(['GET /pkg HTTP/1.1'])
    const h = origin.inner[0].headers
    expect(h['proxy-authorization']).toBeUndefined()
    expect(h['x-drop']).toBeUndefined()
    expect(h['x-keep']).toBe('2')
  })

  it('HTTP absolute-form to a denied host / port → 403 "denied"; bad shapes → 400', async () => {
    const origin = await fake('origin')
    const { lookup } = fakeLookup({ 'registry.npmjs.org': [PUBLIC] })
    const { dial, calls } = fakeDial(origin)
    const p = await proxy({ allow: () => NPM, lookup, dial, onDeny: () => {} })
    const denied = await exchange(p.port, 'GET http://evil.example/ HTTP/1.1\r\nHost: evil.example\r\n\r\n')
    expect(denied).toMatch(/^HTTP\/1\.1 403/)
    expect(denied).toMatch(/\r\n\r\ndenied$/)
    expect(await exchange(p.port, 'GET http://registry.npmjs.org:8080/ HTTP/1.1\r\nHost: x\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/)
    for (const line of [
      'GET /x HTTP/1.1', // 源形式
      'GET http://u:p@registry.npmjs.org/ HTTP/1.1', // userinfo
      'GET http://registry.npmjs.or%67/ HTTP/1.1', // 含 %
      'GET https://registry.npmjs.org/ HTTP/1.1',
      'GET http:///x HTTP/1.1',
      'GET http://registry.npmjs.org:0/ HTTP/1.1',
      'GET http://registry.npmjs.org:99999/ HTTP/1.1',
    ]) {
      expect(await exchange(p.port, `${line}\r\nHost: registry.npmjs.org\r\n\r\n`), line).toMatch(/^HTTP\/1\.1 400/)
    }
    for (const t of ['registry.npmjs.org', 'u@registry.npmjs.org:443', 'registry.npmjs.org:443/x', 'reg%69stry.npmjs.org:443', '::1:443', '[::1:443']) {
      expect((await connectReq(p.port, t)).status, t).toBe(400)
    }
    expect(calls).toEqual([])
    expect(p.denies.filter(d => d.reason === 'bad_request').every(d => d.host === '' || d.host === 'registry.npmjs.org')).toBe(true)
  })

  it('request smuggling: a Host header that differs from the target is ignored, the target is what gets checked and sent', async () => {
    const origin = await fake('origin')
    const { lookup } = fakeLookup({ 'registry.npmjs.org': [PUBLIC], 'evil.example': [PUBLIC] })
    const { dial, calls } = fakeDial(origin)
    const p = await proxy({ allow: () => NPM, lookup, dial, onDeny: () => {} })
    // 目标被拒,Host 是白名单里的 → 仍拒
    expect(await exchange(p.port, 'GET http://evil.example/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/)
    expect((await connectReq(p.port, 'evil.example:443', 'registry.npmjs.org:443')).status).toBe(403)
    expect(calls).toEqual([])
    // 目标允许,Host 指别处 → 按目标走,发出去的 Host 被改写成目标
    const ok = await exchange(p.port, 'GET http://registry.npmjs.org/a HTTP/1.1\r\nHost: evil.example\r\n\r\n')
    expect(ok).toMatch(/^HTTP\/1\.1 200/)
    expect(origin.inner[0].headers.host).toBe('registry.npmjs.org')
    // 同一连接上的第二个请求也要单独检查:代理回 Connection: close,不复用
    const two = await exchange(p.port, 'GET http://registry.npmjs.org/a HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\nGET http://evil.example/b HTTP/1.1\r\nHost: evil.example\r\n\r\n')
    expect(two.match(/HTTP\/1\.1 200/g)?.length).toBe(1)
    expect(origin.inner.map(i => i.line)).toEqual(['GET /a HTTP/1.1', 'GET /a HTTP/1.1'])
    expect(calls.every(([h]) => h === PUBLIC)).toBe(true)
  })

  it('a duplicate or conflicting framing header is a 400, not a second request', async () => {
    const origin = await fake('origin')
    const { dial, calls } = fakeDial(origin)
    const p = await proxy({ allow: () => NPM, lookup: fakeLookup({ 'registry.npmjs.org': [PUBLIC] }).lookup, dial, onDeny: () => {} })
    const res = await exchange(p.port, 'POST http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET http://evil.example/ HTTP/1.1\r\n\r\n')
    expect(res).toMatch(/^HTTP\/1\.1 400/)
    expect(calls).toEqual([])
  })
})

describe('startProxy — limits and lifecycle', () => {
  it('slowloris: a client that never finishes its headers is cut off after connectTimeoutMs', async () => {
    const p = await proxy({ allow: () => NPM, lookup: fakeLookup({}).lookup, connectTimeoutMs: 150, onDeny: () => {} })
    const sock = await open(p.port)
    const closed = new Promise<void>(r => sock.once('close', () => r()))
    sock.on('error', () => {})
    sock.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\n')
    // 不断地一点点写,也不延长期限
    const drip = setInterval(() => sock.write('X'), 30)
    try {
      expect(await closedWithin(closed, 2000)).toBe(true)
    } finally {
      clearInterval(drip)
    }
  })

  it('an idle tunnel is closed after tunnelIdleMs', async () => {
    const origin = await fake('origin')
    const p = await proxy({ allow: () => ['ok.test'], lookup: fakeLookup({ 'ok.test': [PUBLIC] }).lookup, dial: fakeDial(origin).dial, tunnelIdleMs: 150, onDeny: () => {} })
    const r = await connectReq(p.port, 'ok.test:443')
    expect(r.status).toBe(200)
    expect(await closedWithin(new Promise(res => r.sock.once('close', res)), 2000)).toBe(true)
  })

  it('the 65th concurrent connection → 503; a freed slot is usable again', async () => {
    const origin = await fake('origin')
    const p = await proxy({ allow: () => ['ok.test'], lookup: fakeLookup({ 'ok.test': [PUBLIC] }).lookup, dial: fakeDial(origin).dial, onDeny: () => {} })
    const tunnels = await Promise.all(Array.from({ length: 64 }, () => connectReq(p.port, 'ok.test:443')))
    expect(tunnels.every(t => t.status === 200)).toBe(true)
    const extra = await connectReq(p.port, 'ok.test:443')
    expect(extra.status).toBe(503)
    tunnels[0].sock.destroy()
    let again = 0
    for (let i = 0; i < 20 && again !== 200; i++) {
      again = (await connectReq(p.port, 'ok.test:443')).status
      if (again !== 200) await delay(20)
    }
    expect(again).toBe(200)
  })

  it('maxConns is configurable', async () => {
    const p = await proxy({ allow: () => [], maxConns: 1, onDeny: () => {} })
    const first = await open(p.port)
    first.write('CONNECT ')
    await delay(50)
    expect((await connectReq(p.port, 'x.test:443')).status).toBe(503)
  })

  it('an idle proxy with an open tunnel does not close; it closes once the tunnel ends and idleMs passes', async () => {
    const origin = await fake('origin')
    const p = await proxy({ allow: () => ['ok.test'], lookup: fakeLookup({ 'ok.test': [PUBLIC] }).lookup, dial: fakeDial(origin).dial, idleMs: 100, onDeny: () => {} })
    const r = await connectReq(p.port, 'ok.test:443')
    expect(r.status).toBe(200)
    expect(await closedWithin(p.closed, 400)).toBe(false)
    expect(await echo(r.sock, 'still here', r.rest)).toBe('still here')
    r.sock.end()
    expect(await closedWithin(p.closed, 2000)).toBe(true)
    await expect(open(p.port)).rejects.toThrow()
  })

  it('touch() postpones the idle close', async () => {
    const p = await proxy({ allow: () => [], idleMs: 150, onDeny: () => {} })
    for (let i = 0; i < 4; i++) {
      await delay(60)
      p.touch()
    }
    expect(await closedWithin(p.closed, 50)).toBe(false)
    expect(await closedWithin(p.closed, 1000)).toBe(true)
  })

  it('close() ends open tunnels and stops listening', async () => {
    const up = await fake('upstream')
    const p = await proxy({ allow: () => NPM, upstream: upstreamAt(up), lookup: fakeLookup({}).lookup, onDeny: () => {} })
    const r = await connectReq(p.port, 'registry.npmjs.org:443')
    expect(r.status).toBe(200)
    const ended = new Promise(res => r.sock.once('close', res))
    await p.close()
    expect(await closedWithin(ended, 1000)).toBe(true)
    expect(await closedWithin(p.closed, 10)).toBe(true)
    await expect(open(p.port)).rejects.toThrow()
    await p.close() // 幂等
  })

  it.skipIf(process.platform === 'win32')('the Unix-socket listener behaves the same', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mffpx-'))
    tmpDirs.push(parent)
    const up = await fake('upstream')
    const p = await proxy({ allow: () => NPM, upstream: upstreamAt(up), lookup: fakeLookup({}).lookup, unixSocket: { parent }, onDeny: () => {} })
    const unixPath = p.unixPath!
    expect(dirname(dirname(unixPath))).toBe(parent)
    expect(basename(unixPath)).toBe('net.sock')
    expect(basename(dirname(unixPath))).toMatch(/^mffai-net-/)
    expect(statSync(dirname(unixPath)).mode & 0o777).toBe(0o700)
    expect((await connectReq(unixPath, 'evil.example:443')).status).toBe(403)
    const r = await connectReq(unixPath, 'registry.npmjs.org:443')
    expect(r.status).toBe(200)
    expect(await echo(r.sock, 'over unix', r.rest)).toBe('over unix')
    expect(up.connects.map(c => c.line)).toEqual(['CONNECT registry.npmjs.org:443 HTTP/1.1'])
    await p.close()
    await expect(open(unixPath)).rejects.toThrow()
    // 只删了自己建的目录,父目录还在
    expect(existsSync(dirname(unixPath))).toBe(false)
    expect(existsSync(parent)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('works under a shared 1777 parent (Linux /tmp) and each proxy gets its own dir', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mffpx-'))
    tmpDirs.push(parent)
    chmodSync(parent, 0o1777)
    // 别人在父目录里预先放的东西不影响,也不会被删
    writeFileSync(join(parent, 'net.sock'), 'planted')
    const a = await proxy({ allow: () => [], unixSocket: { parent }, onDeny: () => {} })
    const b = await proxy({ allow: () => [], unixSocket: { parent }, onDeny: () => {} })
    expect(dirname(a.unixPath!)).not.toBe(dirname(b.unixPath!))
    expect(statSync(dirname(a.unixPath!)).mode & 0o777).toBe(0o700)
    expect((await connectReq(a.unixPath!, 'x.test:443')).status).toBe(403)
    await a.close()
    await b.close()
    expect(readdirSync(parent)).toEqual(['net.sock'])
  })

  it.skipIf(process.platform === 'win32')('the socket dir defaults to os.tmpdir() and is removed on close', async () => {
    const p = await proxy({ allow: () => [], unixSocket: {}, onDeny: () => {} })
    expect(dirname(dirname(p.unixPath!))).toBe(tmpdir())
    await p.close()
    expect(existsSync(dirname(p.unixPath!))).toBe(false)
  })
})

describe('startProxy — hostile peers (review fixes)', () => {
  it('an origin reason phrase with a control byte does not crash the worker; the phrase is not passed on', async () => {
    const origin = await fake('origin', { reply: 'HTTP/1.1 200 O\x01K\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi' })
    const p = await proxy({ allow: () => NPM, lookup: fakeLookup({ 'registry.npmjs.org': [PUBLIC] }).lookup, dial: fakeDial(origin).dial, onDeny: () => {} })
    const res = await exchange(p.port, 'GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n')
    expect(res).toMatch(/^HTTP\/1\.1 (200 OK|502 Bad Gateway)\r\n/)
    expect(res).not.toContain('\x01')
    // 代理还活着
    expect((await connectReq(p.port, 'registry.npmjs.org:443')).status).toBe(200)
  })

  it('a 101 from the origin → 502 and the client connection closes', async () => {
    const origin = await fake('origin', { reply: 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n' })
    const p = await proxy({ allow: () => NPM, lookup: fakeLookup({ 'registry.npmjs.org': [PUBLIC] }).lookup, dial: fakeDial(origin).dial, onDeny: () => {} })
    const res = await exchange(p.port, 'GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    expect(res).toMatch(/^HTTP\/1\.1 502/)
  })

  it('an upstream 200 with an empty reason phrase is accepted', async () => {
    const up = await fake('upstream', { established: 'HTTP/1.1 200 ' })
    const p = await proxy({ allow: () => NPM, upstream: upstreamAt(up), lookup: fakeLookup({}).lookup, onDeny: () => {} })
    const r = await connectReq(p.port, 'registry.npmjs.org:443')
    expect(r.status).toBe(200)
    expect(await echo(r.sock, 'bare', r.rest)).toBe('bare')
    const up2 = await fake('upstream', { established: 'HTTP/1.1 200' })
    const p2 = await proxy({ allow: () => NPM, upstream: upstreamAt(up2), lookup: fakeLookup({}).lookup, onDeny: () => {} })
    expect((await connectReq(p2.port, 'registry.npmjs.org:443')).status).toBe(200)
  })

  it('a CONNECT pipelined after a denied GET is not served', async () => {
    const origin = await fake('origin')
    const { dial, calls } = fakeDial(origin)
    const p = await proxy({ allow: () => ['ok.test'], lookup: fakeLookup({ 'ok.test': [PUBLIC] }).lookup, dial, onDeny: () => {} })
    const res = await exchange(p.port, 'GET http://evil.test/ HTTP/1.1\r\nHost: evil.test\r\n\r\nCONNECT ok.test:443 HTTP/1.1\r\nHost: ok.test:443\r\n\r\n')
    expect(res).toMatch(/^HTTP\/1\.1 403/)
    expect(res).not.toContain('200')
    await delay(50)
    expect(calls).toEqual([])
  })

  it('denied connections give up their slot and are closed by the proxy even if the client never closes', async () => {
    const p = await proxy({ allow: () => [], maxConns: 2, onDeny: () => {} })
    const held: Socket[] = []
    for (let i = 0; i < 2; i++) {
      const s = await new Promise<Socket>((resolve) => {
        const c = connect({ port: p.port, host: '127.0.0.1', allowHalfOpen: true }, () => resolve(c))
        clients.add(c)
        c.on('error', () => {})
        c.resume()
      })
      s.write('CONNECT evil.test:443 HTTP/1.1\r\nHost: evil.test:443\r\n\r\n')
      held.push(s)
    }
    await delay(50)
    // 名额已让出:第三个连接拿到 403 而不是 503
    expect((await connectReq(p.port, 'evil.test:443')).status).toBe(403)
    const ended = held.map(s => new Promise<boolean>(r => (s.readableEnded ? r(true) : s.once('end', () => r(true)))))
    expect(await closedWithin(Promise.all(ended), 2000)).toBe(true)
  })

  it('a flood of connections over the limit that never close does not pile up sockets in the proxy', async () => {
    const p = await proxy({ allow: () => [], maxConns: 4, onDeny: () => {} })
    const sockCount = () => process.getActiveResourcesInfo().filter(r => r === 'TCPSocketWrap').length
    const base = sockCount()
    const N = 200
    await Promise.all(Array.from({ length: N }, () => new Promise<void>((resolve) => {
      const c = connect({ port: p.port, host: '127.0.0.1', allowHalfOpen: true }, () => resolve())
      clients.add(c)
      c.on('error', () => resolve())
    })))
    // 客户端这一侧的 N 个都还开着;代理那一侧只该剩下名额内的 4 个
    await waitFor(() => sockCount() - base <= N + 4, 3000)
    expect(sockCount() - base).toBeLessThanOrEqual(N + 4)
  })
})

describe('upstreamFromEnv', () => {
  it('prefers HTTPS_PROXY, then https_proxy, HTTP_PROXY, http_proxy', () => {
    expect(upstreamFromEnv({ HTTPS_PROXY: 'http://a:1', http_proxy: 'http://b:2' }).upstream!.url.host).toBe('a:1')
    expect(upstreamFromEnv({ https_proxy: 'http://a:1', HTTP_PROXY: 'http://b:2' }).upstream!.url.host).toBe('a:1')
    expect(upstreamFromEnv({ HTTP_PROXY: 'http://b:2' }).upstream!.url.host).toBe('b:2')
    expect(upstreamFromEnv({ http_proxy: 'http://b:2' }).upstream!.url.host).toBe('b:2')
    expect(upstreamFromEnv({ HTTPS_PROXY: '127.0.0.1:7890' }).upstream!.url.host).toBe('127.0.0.1:7890')
    expect(upstreamFromEnv({})).toEqual({})
    expect(upstreamFromEnv({ HTTPS_PROXY: '' })).toEqual({})
  })

  it('only http: is accepted; socks only → no upstream plus a warning', () => {
    expect(upstreamFromEnv({ HTTPS_PROXY: 'socks5://127.0.0.1:7891' })).toEqual({ warning: 'socks_upstream_unsupported' })
    expect(upstreamFromEnv({ ALL_PROXY: 'socks5h://127.0.0.1:7891' })).toEqual({ warning: 'socks_upstream_unsupported' })
    expect(upstreamFromEnv({ HTTPS_PROXY: 'socks5://127.0.0.1:7891', HTTP_PROXY: 'http://127.0.0.1:7890' }).upstream!.url.host).toBe('127.0.0.1:7890')
    expect(upstreamFromEnv({ HTTPS_PROXY: 'https://proxy.example:443' })).toEqual({})
    expect(upstreamFromEnv({ HTTPS_PROXY: 'http://' })).toEqual({})
  })

  it('percent-encoded userinfo is decoded before Basic encoding', () => {
    const { upstream } = upstreamFromEnv({ HTTPS_PROXY: 'http://us%40er:p%3Ass@proxy.example:8080' })
    expect(Buffer.from(upstream!.auth!, 'base64').toString()).toBe('us@er:p:ss')
    expect(upstream!.url.href).toBe('http://proxy.example:8080/')
    expect(upstreamFromEnv({ HTTPS_PROXY: 'http://proxy.example:8080' }).upstream!.auth).toBeUndefined()
  })

  it('NO_PROXY: suffix, leading-dot, wildcard, port-stripped, IP and CIDR entries', () => {
    const np = upstreamFromEnv({ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'example.com, .corp.test,*.wild.test, svc.test:8080, 203.0.113.9, 10.0.0.0/8, [2001:db8::]/32' }).upstream!.noProxy
    expect(np('example.com')).toBe(true)
    expect(np('a.example.com')).toBe(true)
    expect(np('notexample.com')).toBe(false)
    expect(np('corp.test')).toBe(true)
    expect(np('x.corp.test')).toBe(true)
    expect(np('x.wild.test')).toBe(true)
    expect(np('svc.test')).toBe(true)
    expect(np('203.0.113.9')).toBe(true)
    expect(np('203.0.113.10')).toBe(false)
    expect(np('10.1.2.3')).toBe(true)
    expect(np('2001:db8::1')).toBe(true)
    expect(np('registry.npmjs.org')).toBe(false)
    // CIDR 不套到域名上
    expect(upstreamFromEnv({ HTTPS_PROXY: 'http://p:1', no_proxy: '0.0.0.0/0' }).upstream!.noProxy('example.com')).toBe(false)
    expect(upstreamFromEnv({ HTTPS_PROXY: 'http://p:1', no_proxy: '*' }).upstream!.noProxy('anything.test')).toBe(true)
    expect(upstreamFromEnv({ HTTPS_PROXY: 'http://p:1' }).upstream!.noProxy('example.com')).toBe(false)
  })
})
