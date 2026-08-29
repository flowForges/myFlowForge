import { timingSafeEqual } from 'node:crypto'
import { encodeFrame, decodeFrame, errorText, PROTOCOL_VERSION } from '@shared/remote/protocol'
import type { InvokeCtx, MethodTable } from '../ipc/invokeCtx'

/**
 * 「一条连接上,我们怎么说话」—— 从 `gateway.ts` 里原样抽出来的那一段。
 *
 * ★★为什么要抽:第三期的中转那条路上,**根本没有 `ws` 这个对象**。daemon 只跟中转有一条
 *  socket,上面按 `cid` 复用着 N 条逻辑连接;每条逻辑连接要跑的是**一模一样**的这套
 *  hello → auth → ready → req/res/evt。抽之前想接中转,只有两条路:把 `gateway.ts` 整个复制
 *  一份改吧改吧,或者伪造一个假 `ws` 对象骗它。前者保证漂移(同一个 daemon 两种行为,
 *  是这个项目里最难查的一类问题,`hostClient.ts` 顶上那段注释说的就是这件事),
 *  后者是把接口的形状定成了某个库的实现细节。
 *
 * ★所以这一层只认一个**最小的双工信道**(`Channel`):能发一行文本、能收一行文本、能关、
 *  关了能知道。`ws` 是它的一种实现,中转的一条逻辑连接是另一种,单元测试里的一对数组是第三种。
 *
 * ★**这次抽取是纯搬运,一行行为都不许变**。`gateway.test.ts` 那一整套是它的回归网。
 */

/** 最小双工信道。发的和收的都是**一行文本**(既有协议本来就是 JSON 文本帧)。 */
export type Channel = {
  /** 发一帧。★实现方自己吞掉「已经关了」的写失败 —— 一条写不出去不该炸掉整个网关。 */
  send: (text: string) => void
  /** 收到一帧。只会被调用一次来注册。 */
  onMessage: (cb: (text: string) => void) => void
  /** 主动关掉。`code`/`reason` 对 ws 有意义,对别的实现可以忽略。 */
  close: (code: number, reason: string) => void
  /** 关掉了(不论谁关的)。只会被调用一次来注册。 */
  onClose: (cb: () => void) => void
}

export type ServeOpts = {
  /** 已经筛过的方法表 —— 只包含这台 host 该对外提供的方法(见 channelRouting.daemonTable) */
  table: MethodTable
  /** 方法名清单。★由调用方算好传进来:一条连接一次 `Object.keys` 是白花的。 */
  methods: string[]
  /** 广播总线:每条连接挂一路 sink */
  addSink: (sink: (channel: string, payload: unknown) => void) => () => void
  version: string
  /** 不给 = 不需要鉴权 */
  token?: string
  /** 客户端连上后多久内必须完成鉴权,超时踢掉 */
  authTimeoutMs?: number
  onLog?: (msg: string) => void
}

/** 定长时间比较,避免用「第几个字符开始不一样」把 token 一个字符一个字符试出来。 */
export function tokenMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(got, 'utf8')
  // 长度不同直接不匹配;但仍然跑一次比较,免得「长度对不对」本身变成一个旁路。
  const same = a.length === b.length
  const probe = same ? b : a
  try { return timingSafeEqual(a, probe) && same } catch { return false }
}

/**
 * 在一条信道上服务同一张方法表。**调用方负责在连接关闭时不再喂数据** —— 这里挂了 `onClose`
 * 做清理,但不负责去关信道以外的东西。
 */
export function serveConnection(ch: Channel, opts: ServeOpts): void {
  const authTimeoutMs = opts.authTimeoutMs ?? 15_000
  const log = opts.onLog ?? (() => {})

  let authed = !opts.token
  let offSink: (() => void) | null = null
  let clientLabel = '远程客户端'   // 对方没自报名字时的兜底

  const send = (o: unknown) => {
    // 对面随时可能断。写失败只该丢这一条,不该炸掉整个网关。
    try { ch.send(encodeFrame(o as never)) } catch { /* 信道已关 */ }
  }

  const becomeReady = () => {
    authed = true
    // ★ sink 在【鉴权之后】才挂:没通过鉴权的连接不该收到任何事件。
    offSink = opts.addSink((c, payload) => send({ t: 'evt', ch: c, payload }))
    send({ t: 'ready', methods: opts.methods })
  }

  send({ t: 'hello', protocol: PROTOCOL_VERSION, version: opts.version, authRequired: !!opts.token })
  if (!opts.token) becomeReady()

  const authTimer = opts.token
    ? setTimeout(() => { if (!authed) { log('鉴权超时,断开'); ch.close(4401, 'auth timeout') } }, authTimeoutMs)
    : null

  ch.onMessage((raw) => {
    const d = decodeFrame(raw)
    if (!d.ok) { log(`丢弃一条坏帧: ${d.error}`); return }
    const f = d.frame

    if (f.t === 'auth') {
      if (!opts.token) return                       // 不需要鉴权时收到 auth:无视,别当错误
      if (authed) return                            // 重复 auth:无视
      if (!tokenMatches(opts.token, f.token)) { log('token 不对,断开'); ch.close(4403, 'bad token'); return }
      if (authTimer) clearTimeout(authTimer)
      becomeReady()
      return
    }

    if (!authed) {
      // ★没鉴权就发命令 —— 直接断。不回错误码,不给试探的余地。
      log('鉴权前发来命令,断开')
      ch.close(4401, 'unauthenticated')
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
      emit: (c, payload) => send({ t: 'evt', ch: c, payload }),
      client: { id: 'remote', label: clientLabel },
    }
    // 同步抛和异步 reject 都要接住,而且都必须变成一条 res —— 少回一条 res,
    // 对面那个 promise 就永远不 settle。
    void (async () => {
      try { send({ t: 'res', id: f.id, ok: true, value: await fn(ctx, ...f.args) }) }
      catch (e) { send({ t: 'res', id: f.id, ok: false, error: errorText(e) }) }
    })()
  })

  ch.onClose(() => {
    if (authTimer) clearTimeout(authTimer)
    offSink?.()
  })
}
