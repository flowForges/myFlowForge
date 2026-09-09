import { PING, PONG, createRelayCore, parseJoin, type RelaySocket, type Role } from './core.js'

/**
 * Cloudflare Workers + Durable Object 适配器(设计文档第八节的 `worker.ts`)。
 *
 * 撮合逻辑和 `node.ts` **是同一份**(`core.ts`),这里只负责把 Cloudflare 的 WebSocket API
 * 接上去。选它的理由是带宽:中转是**全流量转发**,而 Cloudflare 的带宽是 Cloudflare 出的;
 * 你那台小 VPS 应该留着跑 daemon。
 *
 * ## ★★hibernation:这个文件最容易出错的地方
 *
 * DO 开了 hibernation 之后,**空闲时整个实例会被卸载,而 WebSocket 连接还活着**。
 * 下一帧到达时 DO 被唤醒,拿到的是一个**全新的 `createRelayCore()`** —— 房间全没了。
 * 不重建的话那一帧会落进空房间被静默丢掉,症状是
 * **「挂了一晚上之后手机再也收不到东西,而两边都显示连着」**。
 *
 * 所以每条连接的 `{room, role, cid}` 都写进 `serializeAttachment()`(那是**跟着连接**
 * 持久化的,不是跟着实例),醒来时从 `getWebSockets()` 一条条 `core.restore()` 回去。
 * ★用 `restore` 不用 `join`:后者会发状态帧、还会分配新 cid(见 core.ts 那段注释)。
 *
 * ## 为什么只有一个 DO
 *
 * 房间号是 daemon 的公钥。**把它放进 URL 就等于把它写进 Cloudflare 的日志** ——
 * 而 README 里明确写着 `/healthz` 都不报房间号,因为那是可关联的信息。
 * 按房间分 DO 需要在 upgrade **之前**知道房间号,也就只能放 URL 里。
 * 所以这里退一步:一个 DO 管所有房间(和 `node.ts` 完全一样,`core` 本来就是多房间的)。
 * ★代价是单实例的吞吐上限。自建中转(几台自己的设备)远够;真要做公共服务,
 *  那是另一个量级的东西,别在这儿硬撑。
 *
 * ## 部署
 *
 * ```
 * cd relay && npm i && npx wrangler deploy
 * ```
 * 然后在 app 的 设置 → 手机 里填 `wss://<你的 worker 域名>/`。
 *
 * ★这个文件**没有自动化测试**:跑它要 miniflare / wrangler 的运行时。
 *  能测的部分(撮合、重建、cid 分配)都在 `core.ts` 里,那边是全覆盖的;
 *  这里只剩「把 CF 的 API 接上去」这一层,**必须真部署一次才算验过**。
 */

// ── Cloudflare 运行时的最小类型 ────────────────────────────────────────────
// 故意不依赖 `@cloudflare/workers-types`:这个包要单独装,而 relay 要能被直接 clone 出去
// 部署。只声明用到的那几个。
interface CfWebSocket {
  accept(): void
  send(data: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}
interface DurableObjectStorage {
  setAlarm(scheduledTime: number): Promise<void>
  getAlarm(): Promise<number | null>
}
interface DurableObjectState {
  acceptWebSocket(ws: CfWebSocket): void
  getWebSockets(): CfWebSocket[]
  storage: DurableObjectStorage
  /**
   * 运行时**替我们**回一帧,而且**不唤醒这个 DO** —— 心跳能便宜到几乎免费,靠的就是它。
   * 配了之后,匹配到的那一帧根本不会走 `webSocketMessage`。
   */
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePairType): void
  /** 这条连接**最后一次**被自动应答是什么时候。从没应答过 = null(老客户端,不发心跳)。 */
  getWebSocketAutoResponseTimestamp(ws: CfWebSocket): Date | null
}
interface WebSocketRequestResponsePairType { request: string; response: string }
declare const WebSocketRequestResponsePair: {
  new (request: string, response: string): WebSocketRequestResponsePairType
}
interface DurableObjectId { toString(): string }
interface DurableObjectStub { fetch(req: Request): Promise<Response> }
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}
export interface Env {
  RELAY: DurableObjectNamespace
}
declare const WebSocketPair: { new (): { 0: CfWebSocket; 1: CfWebSocket } }

/** 挂在每条连接上、**跟着连接一起持久化**的那点东西。醒来时靠它重建房间。 */
type Attach = { room: string; role: Role; cid?: string }

const isAttach = (v: unknown): v is Attach => {
  if (!v || typeof v !== 'object') return false
  const a = v as Record<string, unknown>
  return typeof a.room === 'string' && (a.role === 'host' || a.role === 'client')
}

/** 多久检查一次僵尸(毫秒)。 */
const SWEEP_MS = 60_000
/**
 * 多久没回过心跳算死。★要**明显大于**客户端的心跳间隔(`relayHost` 是 30 秒),
 * 否则一次网络抖动就把一条好连接收掉。三倍是常见取法。
 */
const STALE_MS = 100_000

export class RelayRoom {
  private core = createRelayCore()
  private hydrated = false

  constructor(private state: DurableObjectState) {
    /**
     * ★★心跳交给运行时自动应答:匹配到 `PING` 就回 `PONG`,**DO 完全不用醒**。
     *  自己在 `webSocketMessage` 里回也行,但那样每 30 秒唤醒一次 DO,
     *  等于把 hibernation 省下来的钱又花回去。
     * ★配在构造函数里:每次 DO 被(重新)实例化都要配一遍,它不是持久化设置。
     */
    try {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
    } catch { /* 老 runtime 没有这个 API —— 退回「没有心跳」,和改这一刀之前一样 */ }
  }

  /**
   * 从 hibernation 醒来后把房间重建回去。**每个入口都要先调它。**
   *
   * ★幂等,而且**必须**幂等:一次唤醒里会连着来好几帧,每一帧都会走到这儿。
   */
  private hydrate(): void {
    if (this.hydrated) return
    this.hydrated = true
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment()
      // ★还没 join 的连接没有附件 —— 跳过,别把它当成一条属于某个房间的连接。
      if (!isAttach(a)) continue
      this.core.restore(this.sock(ws), a.room, a.role, a.cid)
    }
  }

  /**
   * 一条 CF WebSocket → `core` 认的那个最小信道。
   *
   * ★★**每次都新建一个包装对象是可以的,但 `core` 里有几处按身份比较 socket**
   *  (`leave` 的 `room.host !== sock`、`clients.get(cid) === sock`)。所以包装必须是
   *  **稳定的**:同一条底层连接每次都要拿到同一个包装。用一张 WeakMap 认人。
   *  不这么做的话,断开时那几处比较全都不相等 —— 房间永远清不掉,而且 host 断了
   *  客户端收不到 `peer-offline`。
   */
  private wrappers = new WeakMap<CfWebSocket, RelaySocket>()
  private sock(ws: CfWebSocket): RelaySocket {
    let s = this.wrappers.get(ws)
    if (s) return s
    s = {
      // 对面随时可能断。中转绝不能因为一条连接挂了就崩 —— 它服务的是别人的所有会话。
      send: (d) => { try { ws.send(d) } catch { /* 那条连接的事 */ } },
      close: (code, reason) => { try { ws.close(code ?? 1000, reason ?? '') } catch { /* 已关 */ } },
    }
    this.wrappers.set(ws, s)
    return s
  }

  /**
   * ★★僵尸回收。**这是 2026-09-09 那个事故的中转侧兜底。**
   *
   * 同一个房间只准一个 host(见 `core.ts` 的 `join`),而一条**死了但没关**的 socket
   * (笔记本合盖、切网、拔网线)Cloudflare 不一定推 close 事件 ⇒ 房间被**永久**占住,
   * 真主机回来只看到「这个房间已经有一台主机连着了」,而那台就是它自己。
   * `core.ts` 里那句「代价由适配器的 keepalive 解决」原来只在 `node.ts` 兑现了,
   * 这个文件一行都没有 —— 而用户用的正是这一版。
   *
   * ★★**只收「回过心跳、然后不回了」的那些**。从没应答过(timestamp 为 null)= 老客户端,
   *  它压根不发心跳 —— 按超时收掉它等于每 100 秒把老版本的 app 踢下线一次,
   *  那是**制造**一个比僵尸更常见的故障。宁可老版本继续裸奔,等它升级。
   */
  private async sweep(): Promise<void> {
    const now = Date.now()
    let alive = 0
    for (const ws of this.state.getWebSockets()) {
      alive++
      const last = this.state.getWebSocketAutoResponseTimestamp(ws)
      if (!last) continue                       // 老客户端:不判
      if (now - last.getTime() <= STALE_MS) continue
      // 关掉 ⇒ 运行时会调 `webSocketClose` ⇒ `core.leave` 把房间腾出来。
      try { ws.close(4408, 'heartbeat timeout') } catch { /* 已关 */ }
      alive--
    }
    // ★没有连接就**别再排下一次**:空转的 alarm 是纯计费。有连接时才继续。
    if (alive > 0) await this.state.storage.setAlarm(now + SWEEP_MS)
  }

  /** 定时器到点。★hibernation 下 `setInterval` 不成立(实例会被卸载),alarm 才是那条路。 */
  async alarm(): Promise<void> {
    this.hydrate()
    await this.sweep()
  }

  /** 有连接时保证有一个 alarm 在排队。★幂等:已经排了就不动它。 */
  private async ensureSweep(): Promise<void> {
    try {
      if (await this.state.storage.getAlarm() === null) {
        await this.state.storage.setAlarm(Date.now() + SWEEP_MS)
      }
    } catch { /* 排不上就算了,回收只是兜底,不能因为它把转发打死 */ }
  }

  async fetch(req: Request): Promise<Response> {
    this.hydrate()
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const pair = new WebSocketPair()
    // ★`acceptWebSocket`(不是 `server.accept()`)才是 hibernation 那条路:
    //  用后者的话 DO 永远不会休眠,连接一多就一直计费。
    this.state.acceptWebSocket(pair[1])
    void this.ensureSweep()
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit & { webSocket: CfWebSocket })
  }

  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    this.hydrate()
    const sock = this.sock(ws)
    // ★二进制帧一律拒。协议是文本的;放行二进制等于多开一条没人测过的路径。
    if (typeof message !== 'string') { sock.close(4400, 'binary not supported'); return }

    const a = ws.deserializeAttachment()
    if (!isAttach(a)) {
      const frame = parseJoin(message)
      if (!frame) { sock.close(4400, 'bad join'); return }
      const res = this.core.join(sock, frame)
      if (!res.ok) { sock.close(4409, 'room busy'); return }
      // ★★附件要在 join **成功之后**才写:写早了,一条被拒的连接会在下次唤醒时
      //  被 `hydrate` 当成房间成员恢复回来,于是它凭空占住了那个房间。
      ws.serializeAttachment({ room: frame.room, role: frame.role, cid: res.cid } satisfies Attach)
      return
    }
    // ★★join 之后这里**不看内容**,原样搬。中转是哑管道 —— 这一行是整个安全模型的落点。
    this.core.relay(sock, a.room, a.role, message, a.cid)
  }

  async webSocketClose(ws: CfWebSocket): Promise<void> {
    this.hydrate()
    const a = ws.deserializeAttachment()
    if (isAttach(a)) this.core.leave(this.sock(ws), a.room, a.role, a.cid)
  }

  /** 出错和关闭走同一条清理。`core.leave` 幂等,两条都到也没代价。 */
  async webSocketError(ws: CfWebSocket): Promise<void> {
    await this.webSocketClose(ws)
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    // ★`/healthz` 只报活着,**不报任何房间信息** —— 那是可关联的(README「它故意不做什么」)。
    //  数字也不报:单 DO 下要拿到数字得唤醒 DO,而健康检查是高频的,那等于让它永远不休眠。
    if (url.pathname === '/healthz') {
      return new Response('ok\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('myFlowForge relay\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    // 单实例。理由见文件头「为什么只有一个 DO」。
    return env.RELAY.get(env.RELAY.idFromName('relay')).fetch(req)
  },
}
