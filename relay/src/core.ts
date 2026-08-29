/**
 * 中转的撮合核心。**两个适配器共用这一份**(设计文档第八节):
 * `worker.ts`(Cloudflare Workers + Durable Object)和 `node.ts`(任何 VPS / Docker)。
 *
 * ★★**这里没有一行密码学代码,而且永远不该有。**
 *  中转是不可信的哑管道(决策 5):它按房间号把两条连接接起来,然后**原样搬字节**。
 *  它读不懂内容,也没有任何密钥。这不是偷懒 —— 这是它能被放心部署在别人机器上的**唯一理由**。
 *  哪天有人想在这里加一句「解开看看再转发」,那就是把整个安全模型推翻了。
 *
 * ## 房间号就是 daemon 的公钥
 *
 * 不需要额外的注册流程:配对链接里已经有 daemon 公钥,客户端天然知道该进哪个房间。
 * 别人知道公钥也没用 —— 他进得了房间,但握手过不去(没有私钥),连一条命令都发不出。
 *
 * ## 为什么必须有状态(Durable Object)
 *
 * 普通 Worker 是无状态的,撮合不了两条 WebSocket。DO 就是那个「会合点」。
 */

/** 适配器要提供的最小连接抽象。故意不依赖任何具体 WebSocket 实现。 */
export type RelaySocket = {
  /** 把一帧原样发给这条连接。**中转不看内容**,所以类型是不透明的。 */
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type Role = 'host' | 'client'

/** 加入房间时的第一帧。**这是中转唯一会解析的东西。** */
export type JoinFrame = { t: 'join'; role: Role; room: string }

/** 中转发回去的状态帧。也是它唯一会自己生成的东西。 */
export type RelayStatus =
  | { t: 'relay'; status: 'waiting' }
  | { t: 'relay'; status: 'peer-online' }
  | { t: 'relay'; status: 'peer-offline' }
  | { t: 'relay'; status: 'error'; error: string }

/**
 * ## 为什么 host 那一侧要带 `cid`
 *
 * ★★2026-08-29:这一层原来是**广播** —— host 发的东西给房间里所有客户端。
 *  它在「只有一个客户端」时看起来是对的,多一个就**静默地坏掉**:
 *  daemon 跟中转只有一条 socket,手机和笔记本的 `hs-init` 前后脚到达同一条流上,
 *  daemon 无从分辨这两帧属于两次不同的握手 —— 两把会话密钥会串在一起,
 *  而现象是「第二台设备连上就一直转圈」,没有任何一条错误信息。
 *  当时 `MAX_CLIENTS_PER_ROOM = 4` 等于在宣传一个不存在的能力。
 *
 * 修法是给 host 那一侧套一层**最薄的信封**:每条逻辑连接一个 `cid`(中转分配)。
 * ★客户端那一侧**仍然不套信封** —— 它跟中转是一对一的,`join` 之后就是原样的字节流。
 *  所以手机端的改动只有一句开场白,而 daemon 那边多一个拆信封的循环。
 * ★★中转拆的**只有信封**,`d` 里的一个字节都不看。这一点没有变,也不许变。
 */

/** relay → host / host → relay 的信封。`d` 是**不透明**的。 */
export type HostEnvelope =
  | { t: 'open'; cid: string }
  | { t: 'close'; cid: string }
  | { t: 'data'; cid: string; d: string }

/** cid 的形状:中转自己分配,但 host 发回来的要卡一遍(它来自网络)。 */
const CID_RE = /^[0-9]{1,16}$/

/** 解 host 发来的信封。**任何不对的地方都返回 null。** */
export function parseHostEnvelope(raw: string): HostEnvelope | null {
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const f = o as Record<string, unknown>
  if (typeof f.cid !== 'string' || !CID_RE.test(f.cid)) return null
  if (f.t === 'close') return { t: 'close', cid: f.cid }
  if (f.t === 'data' && typeof f.d === 'string') return { t: 'data', cid: f.cid, d: f.d }
  return null
}

/** 房间号的合法性。**必须卡死** —— 它来自网络,会被当 Map 的 key。 */
const ROOM_RE = /^[A-Za-z0-9+/=_-]{20,128}$/

export function isValidRoom(room: string): boolean {
  return ROOM_RE.test(room)
}

/**
 * 解 join 帧。**任何不对的地方都返回 null**,由适配器负责关掉那条连接。
 * 中转面向公网,这是它的第一道门,也是唯一一道 —— 后面全是不看内容的转发。
 */
export function parseJoin(raw: string): JoinFrame | null {
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const f = o as Record<string, unknown>
  if (f.t !== 'join') return null
  if (f.role !== 'host' && f.role !== 'client') return null
  if (typeof f.room !== 'string' || !isValidRoom(f.room)) return null
  return { t: 'join', role: f.role, room: f.room }
}

/** 一个房间同时最多几个客户端。手机 + 笔记本 + 备用,给到 4 够了。 */
export const MAX_CLIENTS_PER_ROOM = 4

type Room = {
  host: RelaySocket | null
  /** cid → 那条客户端连接。★用 Map 不用 Set:host 要能点名回给某一个。 */
  clients: Map<string, RelaySocket>
  /** 下一个 cid。★只增不减 —— 复用编号会让 host 那边一条刚断的连接的迟到数据落到新连接上。 */
  nextCid: number
}

export type RelayCore = ReturnType<typeof createRelayCore>

/**
 * 撮合核心。**没有 I/O,没有定时器,没有全局状态** —— 全部靠适配器喂进来,
 * 所以它在 Node 和 Durable Object 里行为完全一致,也因此能被完整地单测。
 */
export function createRelayCore() {
  const rooms = new Map<string, Room>()

  const roomOf = (id: string): Room => {
    let r = rooms.get(id)
    if (!r) {
      r = { host: null, clients: new Map(), nextCid: 1 }
      rooms.set(id, r)
    }
    return r
  }

  /** 房间空了就删掉,否则一个公网中转跑几个月会攒出一堆空壳。 */
  const gcRoom = (id: string) => {
    const r = rooms.get(id)
    if (r && !r.host && r.clients.size === 0) rooms.delete(id)
  }

  const status = (s: RelayStatus) => JSON.stringify(s)

  return {
    /** 只读:给适配器做健康检查 / 指标用。 */
    stats: () => ({
      rooms: rooms.size,
      connections: [...rooms.values()].reduce((n, r) => n + (r.host ? 1 : 0) + r.clients.size, 0),
    }),

    /**
     * **重建**一条已经存在的连接,不发任何帧、不分配新 cid。
     *
     * ★★这是给 Cloudflare 的 Durable Object 用的:开了 hibernation 之后,DO 在空闲时会被
     *  整个卸载,**内存里的 `rooms` 全没了**,而 WebSocket 连接**还活着** —— 下一帧到达时
     *  DO 被唤醒,拿到的是一个全新的 `createRelayCore()`。不重建的话,那一帧会落进一个
     *  空房间里被静默丢掉,**症状是「挂了一晚上之后手机再也收不到东西,而两边都显示连着」**。
     *
     * ★为什么不能直接调 `join()` 重建:它会发状态帧(对面会收到一串莫名其妙的 `peer-online`)、
     *  会给客户端**分配新的 cid**(host 那边记的还是旧的,于是每一帧都投递不到)。
     *  重建要的是「原样放回去」,和加入是两件事。
     *
     * ★`nextCid` 要推到所有已恢复 cid 之后 —— 否则下一个新客户端会拿到一个仍在用的编号,
     *  两条逻辑连接的数据就串了。
     */
    restore(sock: RelaySocket, roomId: string, role: Role, cid?: string): void {
      if (!isValidRoom(roomId)) return
      const room = roomOf(roomId)
      if (role === 'host') {
        // ★已经有 host 了就不覆盖:同一个房间只准一个,恢复期也不例外。
        if (!room.host) room.host = sock
        return
      }
      if (!cid) return
      room.clients.set(cid, sock)
      const n = Number(cid)
      if (Number.isFinite(n) && n >= room.nextCid) room.nextCid = n + 1
    },

    /**
     * 一条连接声明自己要加入哪个房间。
     *
     * 拒绝时返回 `{ ok: false }`(适配器应当关掉它)。客户端接受时**带回一个 cid** ——
     * 适配器要把它记住,后面每一帧转发都要用。
     */
    join(sock: RelaySocket, frame: JoinFrame): { ok: false } | { ok: true; cid?: string } {
      const room = roomOf(frame.room)
      if (frame.role === 'host') {
        // ★★同一个房间只能有一个 host,**第二个来的直接拒**。
        //  换成「后来的赢」看起来更顺手(daemon 断线重连不用等旧 socket 超时),但那条路是错的:
        //  房间号是从 **公开的** 公钥算出来的,任何扫过一次配对码的人都拿得到 ——
        //  于是"后来的赢"等于给了每一个见过那个二维码的人一个把真 daemon 永久挤下线的开关。
        //  代价(僵尸 socket 占着房间)由适配器的 keepalive 解决:那是"怎么发现连接死了"的问题,
        //  不该用放宽准入来绕。
        if (room.host) {
          sock.send(status({ t: 'relay', status: 'error', error: '这个房间已经有一台主机连着了' }))
          gcRoom(frame.room)
          return { ok: false }
        }
        room.host = sock
        // 已经在等的客户端立刻知道主机上线了
        for (const c of room.clients.values()) c.send(status({ t: 'relay', status: 'peer-online' }))
        sock.send(status({ t: 'relay', status: room.clients.size ? 'peer-online' : 'waiting' }))
        // ★等在房间里的客户端,要**逐个**向新上线的 host 报到 —— 否则 host 手上没有它们的 cid,
        //  它们发的第一帧到达时 host 会看到一个自己从没 open 过的连接。
        for (const cid of room.clients.keys()) sock.send(JSON.stringify({ t: 'open', cid }))
        return { ok: true }
      }
      if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
        sock.send(status({ t: 'relay', status: 'error', error: '这个房间的客户端数已达上限' }))
        gcRoom(frame.room)
        return { ok: false }
      }
      const cid = String(room.nextCid++)
      room.clients.set(cid, sock)
      sock.send(status({ t: 'relay', status: room.host ? 'peer-online' : 'waiting' }))
      if (room.host) {
        room.host.send(status({ t: 'relay', status: 'peer-online' }))
        room.host.send(JSON.stringify({ t: 'open', cid }))
      }
      return { ok: true, cid }
    },

    /**
     * 转发一帧。**`d` 原样搬,不解析、不改写、不记录。**
     *
     * client 发的 → 套上它的 cid 交给 host
     * host 发的 → 拆开信封,只给信封点名的那一个客户端
     *
     * ★`cid` 是客户端那一侧的编号,由适配器在 join 时记下来再传回来。host 那一侧不传 ——
     *  它写在信封里。
     */
    relay(from: RelaySocket, roomId: string, role: Role, data: string, cid?: string): void {
      const room = rooms.get(roomId)
      if (!room) return
      if (role === 'client') {
        // ★客户端之间**永远不互相转发**。它们彼此没有会话密钥,转过去也只是垃圾;
        //  更要紧的是,那会让一个客户端能往另一个客户端灌东西。
        if (cid) room.host?.send(JSON.stringify({ t: 'data', cid, d: data }))
        return
      }
      const env = parseHostEnvelope(data)
      // ★信封坏了就丢这一帧,**不断 host** —— host 那条连接上驮着这个房间所有客户端,
      //  为一帧坏数据把它断掉是把别人的会话一起赔进去。
      if (!env) return
      const target = room.clients.get(env.cid)
      if (!target) return   // 客户端刚走、响应还在路上:正常时序,静默丢
      if (env.t === 'data') { target.send(env.d); return }
      // host 主动关掉某一条
      room.clients.delete(env.cid)
      target.close(4410, 'closed by host')
      if (room.clients.size === 0) room.host?.send(status({ t: 'relay', status: 'peer-offline' }))
    },

    /** 一条连接断了。客户端要带上它的 cid。 */
    leave(sock: RelaySocket, roomId: string, role: Role, cid?: string): void {
      const room = rooms.get(roomId)
      if (!room) return
      if (role === 'host') {
        if (room.host !== sock) return
        room.host = null
        for (const c of room.clients.values()) c.send(status({ t: 'relay', status: 'peer-offline' }))
      } else {
        if (cid && room.clients.get(cid) === sock) {
          room.clients.delete(cid)
          // host 要知道这条逻辑连接没了,好把它那一侧的会话状态清掉。
          room.host?.send(JSON.stringify({ t: 'close', cid }))
        }
        // ★只有最后一个客户端走了才告诉 host。还剩人连着却报「对端离线」,
        //  会让 daemon 以为没人在看,进而停掉本该继续推的事件。
        if (room.clients.size === 0) room.host?.send(status({ t: 'relay', status: 'peer-offline' }))
      }
      gcRoom(roomId)
    },
  }
}
