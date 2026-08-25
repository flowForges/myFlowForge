import { WebSocketServer, type WebSocket } from 'ws'
import { createRelayCore, parseJoin, type RelaySocket, type Role } from './core'

/**
 * Node / Docker 适配器(设计文档第八节的 `node.ts`)。
 *
 * 给有 VPS 的人用,`docker run` 一条命令。撮合逻辑和 Cloudflare Worker 版**是同一份**
 * (`core.ts`),这里只负责把 `ws` 的 API 接上去。
 *
 * ⚠️ 文档里的提醒照抄一遍:**别把自己的小带宽 VPS 当公共中转。**
 * 中转是全流量转发。放 Cloudflare 上带宽是 Cloudflare 出的;VPS 应该留着跑 daemon。
 */

export type RelayOptions = {
  port: number
  host?: string
  /** 一条连接在说出 join 之前最多能赖多久。默认 10 秒。 */
  joinTimeoutMs?: number
  /** 单帧字节上限。默认 32 MiB,和 Cloudflare 的上限对齐。 */
  maxFrameBytes?: number
  onLog?: (msg: string) => void
}

export type RelayHandle = {
  port: number
  stats: () => { rooms: number; connections: number }
  close: () => Promise<void>
}

export async function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  const log = opts.onLog ?? (() => {})
  const joinTimeoutMs = opts.joinTimeoutMs ?? 10_000
  const maxFrameBytes = opts.maxFrameBytes ?? 32 * 1024 * 1024
  const core = createRelayCore()

  const wss = new WebSocketServer({ host: opts.host ?? '0.0.0.0', port: opts.port, maxPayload: maxFrameBytes })
  await new Promise<void>((res, rej) => {
    wss.once('listening', res)
    wss.once('error', rej)
  })

  wss.on('connection', (ws: WebSocket) => {
    const sock: RelaySocket = {
      send: (d) => {
        // 对面可能已经断了。中转绝不能因为一条连接挂了就崩 —— 它服务的是别人的所有会话。
        try {
          if (ws.readyState === ws.OPEN) ws.send(d)
        } catch {
          /* 那条连接的事,不影响别人 */
        }
      },
      close: (code, reason) => {
        try {
          ws.close(code ?? 1000, reason ?? '')
        } catch {
          /* 已经关了 */
        }
      },
    }

    let joined: { room: string; role: Role } | null = null

    // ★没说 join 就一直连着的,踢掉。不然任何人都能靠攒空连接把中转的文件描述符耗光。
    const timer = setTimeout(() => {
      if (!joined) {
        log('踢掉一条迟迟不 join 的连接')
        sock.close(4408, 'join timeout')
      }
    }, joinTimeoutMs)

    ws.on('message', (raw: unknown, isBinary: boolean) => {
      // ★二进制帧一律拒。协议是文本的;放行二进制等于多开一条没人测过的路径。
      if (isBinary) return sock.close(4400, 'binary not supported')
      const data = String(raw)

      if (!joined) {
        const frame = parseJoin(data)
        if (!frame) {
          log('第一帧不是合法的 join,关掉')
          return sock.close(4400, 'bad join')
        }
        if (!core.join(sock, frame)) return sock.close(4409, 'room busy')
        joined = { room: frame.room, role: frame.role }
        clearTimeout(timer)
        log(`join room=${frame.room.slice(0, 8)}… role=${frame.role}`)
        return
      }
      // ★★join 之后这里**不看内容**,原样搬。中转是哑管道 —— 这一行是整个安全模型的落点。
      core.relay(sock, joined.room, joined.role, data)
    })

    ws.on('close', () => {
      clearTimeout(timer)
      if (joined) core.leave(sock, joined.room, joined.role)
    })
    // ★错误事件**必须接住**。不接的话 'error' 会变成 uncaught exception 把整个中转带走 ——
    //  一条连接的问题干掉所有人的会话。这一点是这个监听器存在的主要理由。
    //
    // ★这里的 leave 是 close 的**冗余兜底**,而且测试钉不住它:`ws` 在 error 之后总会再发 close,
    //  所以把它删掉没有任何可观察的差别(变异测试确认过,这是个等价变异)。留着的理由是
    //  `core.leave` 本身幂等,多调一次没代价,而万一某条错误路径真的不发 close,
    //  代价是一个永远回收不掉的房间 —— 一台长跑几个月的公网中转经不起这个。
    ws.on('error', () => {
      clearTimeout(timer)
      if (joined) core.leave(sock, joined.room, joined.role)
    })
  })

  const port = (wss.address() as { port: number }).port
  log(`中转在 ws://${opts.host ?? '0.0.0.0'}:${port}`)

  return {
    port,
    stats: core.stats,
    close: () =>
      new Promise<void>((res) => {
        for (const c of wss.clients) {
          try {
            c.terminate()
          } catch {
            /* 无所谓 */
          }
        }
        wss.close(() => res())
      }),
  }
}
