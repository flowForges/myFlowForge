import { WebSocketServer, type WebSocket } from 'ws'
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
  onLog?: (msg: string) => void
  /** 连上 / 断开时叫一声。设置里那句「当前有 N 台设备连着」靠它才不会是个死数字。 */
  onClientsChanged?: () => void
}

export type GatewayHandle = {
  port: number
  host: string
  clientCount: () => number
  close: () => Promise<void>
}

/** `ws` 的一条连接 → `serveConnection` 认的那个最小信道。 */
function wsChannel(ws: WebSocket): Channel {
  return {
    send: (text) => { try { ws.send(text) } catch { /* socket 已关 */ } },
    // ★`isBinary` 那一路要转成文本再给上层:协议本来就是 JSON 文本,
    //  而 `ws` 会按对面发的是 text 还是 binary 帧给出不同的东西。
    onMessage: (cb) => ws.on('message', (raw, isBinary) => cb(isBinary ? (raw as Buffer).toString('utf8') : String(raw))),
    close: (code, reason) => { try { ws.close(code, reason) } catch { /* 已关 */ } },
    onClose: (cb) => ws.on('close', cb),
  }
}

/**
 * 对外服务同一张方法表的 WS 网关。
 *
 * 「同一张」是关键:Electron 侧走 IPC 遍历它,这里走 WS 遍历它 —— 方法只有一份,
 * 所以不存在「本机一条路径、远程另一条路径」的漂移(设计文档第三节)。
 *
 * ★★2026-08-29:这个文件**只剩「监听端口 + 数连接数」**。每条连接上到底怎么说话
 *  (hello/auth/ready/req/res/evt)搬到了 `serveConnection.ts` —— 因为第三期的中转那条路
 *  上没有 `ws` 对象可用,而那套对话必须是**同一份**。理由完整版在那个文件顶上。
 */
export async function startGateway(opts: GatewayOpts): Promise<GatewayHandle> {
  const host = opts.host ?? '127.0.0.1'
  const log = opts.onLog ?? (() => {})
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
    ws.on('close', () => {
      conns.delete(ws)
      opts.onClientsChanged?.()
    })
    ws.on('error', () => { /* 'close' 会跟着来,清理在那儿做 */ })

    serveConnection(wsChannel(ws), {
      table: opts.table,
      methods,
      addSink: opts.addSink,
      version: opts.version,
      token: opts.token,
      authTimeoutMs: opts.authTimeoutMs,
      onLog: log,
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
