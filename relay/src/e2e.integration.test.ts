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
    const hostGotInit = nextPayload(hostWs)
    clientWs.send(JSON.stringify(init))
    const hostSide = hostHandshakeReply(identity, JSON.parse(await hostGotInit))!
    const clientGotReply = nextPayload(clientWs)
    hostWs.send(JSON.stringify(hostSide.frame))
    // ★客户端用的是**配对链接里那把公钥**验签,不是对面自报的
    const clientSession = clientHandshakeFinish(pending, JSON.parse(await clientGotReply), paired.publicKey)!
    expect(clientSession).not.toBeNull()

    // ── 发一条真会造成后果的命令 ────────────────────────────────────────
    const secret = JSON.stringify({ t: 'req', id: 1, ch: 'chat:send', args: [{ text: '删掉 build 目录' }] })
    const hostGotMsg = nextPayload(hostWs)
    const enc = seal(clientSession, secret)!
    clientWs.send(JSON.stringify(enc))

    const onWire = await hostGotMsg
    // host 解得开
    expect(open(hostSide.session, JSON.parse(onWire))).toBe(secret)

    // ★★★ 关键断言:线上那一帧里没有任何明文痕迹
    expect(onWire).not.toContain('chat:send')
    expect(onWire).not.toContain('删掉 build 目录')
    expect(onWire).not.toContain('"req"')
    expect(JSON.parse(onWire).t).toBe('enc')
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
    const gotInit = nextPayload(hostWs)
    clientWs.send(JSON.stringify(init))
    const hostSide = hostHandshakeReply(identity, JSON.parse(await gotInit))!
    const gotReply = nextPayload(clientWs)
    hostWs.send(JSON.stringify(hostSide.frame))
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
    const gotIt = nextPayload(hostWs)
    attackerWs.send(JSON.stringify(seal(fakeSession, '{"t":"req","ch":"chat:send"}')!))
    const onWire = await gotIt
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
    const gotInit = nextPayload(hostWs)
    clientWs.send(JSON.stringify(init))
    const hostSide = hostHandshakeReply(identity, JSON.parse(await gotInit))!
    const gotReply = nextPayload(clientWs)
    hostWs.send(JSON.stringify(hostSide.frame))
    const cs = clientHandshakeFinish(pending, JSON.parse(await gotReply), identity.publicKey)!

    const big = 'x'.repeat(1_000_000)
    const got = nextPayload(hostWs, 15000)
    clientWs.send(JSON.stringify(seal(cs, big)!))
    expect(open(hostSide.session, JSON.parse(await got))).toBe(big)
  })
})
