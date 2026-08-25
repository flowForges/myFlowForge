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
  clients: Set<RelaySocket>
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
      r = { host: null, clients: new Set() }
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
     * 一条连接声明自己要加入哪个房间。
     * 返回 false 表示拒绝(适配器应当关掉它)。
     */
    join(sock: RelaySocket, frame: JoinFrame): boolean {
      const room = roomOf(frame.room)
      if (frame.role === 'host') {
        // ★同一个房间只能有一个 host。第二个来的直接拒 ——
        //  换成「踢掉旧的」的话,任何知道公钥的人都能把真 daemon 挤下线(公钥是公开的)。
        if (room.host) {
          sock.send(status({ t: 'relay', status: 'error', error: '这个房间已经有一台主机连着了' }))
          gcRoom(frame.room)
          return false
        }
        room.host = sock
        // 已经在等的客户端立刻知道主机上线了
        for (const c of room.clients) c.send(status({ t: 'relay', status: 'peer-online' }))
        sock.send(status({ t: 'relay', status: room.clients.size ? 'peer-online' : 'waiting' }))
        return true
      }
      if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
        sock.send(status({ t: 'relay', status: 'error', error: '这个房间的客户端数已达上限' }))
        gcRoom(frame.room)
        return false
      }
      room.clients.add(sock)
      sock.send(status({ t: 'relay', status: room.host ? 'peer-online' : 'waiting' }))
      if (room.host) room.host.send(status({ t: 'relay', status: 'peer-online' }))
      return true
    },

    /**
     * 转发一帧。**原样搬,不解析、不改写、不记录内容。**
     *
     * host 发的 → 广播给这个房间所有客户端(桌面端和手机可能同时连着)
     * client 发的 → 只给 host
     */
    relay(from: RelaySocket, roomId: string, role: Role, data: string): void {
      const room = rooms.get(roomId)
      if (!room) return
      if (role === 'host') {
        for (const c of room.clients) c.send(data)
      } else {
        // ★客户端之间**永远不互相转发**。它们彼此没有会话密钥,转过去也只是垃圾;
        //  更要紧的是,那会让一个客户端能往另一个客户端灌东西。
        room.host?.send(data)
      }
    },

    /** 一条连接断了。 */
    leave(sock: RelaySocket, roomId: string, role: Role): void {
      const room = rooms.get(roomId)
      if (!room) return
      if (role === 'host') {
        if (room.host !== sock) return
        room.host = null
        for (const c of room.clients) c.send(status({ t: 'relay', status: 'peer-offline' }))
      } else {
        room.clients.delete(sock)
        // ★只有最后一个客户端走了才告诉 host。还剩人连着却报「对端离线」,
        //  会让 daemon 以为没人在看,进而停掉本该继续推的事件。
        if (room.clients.size === 0) room.host?.send(status({ t: 'relay', status: 'peer-offline' }))
      }
      gcRoom(roomId)
    },
  }
}
