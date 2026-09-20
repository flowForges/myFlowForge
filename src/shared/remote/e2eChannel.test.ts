import { describe, expect, it, vi } from 'vitest'
import { generateIdentity, seal, type Session } from './e2e'
import { clientE2ELink, hostE2ELink } from './e2eChannel'
import type { Channel } from './channel'

/** 一条假线路:记下发出去的原始文本和关闭码。 */
function wire() {
  const sentRaw: string[] = []
  const closes: { code: number; reason: string }[] = []
  const logs: string[] = []
  return {
    sentRaw,
    closes,
    logs,
    w: {
      sendRaw: (t: string) => sentRaw.push(t),
      closeRaw: (code: number, reason: string) => closes.push({ code, reason }),
      onLog: (m: string) => logs.push(m),
    },
  }
}

/**
 * 把 host 和 client 两条 link 直接对接起来,中间**不经过任何东西** ——
 * 这就是"中转是哑管道"在测试里的样子:它搬什么都行,搬对了两边就通。
 */
function pair() {
  const identity = generateIdentity()
  const hw = wire()
  const cw = wire()
  let hostCh: Channel | null = null
  let clientCh: Channel | null = null
  const hostMsgs: string[] = []
  const clientMsgs: string[] = []

  const host = hostE2ELink(identity, hw.w, (ch) => {
    hostCh = ch
    ch.onMessage((t) => hostMsgs.push(t))
  })
  const failures: string[] = []
  const client = clientE2ELink(identity.publicKey, cw.w, (ch) => {
    clientCh = ch
    ch.onMessage((t) => clientMsgs.push(t))
  }, (w) => failures.push(w))

  /** 把一边攒下的原始帧搬给另一边。 */
  const pump = () => {
    for (const raw of cw.sentRaw.splice(0)) host.receive(raw)
    for (const raw of hw.sentRaw.splice(0)) client.receive(raw)
  }

  return { identity, host, client, hw, cw, pump, hostMsgs, clientMsgs, failures,
    hostCh: () => hostCh, clientCh: () => clientCh }
}

describe('e2eChannel · 握手', () => {
  it('★握完手两边才各自拿到 Channel', () => {
    const p = pair()
    // 客户端一造出来就把 hs-init 放到线上了,但它自己还没有 Channel
    expect(p.clientCh()).toBeNull()
    expect(p.hostCh()).toBeNull()
    p.pump()          // hs-init → host,host 回 hs-reply
    expect(p.hostCh()).not.toBeNull()
    p.pump()          // hs-reply → client
    expect(p.clientCh()).not.toBeNull()
  })

  it('★★hs-reply 必须排在 host 的第一帧业务数据之前 —— 否则对面还没有密钥,那一帧直接丢', () => {
    const p = pair()
    // ★只搬 client → host 这一个方向,好让 host 发出去的东西**留在线上**给我们看顺序。
    //  用 pump() 的话它会顺手把 host 那一侧也搬空。
    for (const raw of p.cw.sentRaw.splice(0)) p.host.receive(raw)
    // host 拿到 Channel 之后立刻发一帧(真实里就是 serveConnection 的 hello)
    p.hostCh()!.send('{"t":"hello"}')
    // 线上第一帧是 hs-reply,第二帧才是密文
    const [first, second] = p.hw.sentRaw
    expect(JSON.parse(first).t).toBe('hs-reply')
    expect(JSON.parse(second).t).toBe('enc')
  })

  it('双向都通,而且线上没有明文', () => {
    const p = pair()
    p.pump(); p.pump()
    p.clientCh()!.send('{"t":"req","ch":"chat:send"}')
    p.pump()
    expect(p.hostMsgs).toEqual(['{"t":"req","ch":"chat:send"}'])

    p.hostCh()!.send('{"t":"res","ok":true}')
    p.pump()
    expect(p.clientMsgs).toEqual(['{"t":"res","ok":true}'])
  })

  it('★★线上的每一帧都是密文 —— 这是「中转读不到内容」的唯一硬证据', () => {
    const p = pair()
    p.pump(); p.pump()
    p.clientCh()!.send('{"t":"req","ch":"chat:send","args":["删掉 build"]}')
    const onWire = p.cw.sentRaw[p.cw.sentRaw.length - 1]
    expect(onWire).not.toContain('chat:send')
    expect(onWire).not.toContain('删掉 build')
    expect(JSON.parse(onWire).t).toBe('enc')
  })

  it('★★客户端拿的是**配对时那把**公钥验签,换一把就必须失败', () => {
    const other = generateIdentity()
    const identity = generateIdentity()
    const hw = wire()
    const cw = wire()
    const failures: string[] = []
    const host = hostE2ELink(identity, hw.w, () => {})
    // 客户端信的是 `other`,而对面是 `identity` —— 冒充场景
    const client = clientE2ELink(other.publicKey, cw.w, () => {}, (w) => failures.push(w))
    for (const raw of cw.sentRaw.splice(0)) host.receive(raw)
    for (const raw of hw.sentRaw.splice(0)) client.receive(raw)
    expect(failures).toHaveLength(1)
    expect(cw.closes[0].code).toBe(4401)
    void client
  })

  it('★验不过不重试、不降级 —— 一次就断', () => {
    const cw = wire()
    const onReady = vi.fn()
    const link = clientE2ELink(generateIdentity().publicKey, cw.w, onReady)
    link.receive(JSON.stringify({ t: 'hs-reply', epk: 'AAAA', sig: 'BBBB' }))
    expect(onReady).not.toHaveBeenCalled()
    expect(cw.closes).toHaveLength(1)
  })

  it('★对面回的是明文 hello(旧版本的网关)时,说的是「版本太老」而不是「形状不对」', () => {
    // 走到这儿最常见的一种就是它:2026-09-02 之前的局域网网关不会握手,只会回明文 hello。
    // 「形状不对」是症状,「把那台升级一下」才是用户能照做的事。
    const cw = wire()
    const failures: string[] = []
    const link = clientE2ELink(generateIdentity().publicKey, cw.w, () => {}, (w) => failures.push(w))
    link.receive(JSON.stringify({ t: 'hello', protocol: 1, version: '1.2.0', authRequired: false }))
    expect(failures[0]).toContain('版本太老')
    void link
  })

  it('host 的第一帧不是 hs-init 就断 —— 加密之前不给对面说话的机会', () => {
    for (const first of ['{"t":"req","id":1}', '{', 'null', '{"t":"hs-init"}', '{"t":"enc","c":"AAAA"}']) {
      const hw = wire()
      const link = hostE2ELink(generateIdentity(), hw.w, () => {})
      link.receive(first)
      expect(hw.closes[0]?.code, first).toBe(4400)
    }
  })

  it('epk 长度不对(不是一把真公钥)也要断', () => {
    const hw = wire()
    hostE2ELink(generateIdentity(), hw.w, () => {}).receive(JSON.stringify({ t: 'hs-init', epk: 'AAAA' }))
    expect(hw.closes[0].code).toBe(4400)
  })
})

describe('e2eChannel · 解不开的帧', () => {
  it('★★被改过 / 重放 / 不是这把密钥 —— 一律丢掉,**不断线**', () => {
    const p = pair()
    p.pump(); p.pump()
    p.clientCh()!.send('第一条')
    const good = p.cw.sentRaw[p.cw.sentRaw.length - 1]
    p.pump()
    expect(p.hostMsgs).toEqual(['第一条'])

    // ① 原样重放
    p.host.receive(good)
    // ② 改一个字节
    const tampered = JSON.parse(good)
    tampered.c = tampered.c.slice(0, -4) + (tampered.c.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA')
    p.host.receive(JSON.stringify(tampered))
    // ③ 别人的密钥
    const alien: Session = { key: new Uint8Array(32).fill(3), sendDir: 0, recvDir: 1, sendCounter: 0, lastRecvCounter: -1 }
    p.host.receive(JSON.stringify(seal(alien, '我是冒充的')!))
    // ④ 干脆不是 JSON
    p.host.receive('不是 JSON')
    // ⑤ 形状不对
    p.host.receive('{"t":"nope"}')

    // 一条都没进来,而且**连接还活着** —— 断掉的话,谁都能靠灌垃圾把这条链路弄断
    expect(p.hostMsgs).toEqual(['第一条'])
    expect(p.hw.closes).toHaveLength(0)

    // 而且真的还能继续正常收发
    p.clientCh()!.send('第二条')
    p.pump()
    expect(p.hostMsgs).toEqual(['第一条', '第二条'])
  })

  it('★丢掉的帧不能把接收窗口顶上去 —— 否则灌垃圾就能让后面合法的帧全被当成重放', () => {
    const p = pair()
    p.pump(); p.pump()
    const alien: Session = { key: new Uint8Array(32).fill(3), sendDir: 0, recvDir: 1, sendCounter: 500, lastRecvCounter: -1 }
    p.host.receive(JSON.stringify(seal(alien, 'x')!))   // 计数器 500 的垃圾
    p.clientCh()!.send('正常的一条')                      // 计数器 0
    p.pump()
    expect(p.hostMsgs).toEqual(['正常的一条'])
  })
})

describe('e2eChannel · 关闭', () => {
  it('closed() 会通知上层(sink 靠它摘掉)', () => {
    const p = pair()
    p.pump(); p.pump()
    const seen: string[] = []
    p.hostCh()!.onClose(() => seen.push('closed'))
    p.host.closed()
    expect(seen).toEqual(['closed'])
  })

  it('还没握完手就断,不抛', () => {
    const hw = wire()
    const link = hostE2ELink(generateIdentity(), hw.w, () => {})
    expect(() => link.closed()).not.toThrow()
  })

  it('Channel.close 落到线路上', () => {
    const p = pair()
    p.pump(); p.pump()
    p.hostCh()!.close(4403, 'bad token')
    expect(p.hw.closes[0]).toEqual({ code: 4403, reason: 'bad token' })
  })
})
