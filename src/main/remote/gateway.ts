import { WebSocketServer, type WebSocket } from 'ws'
import { timingSafeEqual } from 'node:crypto'
import { encodeFrame, decodeFrame, errorText, PROTOCOL_VERSION } from '@shared/remote/protocol'
import type { InvokeCtx, MethodTable } from '../ipc/invokeCtx'

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
}

/** 定长时间比较,避免用「第几个字符开始不一样」把 token 一个字符一个字符试出来。 */
function tokenMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(got, 'utf8')
  // 长度不同直接不匹配;但仍然跑一次比较,免得「长度对不对」本身变成一个旁路。
  const same = a.length === b.length
  const probe = same ? b : a
  try { return timingSafeEqual(a, probe) && same } catch { return false }
}

/**
 * 对外服务同一张方法表的 WS 网关。
 *
 * 「同一张」是关键:Electron 侧走 IPC 遍历它,这里走 WS 遍历它 —— 方法只有一份,
 * 所以不存在「本机一条路径、远程另一条路径」的漂移(设计文档第三节)。
 */
export async function startGateway(opts: GatewayOpts) {
  const host = opts.host ?? '127.0.0.1'
  const authTimeoutMs = opts.authTimeoutMs ?? 15_000
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
    let authed = !opts.token
    let offSink: (() => void) | null = null
    let clientLabel = '远程客户端'   // 对方没自报名字时的兜底

    const send = (o: unknown) => {
      // 对面随时可能断。写失败只该丢这一条,不该炸掉整个网关。
      try { ws.send(encodeFrame(o as never)) } catch { /* socket 已关 */ }
    }

    const becomeReady = () => {
      authed = true
      // ★ sink 在【鉴权之后】才挂:没通过鉴权的连接不该收到任何事件。
      offSink = opts.addSink((ch, payload) => send({ t: 'evt', ch, payload }))
      send({ t: 'ready', methods })
    }

    send({ t: 'hello', protocol: PROTOCOL_VERSION, version: opts.version, authRequired: !!opts.token })
    if (!opts.token) becomeReady()

    const authTimer = opts.token
      ? setTimeout(() => { if (!authed) { log('鉴权超时,断开'); ws.close(4401, 'auth timeout') } }, authTimeoutMs)
      : null

    ws.on('message', (raw, isBinary) => {
      const d = decodeFrame(isBinary ? (raw as Buffer) : String(raw))
      if (!d.ok) { log(`丢弃一条坏帧: ${d.error}`); return }
      const f = d.frame

      if (f.t === 'auth') {
        if (!opts.token) return                       // 不需要鉴权时收到 auth:无视,别当错误
        if (authed) return                            // 重复 auth:无视
        if (!tokenMatches(opts.token, f.token)) { log('token 不对,断开'); ws.close(4403, 'bad token'); return }
        if (authTimer) clearTimeout(authTimer)
        becomeReady()
        return
      }

      if (!authed) {
        // ★没鉴权就发命令 —— 直接断。不回错误码,不给试探的余地。
        log('鉴权前发来命令,断开')
        ws.close(4401, 'unauthenticated')
        return
      }

      if (f.t === 'identify') { clientLabel = f.label.trim() || clientLabel; return }
      if (f.t === 'ping') { send({ t: 'pong' }); return }
      if (f.t !== 'req') return                       // res/evt/hello/ready 是服务端发的,客户端发来就无视

      const fn = opts.table[f.ch]
      if (!fn) {
        // 版本不一致时会走到这儿。回一个能看见的错误,别静默丢 —— 静默丢等于对面永远挂着。
        send({ t: 'res', id: f.id, ok: false, error: `这台机器没有这个方法: ${f.ch}` })
        return
      }
      const ctx: InvokeCtx = {
        emit: (ch, payload) => send({ t: 'evt', ch, payload }),
        client: { id: 'remote', label: clientLabel },
      }
      // 同步抛和异步 reject 都要接住,而且都必须变成一条 res —— 少回一条 res,
      // 对面那个 promise 就永远不 settle。
      void (async () => {
        try { send({ t: 'res', id: f.id, ok: true, value: await fn(ctx, ...f.args) }) }
        catch (e) { send({ t: 'res', id: f.id, ok: false, error: errorText(e) }) }
      })()
    })

    ws.on('close', () => {
      if (authTimer) clearTimeout(authTimer)
      offSink?.()
      conns.delete(ws)
    })
    ws.on('error', () => { /* 'close' 会跟着来,清理在那儿做 */ })
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
