import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import {
  clientHandshakeFinish,
  clientHandshakeInit,
  generateIdentity,
  hostHandshakeReply,
  open,
  pairingLink,
  parsePairingLink,
  seal,
  toBase64,
  type Session,
} from '../../src/shared/remote/e2e'
import { startRelay, type RelayHandle } from './node'

/**
 * 端到端:**真 WebSocket + 真加密 + 真中转**,不是 mock。
 *
 * 这一组存在的理由是把两层的组合钉住 —— 加密层单测过、中转单测过,不等于
 * 「一条消息从手机出发,经过一个完全不可信的中转,能安全地到达电脑」。
 *
 * ★★最要紧的那条断言是:**中转自己看到的每一个字节都是密文**。
 *  这是「中转是不可信哑管道」这句话的唯一硬证据。
 */

let relay: RelayHandle | null = null
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try {
      s.close()
    } catch {
      /* 已经关了 */
    }
  }
  await relay?.close()
  relay = null
})

function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  sockets.push(ws)
  return new Promise((res, rej) => {
    ws.once('open', () => res(ws))
    ws.once('error', rej)
  })
}

/** 等下一条**不是**中转状态帧的消息(状态帧是中转自己发的,不属于两端的对话)。 */
function nextPayload(ws: WebSocket, timeoutMs = 4000): Promise<string> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('等消息超时')), timeoutMs)
    const on = (raw: unknown) => {
      const s = String(raw)
      try {
        if (JSON.parse(s)?.t === 'relay') return // 中转的状态帧,跳过
      } catch {
        /* 不是 JSON 就是正经载荷 */
      }
      clearTimeout(timer)
      ws.off('message', on)
      res(s)
    }
    ws.on('message', on)
  })
}

/**
 * host 那一侧:等下一条 **data 信封**,把 cid 和里面的原始载荷一起给出来。
 *
 * ★★2026-08-29 加 cid 之后,host 收到的不再是原样的字节流了 —— daemon 跟中转只有一条
 *  socket 却可能挂着两个客户端,所以中转给 host 那一侧套了一层最薄的信封
 *  `{t:'data',cid,d}`。客户端那一侧**没有**信封(它跟中转一对一),所以 `nextPayload`
 *  仍然原样可用。理由完整版在 `core.ts` 里 `HostEnvelope` 上面那段。
 */
function nextHostPayload(ws: WebSocket, timeoutMs = 4000): Promise<{ cid: string; d: string; wire: string }> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('等消息超时')), timeoutMs)
    const on = (raw: unknown) => {
      const wire = String(raw)
      let f: any
      try { f = JSON.parse(wire) } catch { return }
      if (f?.t !== 'data' || typeof f.cid !== 'string' || typeof f.d !== 'string') return
      clearTimeout(timer)
      ws.off('message', on)
      res({ cid: f.cid, d: f.d, wire })
    }
    ws.on('message', on)
  })
}

/** host 那一侧:发给某一条逻辑连接。 */
function hostSend(ws: WebSocket, cid: string, payload: unknown) {
  ws.send(JSON.stringify({ t: 'data', cid, d: JSON.stringify(payload) }))
}

function waitStatus(ws: WebSocket, want: string, timeoutMs = 4000): Promise<void> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`等不到中转状态 ${want}`)), timeoutMs)
    const on = (raw: unknown) => {
      try {
        const f = JSON.parse(String(raw))
        if (f?.t === 'relay' && f.status === want) {
          clearTimeout(timer)
          ws.off('message', on)
          res()
        }
      } catch {
        /* 忽略 */
      }
    }
    ws.on('message', on)
  })
}

describe('通过不可信中转的端到端加密链路', () => {
  it('★★一条消息从客户端出发,经中转到达 host,而中转全程只见到密文', async () => {
    // ── 电脑那边:生成长期身份,打印配对链接 ────────────────────────────
    const identity = generateIdentity()
    const room = toBase64(identity.publicKey)
    relay = await startRelay({ port: 0, host: '127.0.0.1' })

    // 人把配对链接从电脑屏幕搬到手机上 —— 这是唯一不经过网络的一步
    const link = pairingLink(identity.publicKey, `ws://127.0.0.1:${relay.port}`, '我的 MacBook')
    const paired = parsePairingLink(link)!

    // ── daemon 连上中转,占住自己的房间 ──────────────────────────────────
    const hostWs = await connect(relay.port)
    hostWs.send(JSON.stringify({ t: 'join', role: 'host', room }))
    await waitStatus(hostWs, 'waiting')

    // ── 手机连上中转,进同一个房间 ──────────────────────────────────────
    const clientWs = await connect(relay.port)
    clientWs.send(JSON.stringify({ t: 'join', role: 'client', room: toBase64(paired.publicKey) }))
    await waitStatus(clientWs, 'peer-online')

    // ── 握手。中转在中间搬,但它插不进来 ────────────────────────────────
    const { pending, frame: init } = clientHandshakeInit()
    const hostGotInit = nextHostPayload(hostWs)
    clientWs.send(JSON.stringify(init))
    const first = await hostGotInit
    const hostSide = hostHandshakeReply(identity, JSON.parse(first.d))!
    const clientGotReply = nextPayload(clientWs)
    hostSend(hostWs, first.cid, hostSide.frame)
    // ★客户端用的是**配对链接里那把公钥**验签,不是对面自报的
    const clientSession = clientHandshakeFinish(pending, JSON.parse(await clientGotReply), paired.publicKey)!
    expect(clientSession).not.toBeNull()

    // ── 发一条真会造成后果的命令 ────────────────────────────────────────
    const secret = JSON.stringify({ t: 'req', id: 1, ch: 'chat:send', args: [{ text: '删掉 build 目录' }] })
    const hostGotMsg = nextHostPayload(hostWs)
    const enc = seal(clientSession, secret)!
    clientWs.send(JSON.stringify(enc))

    const got = await hostGotMsg
    // host 解得开
    expect(open(hostSide.session, JSON.parse(got.d))).toBe(secret)
    // ★断言打在**中转真正搬的那一整串**上(信封 + 密文),不只是密文 ——
    //  信封是中转自己加的,如果哪天有人往信封里塞了明文的什么东西,这条会红。
    const onWire = got.wire

    // ★★★ 关键断言:线上那一帧里没有任何明文痕迹
    expect(onWire).not.toContain('chat:send')
    expect(onWire).not.toContain('删掉 build 目录')
    expect(onWire).not.toContain('"req"')
    // 中转看到的最外层是它自己的信封;信封里那一串必须是密文帧,不是任何别的东西
    expect(JSON.parse(onWire).t).toBe('data')
    expect(JSON.parse(got.d).t).toBe('enc')
  })

  it('★★两个客户端同时连着:各自一把会话密钥,谁的答复只有谁解得开', async () => {
    // 这一条钉的是 cid 那次改动的**全部理由**。原来 host 那一侧是广播,
    // daemon 跟中转只有一条 socket —— 两台设备的 hs-init 前后脚落在同一条流上,
    // daemon 无从分辨,两把会话密钥串在一起。而现象只是「第二台设备一直转圈」。
    const identity = generateIdentity()
    const room = toBase64(identity.publicKey)
    relay = await startRelay({ port: 0, host: '127.0.0.1' })
    const hostWs = await connect(relay.port)
    hostWs.send(JSON.stringify({ t: 'join', role: 'host', room }))
    await waitStatus(hostWs, 'waiting')

    // ★闭包里再读 `relay` 时 TS 认为它可能已经被 afterEach 置回 null 了。
    //  抓一份到局部,顺便让"这个端口是这一条测试起的那台中转"这件事写在脸上。
    const port = relay.port
    /** 一台客户端从连上到握完手。返回它的会话 + host 那一侧对应的会话和 cid。 */
    const bring = async () => {
      const ws = await connect(port)
      ws.send(JSON.stringify({ t: 'join', role: 'client', room }))
      await waitStatus(ws, 'peer-online')
      const { pending, frame: init } = clientHandshakeInit()
      const gotInit = nextHostPayload(hostWs)
      ws.send(JSON.stringify(init))
      const first = await gotInit
      const hostSide = hostHandshakeReply(identity, JSON.parse(first.d))!
      const gotReply = nextPayload(ws)
      hostSend(hostWs, first.cid, hostSide.frame)
      const session = clientHandshakeFinish(pending, JSON.parse(await gotReply), identity.publicKey)!
      return { ws, session, cid: first.cid, hostSession: hostSide.session }
    }

    const a = await bring()
    const b = await bring()
    // ★两条逻辑连接的编号必须不同,否则下面全是假的
    expect(a.cid).not.toBe(b.cid)

    // host 分别回给两台。★用**各自**的会话密钥封
    const aGot = nextPayload(a.ws)
    const bGot = nextPayload(b.ws)
    hostSend(hostWs, a.cid, seal(a.hostSession, 'for-a')!)
    hostSend(hostWs, b.cid, seal(b.hostSession, 'for-b')!)

    const aRaw = await aGot
    const bRaw = await bGot
    expect(open(a.session, JSON.parse(aRaw))).toBe('for-a')
    expect(open(b.session, JSON.parse(bRaw))).toBe('for-b')
    // ★★而且**对方那条解不开** —— 这就是「两把密钥没有串」的硬证据
    expect(open(a.session, JSON.parse(bRaw))).toBeNull()
  })

  it('★★中转即使把帧改一个字节,也会被当场发现', async () => {
    const identity = generateIdentity()
    const room = toBase64(identity.publicKey)
    relay = await startRelay({ port: 0, host: '127.0.0.1' })
    const hostWs = await connect(relay.port)
    hostWs.send(JSON.stringify({ t: 'join', role: 'host', room }))
    await waitStatus(hostWs, 'waiting')
    const clientWs = await connect(relay.port)
    clientWs.send(JSON.stringify({ t: 'join', role: 'client', room }))
    await waitStatus(clientWs, 'peer-online')

    const { pending, frame: init } = clientHandshakeInit()
    const gotInit = nextHostPayload(hostWs)
    clientWs.send(JSON.stringify(init))
    const first = await gotInit
    const hostSide = hostHandshakeReply(identity, JSON.parse(first.d))!
    const gotReply = nextPayload(clientWs)
    hostSend(hostWs, first.cid, hostSide.frame)
    const clientSession = clientHandshakeFinish(pending, JSON.parse(await gotReply), identity.publicKey)!

    // 模拟一个恶意中转:把密文动一个字节再转
    const enc = seal(clientSession, 'allow')!
    const raw = enc.c.split('')
    raw[raw.length - 3] = raw[raw.length - 3] === 'A' ? 'B' : 'A'
    expect(open(hostSide.session, { t: 'enc', c: raw.join('') })).toBeNull()
  })

  it('★冒充者知道房间号(=公钥)也进得来,但一条命令都发不出', async () => {
    // 房间号是公开的,所以「进得来」是设计如此。挡住他的是握手,不是门禁。
    const identity = generateIdentity()
    const room = toBase64(identity.publicKey)
    relay = await startRelay({ port: 0, host: '127.0.0.1' })
    const hostWs = await connect(relay.port)
    hostWs.send(JSON.stringify({ t: 'join', role: 'host', room }))
    await waitStatus(hostWs, 'waiting')

    const attackerWs = await connect(relay.port)
    attackerWs.send(JSON.stringify({ t: 'join', role: 'client', room }))
    await waitStatus(attackerWs, 'peer-online') // 确实进来了

    // 他没有 daemon 的私钥,所以他伪造的 reply 客户端验不过;
    // 而他想直接发命令给 daemon,daemon 那边没有和他的会话,解不开。
    const fakeSession: Session = {
      key: new Uint8Array(32).fill(7),
      sendDir: 0,
      recvDir: 1,
      sendCounter: 0,
      lastRecvCounter: -1,
    }
    const gotIt = nextHostPayload(hostWs)
    attackerWs.send(JSON.stringify(seal(fakeSession, '{"t":"req","ch":"chat:send"}')!))
    const onWire = (await gotIt).d
    const { pending, frame: init } = clientHandshakeInit()
    const hostSide = hostHandshakeReply(identity, init)!
    void pending
    // daemon 拿自己的会话去解攻击者的帧 —— 解不开
    expect(open(hostSide.session, JSON.parse(onWire))).toBeNull()
  })

  it('★不说 join 就发东西的连接会被关掉', async () => {
    relay = await startRelay({ port: 0, host: '127.0.0.1', joinTimeoutMs: 500 })
    const ws = await connect(relay.port)
    const closed = new Promise<number>((res) => ws.once('close', (code) => res(code)))
    ws.send('这不是 join 帧')
    expect(await closed).toBe(4400)
  })

  it('★一直不 join 的连接会超时被踢(不然攒空连接就能耗光文件描述符)', async () => {
    relay = await startRelay({ port: 0, host: '127.0.0.1', joinTimeoutMs: 300 })
    const ws = await connect(relay.port)
    const closed = new Promise<number>((res) => ws.once('close', (code) => res(code)))
    expect(await closed).toBe(4408)
  })

  it('★一条连接崩了不能把整个中转带走', async () => {
    const identity = generateIdentity()
    const room = toBase64(identity.publicKey)
    relay = await startRelay({ port: 0, host: '127.0.0.1' })
    const a = await connect(relay.port)
    a.send(JSON.stringify({ t: 'join', role: 'host', room }))
    await waitStatus(a, 'waiting')
    // 粗暴地掐断
    a.terminate()
    await new Promise((r) => setTimeout(r, 200))
    // 中转还活着,而且房间被回收了
    expect(relay.stats().rooms).toBe(0)
    const b = await connect(relay.port)
    b.send(JSON.stringify({ t: 'join', role: 'host', room }))
    await waitStatus(b, 'waiting')
  })

  it('大消息扛得住(终端输出那种)', async () => {
    const identity = generateIdentity()
    const room = toBase64(identity.publicKey)
    relay = await startRelay({ port: 0, host: '127.0.0.1' })
    const hostWs = await connect(relay.port)
    hostWs.send(JSON.stringify({ t: 'join', role: 'host', room }))
    await waitStatus(hostWs, 'waiting')
    const clientWs = await connect(relay.port)
    clientWs.send(JSON.stringify({ t: 'join', role: 'client', room }))
    await waitStatus(clientWs, 'peer-online')

    const { pending, frame: init } = clientHandshakeInit()
    const gotInit = nextHostPayload(hostWs)
    clientWs.send(JSON.stringify(init))
    const first = await gotInit
    const hostSide = hostHandshakeReply(identity, JSON.parse(first.d))!
    const gotReply = nextPayload(clientWs)
    hostSend(hostWs, first.cid, hostSide.frame)
    const cs = clientHandshakeFinish(pending, JSON.parse(await gotReply), identity.publicKey)!

    const big = 'x'.repeat(1_000_000)
    const got = nextHostPayload(hostWs, 15000)
    clientWs.send(JSON.stringify(seal(cs, big)!))
    expect(open(hostSide.session, JSON.parse((await got).d))).toBe(big)
  })
})
