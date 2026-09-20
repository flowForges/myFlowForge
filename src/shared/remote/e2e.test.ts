import { describe, it, expect } from 'vitest'
import nacl from 'tweetnacl'
import {
  DIR_CLIENT_TO_HOST,
  DIR_HOST_TO_CLIENT,
  MAX_COUNTER,
  bytesToUtf8,
  clientHandshakeFinish,
  clientHandshakeInit,
  fromBase64,
  generateIdentity,
  hostHandshakeReply,
  open,
  seal,
  toBase64,
  utf8ToBytes,
  type Session,
} from './e2e'
import { buildPairingLink, parsePairingLink } from './pairingLink'

/**
 * ★这一层的断言不是照着实现写的,是照着**攻击者会做什么**写的:
 *  改一个字节、把密文重放一遍、把别的会话的握手搬过来、自签一对公钥冒充 daemon。
 *  每一条都必须被挡住,而且是**默默挡住**(返回 null),不是抛异常 ——
 *  抛异常就等于给了对面一个谁都能触发的拒绝服务。
 */

/** 跑完一次完整握手,拿到两端的会话。 */
function handshake() {
  const id = generateIdentity()
  const { pending, frame: init } = clientHandshakeInit()
  const hostSide = hostHandshakeReply(id, init)!
  const clientSide = clientHandshakeFinish(pending, hostSide.frame, id.publicKey)!
  return { id, client: clientSide, host: hostSide.session, pending, reply: hostSide.frame }
}

describe('base64 —— 三种运行时都要能跑,所以自己实现', () => {
  it('往返', () => {
    for (const n of [0, 1, 2, 3, 4, 31, 32, 33, 255]) {
      const b = nacl.randomBytes(n)
      expect(Array.from(fromBase64(toBase64(b))!)).toEqual(Array.from(b))
    }
  })

  it('★非法字符必须整条拒绝,不能跳过它继续解', () => {
    // 悄悄跳过非法字符 = 把一段垃圾解成「差不多」的字节,然后拿去当密文用。
    expect(fromBase64('AAAA!AAA')).toBeNull()
    expect(fromBase64('AA AA')).toBeNull()
    expect(fromBase64('中文')).toBeNull()
  })

  it('★长度余 1 是不可能的 base64', () => {
    expect(fromBase64('A')).toBeNull()
    expect(fromBase64('AAAAA')).toBeNull()
  })

  it('空串是空字节,不是 null', () => {
    expect(fromBase64('')).toEqual(new Uint8Array(0))
  })
})

describe('utf8 —— 同样不依赖 TextEncoder', () => {
  it('ASCII / 中文 / emoji(代理对)都要往返', () => {
    for (const s of ['', 'hello', '握手完成前拒绝执行任何命令', '🛡️ 门 · gate', 'a🛡b中c']) {
      expect(bytesToUtf8(utf8ToBytes(s))).toBe(s)
    }
  })
})

describe('配对链接搬的就是这把公钥', () => {
  // ★配对链接本身的解析规则在 `pairingLink.test.ts` 里钉(那份是电脑端和手机端**真正**在用的)。
  //  这里只钉一件那边钉不到的事:**一把真的 Ed25519 公钥,搬一趟回来必须一个字节都不差**。
  //  那边用的是合成的 base64 串,而真钥匙里会出现 `+` `/` `=` —— 它们恰好是 query 里的特殊字符。
  it('★★真公钥往返:字节级相等', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateIdentity()
      const link = buildPairingLink({
        address: '192.168.1.10:6789',
        token: 'tok',
        label: '我的 MacBook',
        pubKey: toBase64(id.publicKey),
      })
      const r = parsePairingLink(link)
      expect(r.ok, link).toBe(true)
      if (!r.ok) return
      const back = fromBase64(r.value.pubKey!)
      expect(back, link).not.toBeNull()
      expect(Array.from(back!), link).toEqual(Array.from(id.publicKey))
    }
  })

  it('★★搬回来的公钥要真能用来验签 —— 往返"看起来对"不等于"能验"', () => {
    const id = generateIdentity()
    const r = parsePairingLink(buildPairingLink({ address: 'x:1', token: '', label: '', pubKey: toBase64(id.publicKey) }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const trusted = fromBase64(r.value.pubKey!)!
    const { pending, frame: init } = clientHandshakeInit()
    const hostSide = hostHandshakeReply(id, init)!
    expect(clientHandshakeFinish(pending, hostSide.frame, trusted)).not.toBeNull()
  })
})

describe('握手', () => {
  it('两端算出来的是同一把会话密钥', () => {
    const { client, host } = handshake()
    expect(Array.from(client.key)).toEqual(Array.from(host.key))
  })

  it('方向是相反的', () => {
    const { client, host } = handshake()
    expect(client.sendDir).toBe(DIR_CLIENT_TO_HOST)
    expect(client.recvDir).toBe(DIR_HOST_TO_CLIENT)
    expect(host.sendDir).toBe(DIR_HOST_TO_CLIENT)
    expect(host.recvDir).toBe(DIR_CLIENT_TO_HOST)
  })

  it('★★换一把公钥就验不过 —— 冒充者自签一对是没用的', () => {
    const { pending, frame: init } = clientHandshakeInit()
    const impostor = generateIdentity()
    const reply = hostHandshakeReply(impostor, init)!
    const real = generateIdentity()
    // 客户端信的是 real 的公钥(从配对链接来的),冒充者用自己的私钥签
    expect(clientHandshakeFinish(pending, reply.frame, real.publicKey)).toBeNull()
    // 而如果拿对面自报的公钥去验对面的签名,就会「通过」—— 那等于没验
    expect(clientHandshakeFinish(pending, reply.frame, impostor.publicKey)).not.toBeNull()
  })

  it('★★签名覆盖两个一次性公钥:别的会话的 reply 搬过来必须失败', () => {
    // 这正是「只签自己那个公钥」会漏掉的攻击:
    // 中间人录下 daemon 在会话 A 里发的 reply(他手里有会话 A 的一次性私钥),
    // 在会话 B 里原样重放。如果签名只覆盖 daemon 自己的公钥,B 的客户端会验过 ——
    // 于是中间人拿着 A 的私钥完全接管了 B。
    const id = generateIdentity()
    const a = clientHandshakeInit()
    const b = clientHandshakeInit()
    const replyForA = hostHandshakeReply(id, a.frame)!
    // 把给 A 的 reply 搬给 B
    expect(clientHandshakeFinish(b.pending, replyForA.frame, id.publicKey)).toBeNull()
    // 给 A 自己用是好的
    expect(clientHandshakeFinish(a.pending, replyForA.frame, id.publicKey)).not.toBeNull()
  })

  it('★签名被改一个字节就验不过', () => {
    const { pending, reply, id } = handshake()
    const sig = fromBase64(reply.sig)!
    sig[0] ^= 1
    expect(clientHandshakeFinish(pending, { ...reply, sig: toBase64(sig) }, id.publicKey)).toBeNull()
  })

  it('★一次性公钥被改就验不过(签名和它绑着)', () => {
    const { pending, reply, id } = handshake()
    const epk = fromBase64(reply.epk)!
    epk[0] ^= 1
    expect(clientHandshakeFinish(pending, { ...reply, epk: toBase64(epk) }, id.publicKey)).toBeNull()
  })

  it('★长度不对的输入一律 null,不许抛', () => {
    const id = generateIdentity()
    expect(hostHandshakeReply(id, { t: 'hs-init', epk: 'AAAA' })).toBeNull()
    expect(hostHandshakeReply(id, { t: 'hs-init', epk: '!!!!' })).toBeNull()
    const { pending, reply } = handshake()
    expect(clientHandshakeFinish(pending, { ...reply, epk: 'AAAA' }, id.publicKey)).toBeNull()
    expect(clientHandshakeFinish(pending, { ...reply, sig: 'AAAA' }, id.publicKey)).toBeNull()
    expect(clientHandshakeFinish(pending, reply, new Uint8Array(5))).toBeNull()
  })

  it('★★★前向保密:事后拿到长期私钥,也解不开当初录下的流量', () => {
    // ★这一条是「每次密钥都不同」那条**钉不住**的。即使 daemon 图省事拿长期私钥直接做 ECDH,
    //  客户端那半仍然是一次性的,会话密钥照样每次不同 —— 那条断言照样绿。
    //  而前向保密真正要的是这件事:密钥泄露之后,历史流量依然是安全的。
    const id = generateIdentity()
    const { pending, frame: init } = clientHandshakeInit()
    const h = hostHandshakeReply(id, init)!
    const client = clientHandshakeFinish(pending, h.frame, id.publicKey)!
    // 中间人在链路上录下:握手两帧(明文的)+ 一条密文
    const recorded = seal(client, 'rm -rf /Users/zghua/work')!

    // ——— 时间流逝。daemon 那台机器被拿下,长期私钥泄露 ———
    // 攻击者现在手里有:长期私钥、录下的握手帧、录下的密文。他能算出什么?
    const leakedBoxSecret = id.secretKey.subarray(0, 32)
    const clientEpk = fromBase64(init.epk)!
    const attacker: Session = {
      key: nacl.box.before(clientEpk, leakedBoxSecret),
      sendDir: DIR_HOST_TO_CLIENT,
      recvDir: DIR_CLIENT_TO_HOST,
      sendCounter: 0,
      lastRecvCounter: -1,
    }
    // 解不开 —— 因为真正的会话密钥用的是 daemon 那把**一次性**私钥,
    // 而它从没出现在任何一帧里,也没有落过盘。
    expect(open(attacker, recorded)).toBeNull()
  })

  it('★daemon 的一次性公钥每次都变(它没在复用长期密钥)', () => {
    const id = generateIdentity()
    const epks = new Set<string>()
    for (let i = 0; i < 5; i++) epks.add(hostHandshakeReply(id, clientHandshakeInit().frame)!.frame.epk)
    expect(epks.size).toBe(5)
  })

  it('每次握手的会话密钥都不同', () => {
    const id = generateIdentity()
    const keys = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const { pending, frame } = clientHandshakeInit()
      const h = hostHandshakeReply(id, frame)!
      keys.add(toBase64(clientHandshakeFinish(pending, h.frame, id.publicKey)!.key))
    }
    expect(keys.size).toBe(5)
  })
})

describe('收发', () => {
  it('往返', () => {
    const { client, host } = handshake()
    const enc = seal(client, '{"t":"req","id":1,"ch":"chat:send"}')!
    expect(open(host, enc)).toBe('{"t":"req","id":1,"ch":"chat:send"}')
  })

  it('中文和 emoji 也要能过', () => {
    const { client, host } = handshake()
    const msg = '代理停在门上,回答后从这里继续 🛡'
    expect(open(host, seal(client, msg)!)).toBe(msg)
  })

  it('★密文里看不到明文', () => {
    const { client } = handshake()
    const enc = seal(client, 'rm -rf /Users/zghua/work')!
    expect(enc.c).not.toContain('rm -rf')
    expect(bytesToUtf8(fromBase64(enc.c)!)).not.toContain('rm -rf')
  })

  it('★★改一个字节就解不开(中转改不了内容而不被发现)', () => {
    const { client, host } = handshake()
    const enc = seal(client, 'hello')!
    const raw = fromBase64(enc.c)!
    raw[raw.length - 1] ^= 1
    expect(open(host, { t: 'enc', c: toBase64(raw) })).toBeNull()
  })

  it('★★重放同一条必须被拒', () => {
    const { client, host } = handshake()
    const enc = seal(client, 'allow')!
    expect(open(host, enc)).toBe('allow')
    // 中转把这条原样再发一遍 —— 比如把一条「允许执行」重放成两次
    expect(open(host, enc)).toBeNull()
  })

  it('★★倒退的计数器也要拒(不只是相等)', () => {
    const { client, host } = handshake()
    const a = seal(client, 'one')!
    const b = seal(client, 'two')!
    expect(open(host, b)).toBe('two')
    expect(open(host, a)).toBeNull()
  })

  it('★★解不开的帧不能推进接收窗口', () => {
    // 否则对面发个垃圾就能把窗口顶到很高,之后合法的帧全被当重放丢掉 —— 谁都能触发的拒绝服务。
    const { client, host } = handshake()
    const good = seal(client, 'first')!
    const raw = fromBase64(good.c)!
    // 编一条计数器很大但解不开的
    const evil = new Uint8Array(raw.length)
    evil.set(raw)
    evil[0] = 0xff
    evil[1] = 0xff
    expect(open(host, { t: 'enc', c: toBase64(evil) })).toBeNull()
    // 合法的那条照样进得来
    expect(open(host, good)).toBe('first')
  })

  it('★★自己发出去的帧被弹回来,自己解不开(方向字节的作用)', () => {
    const { client, host } = handshake()
    const fromClient = seal(client, 'ping')!
    // 中转把 client 发的帧原样弹回给 client
    const echo: Session = { ...client, key: client.key, lastRecvCounter: -1 }
    expect(open(echo, fromClient)).toBeNull()
    // 而 host 是收得到的
    expect(open(host, fromClient)).toBe('ping')
  })

  it('★别的会话的密钥解不开这条', () => {
    const a = handshake()
    const b = handshake()
    const enc = seal(a.client, 'secret')!
    expect(open(b.host, enc)).toBeNull()
  })

  it('双向各自计数,互不干扰', () => {
    const { client, host } = handshake()
    expect(open(host, seal(client, 'c1')!)).toBe('c1')
    expect(open(client, seal(host, 'h1')!)).toBe('h1')
    expect(open(host, seal(client, 'c2')!)).toBe('c2')
    expect(open(client, seal(host, 'h2')!)).toBe('h2')
  })

  it('坏 base64 / 太短的帧一律 null,不许抛', () => {
    const { host } = handshake()
    expect(open(host, { t: 'enc', c: '!!!!' })).toBeNull()
    expect(open(host, { t: 'enc', c: '' })).toBeNull()
    expect(open(host, { t: 'enc', c: toBase64(new Uint8Array(3)) })).toBeNull()
  })

  it('★计数器到顶就不再封,逼调用方重新握手(回绕 = nonce 重用 = 明文可恢复)', () => {
    const { client } = handshake()
    client.sendCounter = MAX_COUNTER + 1
    expect(seal(client, 'x')).toBeNull()
  })

  it('大消息也能过(终端输出那种)', () => {
    const { client, host } = handshake()
    const big = 'x'.repeat(200_000)
    expect(open(host, seal(client, big)!)).toBe(big)
  })
})
