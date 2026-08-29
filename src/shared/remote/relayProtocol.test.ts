import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  decodeClientInbound,
  decodeHostInbound,
  encodeRelayFrame,
  roomIdFrom,
  RELAY_PROTOCOL_VERSION,
  HostHelloFrame,
  ClientHelloFrame,
} from './relayProtocol'

const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())

describe('relayProtocol · 房间号', () => {
  it('★同一把公钥两端各自算,必须得到同一个房间号 —— 这是「不需要注册流程」的全部依据', () => {
    const pub = new Uint8Array(32).fill(7)
    expect(roomIdFrom(sha256, pub)).toBe(roomIdFrom(sha256, pub))
  })

  it('★不同公钥不同房间(否则两台 daemon 会撞进同一个房间,互相顶掉)', () => {
    const a = new Uint8Array(32).fill(1)
    const b = new Uint8Array(32).fill(2)
    expect(roomIdFrom(sha256, a)).not.toBe(roomIdFrom(sha256, b))
  })

  it('★是 base64url:不含 + / =,因为房间号会进 URL 路径(Cloudflare 适配器按路径路由)', () => {
    // 找一把 sha256 里确实带高位字节的公钥,确保真的触发过转义
    for (let i = 0; i < 40; i++) {
      const id = roomIdFrom(sha256, new Uint8Array(32).fill(i))
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('★房间号不能把公钥漏出去 —— 它是哈希,不是编码', () => {
    const pub = new Uint8Array(32).fill(9)
    const id = roomIdFrom(sha256, pub)
    // base64 直编的话会是 44 字符且能解回原字节;这里是 sha256 的 43 字符
    expect(id).toHaveLength(43)
    expect(id).not.toBe(Buffer.from(pub).toString('base64url'))
  })
})

describe('relayProtocol · 解帧', () => {
  it('host 能收 host-ok / open / close / data / error', () => {
    for (const f of [
      { t: 'host-ok' },
      { t: 'open', cid: 'c1' },
      { t: 'close', cid: 'c1' },
      { t: 'data', cid: 'c1', d: '{"t":"req"}' },
      { t: 'error', error: '房间被占了' },
    ]) {
      const r = decodeHostInbound(encodeRelayFrame(f))
      expect(r.ok, JSON.stringify(f)).toBe(true)
    }
  })

  it('★client 那一侧只认 client-ok 和 error —— 之后就是原样的既有协议,不再套信封', () => {
    expect(decodeClientInbound(encodeRelayFrame({ t: 'client-ok' })).ok).toBe(true)
    expect(decodeClientInbound(encodeRelayFrame({ t: 'error', error: 'x' })).ok).toBe(true)
    // 既有协议的帧走到这个解码器上必须**不通过** —— 通过了说明两层混在了一起
    expect(decodeClientInbound(encodeRelayFrame({ t: 'hello', protocol: 1, version: '1', authRequired: false })).ok).toBe(false)
  })

  it('坏 JSON 不抛,回一句人话', () => {
    const r = decodeHostInbound('{ 这不是 json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('不是合法 JSON')
  })

  it('★形状不对时不回详细的解析报告 —— 那等于告诉试探的人「再改哪里就能过」', () => {
    const r = decodeHostInbound(encodeRelayFrame({ t: 'data', cid: 'c1' })) // 少了 d
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('帧的形状不对')
      expect(r.error).not.toMatch(/d|required|invalid/i)
    }
  })

  it('★cid 有长度上限 —— 一个恶意中转不该能拿超长 key 撑爆 host 那张表', () => {
    const long = 'x'.repeat(65)
    expect(decodeHostInbound(encodeRelayFrame({ t: 'open', cid: long })).ok).toBe(false)
    expect(decodeHostInbound(encodeRelayFrame({ t: 'open', cid: 'x'.repeat(64) })).ok).toBe(true)
  })

  it('★空 cid 不收:它会和「没有 cid」在下游的 Map 里混起来', () => {
    expect(decodeHostInbound(encodeRelayFrame({ t: 'open', cid: '' })).ok).toBe(false)
  })

  it('开场白带版本号 —— 中转和端各自升级时要能说出「版本对不上」而不是「听不懂」', () => {
    const h = HostHelloFrame.safeParse({ t: 'host-hello', v: RELAY_PROTOCOL_VERSION, room: 'r'.repeat(43) })
    expect(h.success).toBe(true)
    const c = ClientHelloFrame.safeParse({ t: 'client-hello', v: RELAY_PROTOCOL_VERSION, room: 'r'.repeat(43) })
    expect(c.success).toBe(true)
    expect(HostHelloFrame.safeParse({ t: 'host-hello', room: 'r'.repeat(43) }).success).toBe(false)
  })

  it('★房间号有长度下限 —— 空房间号会让所有没带房间的连接撮合到一起', () => {
    expect(HostHelloFrame.safeParse({ t: 'host-hello', v: 1, room: '' }).success).toBe(false)
    expect(HostHelloFrame.safeParse({ t: 'host-hello', v: 1, room: 'short' }).success).toBe(false)
  })

  it('★`d` 是不透明字符串:中转不看,这一层也不解析 —— 密文和明文都得原样放过', () => {
    for (const d of ['{"t":"req","id":1,"ch":"x","args":[]}', 'AAAA/密文/base64==', '']) {
      const r = decodeHostInbound(encodeRelayFrame({ t: 'data', cid: 'c', d }))
      expect(r.ok).toBe(true)
      if (r.ok && r.frame.t === 'data') expect(r.frame.d).toBe(d)
    }
  })
})
