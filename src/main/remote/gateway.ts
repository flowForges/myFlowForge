import { WebSocketServer, type WebSocket } from 'ws'
import type { Identity } from '@shared/remote/e2e'
import { hostE2ELink } from '@shared/remote/e2eChannel'
import type { MethodTable } from '../ipc/invokeCtx'
import { serveConnection, type Channel } from './serveConnection'

export type GatewayOpts = {
  /** 已经筛过的方法表 —— 只包含这台 host 该对外提供的方法(见 channelRouting.daemonTable) */
  table: MethodTable
  /** 广播总线:每条连接挂一路 sink */
  addSink: (sink: (channel: string, payload: unknown) => void) => () => void
  version: string
  /** 绑哪个地址。★默认只绑回环 —— 公网上根本不存在这个端口(决策 B-3) */
  host?: string
  port: number
  /** 不给 = 不需要鉴权。非回环地址必须给(由调用方保证,见 daemon 入口) */
  token?: string
  /** 客户端连上后多久内必须完成鉴权,超时踢掉 */
  authTimeoutMs?: number
  /**
   * 这台机器的长期身份。**给了才支持端到端加密**(配对码里带公钥的那条路)。
   *
   * ★★不给不是"关掉加密",是"这台网关只会说明文" —— 而客户端看到码里有公钥就会发
   *  `hs-init`,对面不认的话它当场判「握手回复形状不对」然后断开。所以真实部署里
   *  **两个入口都必须给**(`appGateway` / daemon 都从 `readIdentity()` 拿同一把)。
   */
  identity?: Identity
  /**
   * 嗅探窗口:连上之后等多久还没收到第一帧,就断定对面是明文客户端。
   *
   * ★★为什么需要一个窗口 —— 两种客户端的**第一步是反的**:
   *  · 加密客户端连上就发 `hs-init`(它是发起方)
   *  · 明文客户端连上**什么都不发**,等我们先说 `hello`(见 `remoteClient.ts` 的 handleProtocol)
   *  所以「缓冲第一帧再决定」对明文那条路是个死锁:它永远等我们,我们永远等它。
   *  ★而 `hello` 又**必须**排在 `hs-reply` 后面(`e2eChannel.ts` 顶部那段:对面还没有会话密钥,
   *   提前发出去的 hello 它解不开、直接丢,然后永远等 hello)—— 所以也不能"先发了再说"。
   *  留一个窗口是唯一能同时满足这两条的做法:窗口内来了 `hs-init` 就走加密(零延迟),
   *  窗口过完还没动静就是明文(晚 `e2eGraceMs` 毫秒发 hello,而客户端等 ready 的上限是 10 秒)。
   */
  e2eGraceMs?: number
  onLog?: (msg: string) => void
  /** 连上 / 断开时叫一声。设置里那句「当前有 N 台设备连着」靠它才不会是个死数字。 */
  onClientsChanged?: () => void
}

/**
 * 嗅探窗口的默认值。
 * ★加密客户端是在 socket 的 `open` 回调里同步发 `hs-init` 的,也就是握手响应刚到它手上那一刻 ——
 *  正常情况下这一帧和我们这边的 `connection` 事件几乎同时。500ms 留的是"手机 JS 线程正卡着"
 *  那一类余量,而它只在**明文**那条路上体现为延迟。
 */
export const E2E_GRACE_MS = 500

export type GatewayHandle = {
  port: number
  host: string
  clientCount: () => number
  close: () => Promise<void>
}

/** `ws` 收到的一帧 → 一行文本。★协议本来就是 JSON 文本,而 `ws` 会按对面发的是 text
 *  还是 binary 帧给出不同的东西。嗅探和两条服务路径必须用**同一个**转换。 */
const frameText = (raw: unknown, isBinary: boolean): string =>
  isBinary ? (raw as Buffer).toString('utf8') : String(raw)

/**
 * `ws` 的一条连接 → `serveConnection` 认的那个最小信道。
 *
 * `replay` = 嗅探时已经从 socket 上取走的那一帧。★必须补回去:它是对面真正说的第一句话,
 * 吃掉它的表现是「客户端发了第一条请求,石沉大海」。补的位置在挂完监听之后 ——
 * 顺序反了的话这一帧会排在后面到达的帧后面。
 */
function wsChannel(ws: WebSocket, replay?: string): Channel {
  return {
    send: (text) => { try { ws.send(text) } catch { /* socket 已关 */ } },
    onMessage: (cb) => {
      ws.on('message', (raw, isBinary) => cb(frameText(raw, isBinary)))
      if (replay !== undefined) cb(replay)
    },
    close: (code, reason) => { try { ws.close(code, reason) } catch { /* 已关 */ } },
    onClose: (cb) => ws.on('close', cb),
  }
}

/**
 * 这一帧看着像不像加密握手的第一句。
 * ★只看形状,不判真假 —— 真正的校验(公钥合不合法、签得出签不出)在 `hostE2ELink` 里,
 *  这里放行一帧假的 `hs-init`,结果也只是它被那一层用 4400 关掉。
 */
function looksLikeHsInit(text: string): boolean {
  if (text.charCodeAt(0) !== 0x7b /* { */) return false
  try {
    return (JSON.parse(text) as { t?: unknown })?.t === 'hs-init'
  } catch {
    return false
  }
}

/**
 * 对外服务同一张方法表的 WS 网关。
 *
 * 「同一张」是关键:Electron 侧走 IPC 遍历它,这里走 WS 遍历它 —— 方法只有一份,
 * 所以不存在「本机一条路径、远程另一条路径」的漂移(设计文档第三节)。
 *
 * ★★2026-08-29:每条连接上到底怎么说话(hello/auth/ready/req/res/evt)搬到了
 *  `serveConnection.ts` —— 因为第三期的中转那条路上没有 `ws` 对象可用,而那套对话必须是
 *  **同一份**。理由完整版在那个文件顶上。
 *
 * ★★2026-09-02:这里多了一件事 —— **决定这条连接加不加密**(首帧嗅探,见 `e2eGraceMs`)。
 *  在此之前 E2E 只在中转那条路上有,而配对码带公钥时客户端(手机和电脑**同一套判据**)
 *  会走「直连 + 端到端加密」发 `hs-init`;网关不认,照旧回明文 hello,对面当场判
 *  「握手回复形状不对」断开 —— 手机走局域网直连是**连不上**的。决定之后的每一行,
 *  两条路仍然跑同一份 `serveConnection`。
 */
export async function startGateway(opts: GatewayOpts): Promise<GatewayHandle> {
  const host = opts.host ?? '127.0.0.1'
  const log = opts.onLog ?? (() => {})
  const graceMs = opts.e2eGraceMs ?? E2E_GRACE_MS
  const methods = Object.keys(opts.table)

  const wss = new WebSocketServer({ host, port: opts.port })
  await new Promise<void>((res, rej) => {
    wss.once('listening', res)
    wss.once('error', rej)
  })

  const conns = new Set<WebSocket>()
  let closed = false

  wss.on('connection', (ws) => {
    conns.add(ws)
    opts.onClientsChanged?.()
    ws.on('error', () => { /* 'close' 会跟着来,清理在那儿做 */ })

    const serve = (ch: Channel) => serveConnection(ch, {
      table: opts.table,
      methods,
      addSink: opts.addSink,
      version: opts.version,
      token: opts.token,
      authTimeoutMs: opts.authTimeoutMs,
      onLog: log,
    })

    // ── 首帧嗅探。加密和明文的差别**只在这几十行里**;从 `serve` 往下,两条路跑的是同一份代码。
    let decided = false
    let grace: ReturnType<typeof setTimeout> | null = null

    const settle = () => {
      decided = true
      if (grace) { clearTimeout(grace); grace = null }
      ws.off('message', sniff)
    }

    /** 断定对面是明文客户端。`first` = 嗅探时取走的那一帧(窗口自然过期时没有)。 */
    const goPlain = (first?: string) => {
      if (decided) return
      settle()
      serve(wsChannel(ws, first))
    }

    /** 断定对面要加密。★握手必须在 `serveConnection` **之前** —— 见 `e2eChannel.ts` 顶部。 */
    const goEncrypted = (first: string) => {
      settle()
      const link = hostE2ELink(
        opts.identity!,
        {
          sendRaw: (text) => { try { ws.send(text) } catch { /* 已关 */ } },
          closeRaw: (code, reason) => { try { ws.close(code, reason) } catch { /* 已关 */ } },
          onLog: log,
        },
        // 握完手了。从这里往下,和中转那条路**跑的是同一份代码**。
        (ch: Channel) => serve(ch),
      )
      ws.on('message', (raw, isBinary) => link.receive(frameText(raw, isBinary)))
      // ★必须转告 —— 不转告的话 `serveConnection` 挂的那路广播 sink 永远摘不掉。
      ws.on('close', () => link.closed())
      link.receive(first)
    }

    const sniff = (raw: unknown, isBinary: boolean) => {
      if (decided) return
      const text = frameText(raw, isBinary)
      // ★没有 identity 就没得握手 —— 退回明文,让那一帧在 `serveConnection` 里当坏帧丢掉。
      //  比在这儿把连接关掉强:对面至少能收到 hello,看得出版本/形状不对。
      if (opts.identity && looksLikeHsInit(text)) {
        log('客户端要求端到端加密,开始握手')
        return goEncrypted(text)
      }
      goPlain(text)
    }

    ws.on('message', sniff)
    grace = setTimeout(() => { grace = null; goPlain() }, graceMs)

    ws.on('close', () => {
      // ★窗口没过完就断了:定时器必须清掉,否则它会在一条死 socket 上开一条明文服务。
      if (!decided) settle()
      conns.delete(ws)
      opts.onClientsChanged?.()
    })
  })

  const address = wss.address()
  const port = typeof address === 'object' && address ? address.port : opts.port

  return {
    port,
    host,
    clientCount: () => conns.size,
    async close() {
      // ★幂等:WebSocketServer.close() 被调用第二次时回调不保证再触发,await 会永远挂着。
      if (closed) return
      closed = true
      for (const ws of [...conns]) { try { ws.close(1001, 'going away') } catch { /* 已关 */ } }
      await new Promise<void>((res) => wss.close(() => res()))
    },
  }
}
