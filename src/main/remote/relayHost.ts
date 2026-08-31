import { WebSocket } from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { pickProxy, proxyUsable } from './wsProxy'
import type { Identity } from '@shared/remote/e2e'
import { hostClose, hostData, joinFrame, parseHostEnvelope, roomFor, asRelayStatus } from '@shared/remote/relayWire'
import type { MethodTable } from '../ipc/invokeCtx'
import { serveConnection, type Channel } from './serveConnection'
import { hostE2ELink, type E2ELink } from '@shared/remote/e2eChannel'

/**
 * daemon 通过**中转**对外服务。
 *
 * 局域网那条路是 `gateway.ts`(自己监听一个端口,客户端连过来)。这条路反过来:
 * daemon **主动拨号**到中转,占住自己的房间,然后客户端也拨到同一个房间。
 * 这就是"NAT 后面的笔记本也能被远程连上"的全部机制 —— 两端都是出站连接,
 * 不需要端口转发、不需要公网 IP、不需要任何路由器上的配置。
 *
 * ## 三层,各管各的
 *
 * ```
 * 一条 WebSocket 到中转
 *   └─ 按 cid 拆成 N 条逻辑连接        ← 这个文件
 *        └─ 每条外面套一层端到端加密    ← e2eChannel.ts
 *             └─ 里面跑同一套方法表协议  ← serveConnection.ts(和局域网**同一份**)
 * ```
 *
 * ★★最外层和最里层之间**没有任何耦合**:`serveConnection` 不知道有中转,也不知道有加密;
 *  中转不知道有加密,更不知道里面在跑什么。改中间任何一层,另外两层一行不用动。
 *
 * ## 断线重连
 *
 * daemon 是常驻的,中转重启 / 网络抖动都不该让它掉线一整晚,所以这里退避重连。
 * ★★重连时**所有逻辑连接一起作废**:它们的 cid 是上一条中转连接分配的,而且每条上面
 *  那把会话密钥也随之失效。不清干净的话,重连之后中转分配的新 cid 会撞上旧表里的项,
 *  于是新客户端的帧被喂进一把旧密钥 —— 解不开、静默丢,表现是"重连之后手机再也连不上,
 *  但电脑上什么错都没有"。
 */

export type RelayHostStatus =
  | { status: 'off' }
  | { status: 'connecting'; attempt: number }
  /** 连上中转、占住房间了。`peers` = 现在挂着几个客户端。 */
  | { status: 'online'; peers: number }
  | { status: 'retrying'; attempt: number; error: string; nextInMs: number }
  /** 重试也没用的那类(房间被别人占了 / 地址根本不对)。 */
  | { status: 'failed'; error: string }

export type RelayHostOpts = {
  /** 中转地址,`ws://` 或 `wss://`。 */
  relayUrl: string
  /** 这台机器的长期身份。房间号从它的公钥算出来。 */
  identity: Identity
  /** 已经筛过的方法表(见 channelRouting.daemonTable) */
  table: MethodTable
  addSink: (sink: (channel: string, payload: unknown) => void) => () => void
  version: string
  /**
   * 访问令牌。
   * ★★中转这条路上**仍然要令牌**,尽管已经端到端加密了。加密回答的是"谁能听",
   *  令牌回答的是"谁能用" —— 一个知道公钥的人握不了手,但一个**拿到过配对码**又不该
   *  再被信任的设备(旧手机、离职同事)必须能被单独踢掉,而换令牌就是那个开关。
   *  换身份太重(所有设备都要重扫)。
   */
  token?: string
  /**
   * 「app 自身的网络」那个代理(设置 → 网络 的 appProxy)。空着就退到 `https_proxy` 等环境变量。
   *
   * ★★2026-08-31:漏了它的后果是**永远转圈**。`ws` 不认环境变量,不给 agent 就直连;
   *  而直连一个够不着的地址不会报错、不会关闭,就是不回 —— 界面上只能显示「正在连中转」,
   *  和「地址写错」「服务没起来」长得一模一样。理由完整版在 `wsProxy.ts`。
   */
  proxy?: string
  onLog?: (msg: string) => void
  onStatus?: (s: RelayHostStatus) => void
  /** 退避参数;false = 不自动重连(测试用) */
  backoff?: { baseMs: number; maxMs: number } | false
}

export type RelayHostHandle = {
  status: () => RelayHostStatus
  /** 房间号 —— 设置界面上那个二维码要用它。 */
  room: string
  close: () => Promise<void>
}

export function startRelayHost(opts: RelayHostOpts): RelayHostHandle {
  const log = opts.onLog ?? (() => {})
  const backoff = opts.backoff === false ? null : opts.backoff ?? { baseMs: 1_000, maxMs: 30_000 }
  const methods = Object.keys(opts.table)
  const room = roomFor(opts.identity.publicKey)

  let ws: WebSocket | null = null
  let state: RelayHostStatus = { status: 'off' }
  let attempt = 1
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  /** cid → 那条逻辑连接的加密层。**这张表的生命周期跟着中转连接走**,重连就清空。 */
  const links = new Map<string, E2ELink>()

  const setState = (s: RelayHostStatus) => {
    state = s
    opts.onStatus?.(s)
  }

  /** 把所有逻辑连接干掉。★重连、关闭、中转说 host 掉线 —— 三条路都走这里。 */
  const dropAllLinks = (why: string) => {
    if (links.size) log(`${why}:丢掉 ${links.size} 条逻辑连接`)
    for (const l of [...links.values()]) {
      try { l.closed() } catch { /* 上层的清理抛了,不该拦住其余的 */ }
    }
    links.clear()
  }

  const sendToRelay = (text: string) => {
    try {
      if (ws?.readyState === WebSocket.OPEN) ws.send(text)
    } catch { /* 中转那条断了,close 事件会来收拾 */ }
  }

  /** 一个新客户端进来了:建加密层 → 握完手 → 把 Channel 交给方法表那一层。 */
  const openLink = (cid: string) => {
    // ★同一个 cid 又来一次 open:中转不该这么做,但它是**不可信**的。
    //  照单全收会把上一条的加密状态留在表里被覆盖,而上一条的 closed() 永远不会被调 ——
    //  它挂着的那路广播 sink 就永远摘不掉,daemon 会一直往一条死连接上推事件。
    const existing = links.get(cid)
    if (existing) {
      log(`中转对同一个 cid ${cid} 发了两次 open,先清掉旧的`)
      try { existing.closed() } catch { /* 同上 */ }
    }
    const link = hostE2ELink(
      opts.identity,
      {
        sendRaw: (text) => sendToRelay(hostData(cid, text)),
        closeRaw: (code, reason) => {
          log(`关掉逻辑连接 ${cid}(${code} ${reason})`)
          sendToRelay(hostClose(cid))
          const l = links.get(cid)
          links.delete(cid)
          try { l?.closed() } catch { /* 同上 */ }
          if (state.status === 'online') setState({ status: 'online', peers: links.size })
        },
        onLog: log,
      },
      (ch: Channel) => {
        // 握完手了。从这里往下,和局域网那条路**跑的是同一份代码**。
        serveConnection(ch, {
          table: opts.table,
          methods,
          addSink: opts.addSink,
          version: opts.version,
          token: opts.token,
          onLog: log,
        })
      },
    )
    links.set(cid, link)
    if (state.status === 'online') setState({ status: 'online', peers: links.size })
  }

  const closeLink = (cid: string) => {
    const l = links.get(cid)
    if (!l) return
    links.delete(cid)
    try { l.closed() } catch { /* 同上 */ }
    if (state.status === 'online') setState({ status: 'online', peers: links.size })
  }

  const scheduleRetry = (why: string) => {
    dropAllLinks('中转连接断了')
    if (disposed || !backoff) {
      setState({ status: 'off' })
      return
    }
    const delay = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (attempt - 1))
    setState({ status: 'retrying', attempt, error: why, nextInMs: delay })
    retryTimer = setTimeout(() => { attempt++; connect() }, delay)
  }

  /** 重试也没用的失败。★别用退避把同一个错误刷一整晚。 */
  const fail = (why: string) => {
    disposed = true
    dropAllLinks('中转拒绝了我们')
    try { ws?.close() } catch { /* 已关 */ }
    setState({ status: 'failed', error: why })
  }

  /**
   * 拨号选项。**只在这一处决定要不要套代理**,而且不管走不走都留一行日志 ——
   * 「有没有过代理」是这条链路最容易猜错、也最难从现象反推的一件事。
   */
  function wsOptions(): { agent?: HttpsProxyAgent<string> } {
    const pick = pickProxy(opts.proxy, process.env)
    if (!pick.use) { log(`直连中转(${pick.why})`); return {} }
    const usable = proxyUsable(opts.relayUrl, pick.url)
    if (!usable.ok) { log(usable.why); return {} }
    log(`经代理连中转:${pick.url}(来自${pick.from === 'setting' ? '设置' : '环境变量'})`)
    try {
      return { agent: new HttpsProxyAgent(pick.url) }
    } catch (e) {
      // 代理地址畸形是同步抛的。★不能让它把整条中转打死 —— 退回直连并说清楚,
      //  总好过连 retrying 都进不去。
      log(`代理地址用不了(${e instanceof Error ? e.message : String(e)}),改直连`)
      return {}
    }
  }

  function connect() {
    if (disposed) return
    setState({ status: 'connecting', attempt })
    let sock: WebSocket
    try {
      sock = new WebSocket(opts.relayUrl, wsOptions())
    } catch (e) {
      // 畸形 URL 是**同步抛**的。不接住的话整个 start 当场炸,连一次 retrying 都进不去,
      // 界面永远停在「连接中」。
      return scheduleRetry(e instanceof Error ? e.message : String(e))
    }
    ws = sock

    sock.on('open', () => {
      log(`连上中转 ${opts.relayUrl},认领房间`)
      sendToRelay(JSON.stringify(joinFrame('host', room)))
    })

    sock.on('message', (raw: unknown, isBinary: boolean) => {
      // 中转的协议是文本的。二进制帧一律无视 —— 放行等于多开一条没人测过的路径。
      if (isBinary) return
      const text = String(raw)

      const st = asRelayStatus(text)
      if (st) {
        if (st.status === 'error') {
          // ★"房间已经有一台主机连着了"是**重试也没用**的:要么是自己上一条僵尸连接
          //  (中转的心跳会在一分钟内收掉,那时用户手动重连即可),要么真有人占了房间。
          //  两种都不该拿退避刷一整晚。
          return fail(st.error || '中转拒绝了这次连接')
        }
        if (st.status === 'waiting' || st.status === 'peer-online') {
          attempt = 1
          setState({ status: 'online', peers: links.size })
        }
        // `peer-offline` 不改状态:房间还占着,只是眼下没人连。逐条连接的生死由
        // 下面的 open/close 信封管,这条状态帧只是个粗粒度提示。
        return
      }

      const env = parseHostEnvelope(text)
      // ★信封坏了只丢这一帧。中转是不可信的,但也可能只是版本不一致 ——
      //  为一帧看不懂的东西把整条中转连接断掉,会连带所有客户端一起下线。
      if (!env) return log('丢弃一条看不懂的中转帧')
      if (env.t === 'open') return openLink(env.cid)
      if (env.t === 'close') return closeLink(env.cid)
      const link = links.get(env.cid)
      // ★★没有这条 cid 的加密层就丢。中转可以在我们已经 close 掉之后再送几帧过来
      //  (它那边的时序),而**凭空建一条**是绝对不行的:那等于让中转决定谁能跟我们握手,
      //  绕过 `open` 这唯一的入口。
      if (!link) return
      link.receive(env.d)
    })

    sock.on('close', () => {
      if (disposed) { dropAllLinks('已停止'); return }
      scheduleRetry('和中转的连接断了')
    })
    // ★必须接住。不接的话 'error' 会变成 uncaught exception 把整个主进程带走。
    //  清理放在 'close' 里做 —— `ws` 在 error 之后总会再发 close。
    sock.on('error', (e: Error) => log(`中转连接出错:${e.message}`))
  }

  connect()

  return {
    status: () => state,
    room,
    async close() {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      dropAllLinks('已停止')
      try { ws?.close(1001, 'going away') } catch { /* 已关 */ }
      ws = null
      setState({ status: 'off' })
    },
  }
}
