import { WebSocket } from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { decodeFrame, encodeFrame, PROTOCOL_VERSION } from '@shared/remote/protocol'
import { clientE2ELink, type E2ELink } from '@shared/remote/e2eChannel'
import type { Channel } from '@shared/remote/channel'
import { asRelayStatus, joinFrame } from '@shared/remote/relayWire'
import { fromBase64 } from '@shared/remote/base64'
import { pickProxy, proxyUsable } from './wsProxy'

export type RemoteState =
  | { status: 'connecting'; attempt: number }
  | { status: 'ready'; version: string; methods: ReadonlySet<string> }
  | { status: 'retrying'; attempt: number; error: string; nextInMs: number }
  /** 重试也没用的那类失败(协议对不上、token 不对、主版本不兼容)。不再自动重连。 */
  | { status: 'failed'; error: string }
  | { status: 'closed' }

export type RemoteClient = {
  invoke(ch: string, args: unknown[]): Promise<unknown>
  state(): RemoteState
  onState(cb: (s: RemoteState) => void): () => void
  close(): Promise<void>
}

export type ConnectOpts = {
  url: string
  token?: string
  /**
   * 对面 daemon 的长期公钥(base64)。**有它就端到端加密**,直连也加密。
   * ★没有 = 明文直连(老记录 / 局域网)。这一条和手机端 `hostClient.ts` 是同一套判据。
   */
  pubKey?: string
  /**
   * 中转地址。有它就不连 `url` 而是拨中转、进 daemon 的房间。
   * ★★必须同时有 `pubKey` —— 没有身份验证的中转是把令牌和全部内容交给第三方,
   *  这里当**配置错误直接失败**,绝不悄悄降级。
   */
  relayUrl?: string
  /** 「app 自身的网络」代理(设置 → 网络 的 appProxy)。★只对 `wss://` 的中转生效。 */
  proxy?: string
  /** 本客户端的版本,用来跟 daemon 比主版本号(决策 B-2) */
  clientVersion: string
  /** 自报的名字,对面在「是谁答的门」里显示。纯展示,不是凭证。 */
  clientLabel?: string
  onEvent: (channel: string, payload: unknown) => void
  onState?: (s: RemoteState) => void
  onLog?: (msg: string) => void
  /** 退避参数;false = 不自动重连(测试用) */
  backoff?: { baseMs: number; maxMs: number } | false
  /** invoke 在「还没 ready」时最多等多久 —— 重连中的短暂空窗不该让调用直接失败 */
  readyTimeoutMs?: number
}

const major = (v: string) => v.split('.')[0] ?? ''

export function connectRemote(opts: ConnectOpts): RemoteClient {
  const backoff = opts.backoff === false ? null : (opts.backoff ?? { baseMs: 500, maxMs: 15_000 })
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000
  const log = opts.onLog ?? (() => {})

  let ws: WebSocket | null = null
  let state: RemoteState = { status: 'connecting', attempt: 1 }
  let attempt = 1
  let disposed = false
  let retryTimer: NodeJS.Timeout | null = null
  let nextId = 1

  /**
   * 这一次连接是怎么走的。
   * ★★三档,判据只有两个字段,**别在别处再判一遍**(和手机端 `hostClient.ts` 逐字同一套):
   *  · 没有 pubKey                → 明文直连(老记录;局域网上没有第三方)
   *  · 有 pubKey、没有 relayUrl   → 直连 + 端到端加密
   *  · 两个都有                   → 中转 + 端到端加密
   */
  const trustedPub = opts.pubKey ? fromBase64(opts.pubKey) : null
  const encrypted = !!trustedPub && trustedPub.length === 32
  const relayUrl = opts.relayUrl?.trim() || ''
  // ★★有中转地址却没有(或解不出)公钥时**不许**悄悄降级成明文中转 —— 那正是这一层要防的事。
  //  当配置错误直接失败,让人看得见。
  const badRelay = !!relayUrl && !encrypted

  /**
   * 发一帧协议帧的出口。加密开着就走加密层,否则直接落 socket。
   * ★挂在这一层而不是 `open()` 里:`invoke` 也要用它,而 `open()` 每次重连都重建。
   */
  let sendFrame: (o: unknown) => void = () => { throw new Error('还没连上') }

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const stateWaiters = new Set<(s: RemoteState) => void>()

  const setState = (s: RemoteState) => {
    state = s
    opts.onState?.(s)
    for (const cb of [...stateWaiters]) cb(s)
  }

  /**
   * ★socket 一断,所有还在飞的请求必须**立刻 reject**。
   * 不 reject 的话它们永远不 settle —— 界面上不是报错,是一个永远转下去的圈,
   * 而且用户完全看不出跟断线有关。
   */
  const rejectAllPending = (why: string) => {
    for (const [, p] of pending) p.reject(new Error(why))
    pending.clear()
  }

  const scheduleRetry = (why: string) => {
    if (disposed || !backoff) { setState({ status: 'closed' }); return }
    const delay = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (attempt - 1))
    setState({ status: 'retrying', attempt, error: why, nextInMs: delay })
    retryTimer = setTimeout(() => { attempt++; open() }, delay)
  }

  /** 重试也没用的失败:别用退避把同一个错误刷一整晚的日志。 */
  const fail = (why: string) => {
    disposed = true
    rejectAllPending(why)
    try { ws?.close() } catch { /* 已关 */ }
    setState({ status: 'failed', error: why })
  }

  /**
   * 拨号选项。**只在这一处决定要不要套代理**,而且不管走不走都留一行日志 ——
   * 「有没有过代理」是这条链路最容易猜错、也最难从现象反推的一件事。
   *
   * ★★这不是可选的防御:`ws` **不认 `http_proxy` 环境变量**(和 curl / npm 不一样),不给 agent
   *  就直连。而直连一个够不着的地址**不拒绝、不重置、永远不回** —— 界面上只能显示「正在连」,
   *  和「地址写错」「服务没起来」长得一模一样。2026-08-31 daemon 那一侧就是这么卡住的,
   *  这里是同一个坑的客户端侧。★只对 `wss://` 套(`ws://` 要另一个 agent,socks 同理),
   *  两种都记日志说明。
   */
  function wsOptions(): { agent?: HttpsProxyAgent<string> } {
    if (!relayUrl) return {}
    const pick = pickProxy(opts.proxy, process.env)
    if (!pick.use) { log(`直连中转(${pick.why})`); return {} }
    const usable = proxyUsable(relayUrl, pick.url)
    if (!usable.ok) { log(usable.why); return {} }
    log(`经代理连中转:${pick.url}(来自${pick.from === 'setting' ? '设置' : '环境变量'})`)
    try {
      return { agent: new HttpsProxyAgent(pick.url) }
    } catch (e) {
      // 代理地址畸形是同步抛的。★不能让它把整条连接打死 —— 退回直连并说清楚。
      log(`代理地址用不了(${e instanceof Error ? e.message : String(e)}),改直连`)
      return {}
    }
  }

  function open() {
    if (disposed) return
    if (badRelay) {
      return fail('这台主机配了中转但没有身份公钥 —— 请在那台电脑上重新复制配对码')
    }
    setState({ status: 'connecting', attempt })
    // 走中转时连的是**中转**,不是主机地址。主机地址那时只是个记录,连不到。
    const sock = new WebSocket(relayUrl || opts.url, wsOptions())
    ws = sock
    // hello 里的版本号要留到 ready 时一起报出去(ready 帧本身不带版本)。
    let peerVersion = ''

    /** 加密层。明文直连时是 null。 */
    let link: E2ELink | null = null
    /** 握完手之后拿到的那条信道 —— 协议帧从这儿发。明文时是 null。 */
    let sealed: Channel | null = null
    /** 走中转时:进房间了没有。 */
    let joined = false
    /**
     * 发过 auth 帧没有。★★用来把中转那一跳的 4410 翻译成人话。
     *
     * 中转**丢掉了关闭码**:daemon 那边 `serveConnection` 用 4403 关掉这条逻辑连接,
     * 但 `hostClose(cid)` 只带 cid,中转一律用 `4410 closed by host` 关客户端 socket
     * (`relay/src/core.ts:250`)。所以「令牌不对」到了这儿长得和普通断线一模一样,
     * 而普通断线是要退避重连的 —— 结果就是**用一把错令牌永远重试下去**,界面上一直「连接中」。
     * ★不改协议(要动已经部署的中转)也能判准:4410 的语义是「对面**主动**关掉了这条逻辑连接」
     *  —— 而对面主动关、且我们**还没 ready**、且我们**刚发过令牌**,只可能是它拒了这把令牌。
     *  (daemon 掉线是另一条路:中转发的是 `peer-offline` 状态帧,socket 不关。)
     */
    let sentAuth = false

    sendFrame = (o: unknown) => {
      const text = encodeFrame(o as never)
      if (sealed) sealed.send(text)
      else sock.send(text)
    }

    /** 起加密握手。★中转模式要等进了房间才起 —— 房间里没人的话,hs-init 发出去没人接。 */
    const startE2E = () => {
      if (!encrypted || link) return
      link = clientE2ELink(
        trustedPub!,
        {
          sendRaw: (t) => { try { sock.send(t) } catch { /* 已断 */ } },
          closeRaw: () => { try { sock.close() } catch { /* 已关 */ } },
          onLog: log,
        },
        (ch) => {
          sealed = ch
          ch.onMessage((t) => handleProtocol(t))
        },
        // ★★验签失败是**重试也没用**的:对面不是你配对的那台机器,或者中间有人。
        //  用退避重连去刷它,只会把一个安全事件变成一个「一直在转圈」。
        (why) => fail(why),
      )
    }

    sock.on('open', () => {
      if (relayUrl) {
        log(`已连上中转 ${relayUrl},进房间`)
        // ★房间号 = daemon 公钥的 base64 —— 也就是配对码里那个 `k` **原样**。
        //  两端各自算得出,不需要在中转注册任何东西。
        try { sock.send(JSON.stringify(joinFrame('client', opts.pubKey!))) } catch { /* 已断 */ }
        return
      }
      log(`已连上 ${opts.url}`)
      startE2E()
    })

    sock.on('message', (raw, isBinary) => {
      const text = isBinary ? (raw as Buffer).toString('utf8') : String(raw)

      // ── ① 中转自己的状态帧。★它不属于两端的对话,而且**只在中转模式下才可能出现**。
      if (relayUrl) {
        const st = asRelayStatus(text)
        if (st) {
          if (st.status === 'error') return fail(st.error || '中转拒绝了这次连接')
          if (st.status === 'peer-online') {
            if (!joined) { joined = true; log('对面在线,开始握手'); startE2E() }
            return
          }
          if (st.status === 'waiting') {
            // ★房间里还没有 daemon。**这不是错误** —— 那台电脑可能只是还没开机。
            //  保持连着等它上线(上线时中转会推 peer-online),别退避重连:
            //  重连只会把「等着」变成一串连接噪音。
            log('对面还没上线,等着')
            return
          }
          if (st.status === 'peer-offline') {
            // ★把在飞的请求立刻 reject —— 不 reject 的话它们永远不 settle,
            //  界面上是一个永远转下去的圈,而且完全看不出跟掉线有关。
            joined = false
            rejectAllPending('对面掉线了')
            setState({ status: 'retrying', attempt, error: '对面掉线了', nextInMs: 0 })
            return
          }
          return
        }
      }

      // ── ② 加密层。密文在这儿被拆开,明文经 `handleProtocol` 往下走。
      if (encrypted) {
        if (!link) return log('还没起握手就收到东西,丢掉')
        link.receive(text)
        return
      }
      handleProtocol(text)
    })

    /** 一帧**明文的**协议帧。加密与否、走不走中转,到这儿都已经没有区别了。 */
    function handleProtocol(text: string) {
      const d = decodeFrame(text)
      if (!d.ok) { log(`丢弃一条坏帧: ${d.error}`); return }
      const f = d.frame

      if (f.t === 'hello') {
        peerVersion = f.version
        if (f.protocol !== PROTOCOL_VERSION) {
          return fail(`协议版本对不上(对方 ${f.protocol},本机 ${PROTOCOL_VERSION}),请把两端升到同一版本`)
        }
        if (major(f.version) !== major(opts.clientVersion)) {
          // 决策 B-2:主版本不一致拒绝这一条连接。次版本差异靠 ready.methods 置灰兜住。
          return fail(`主版本不兼容(对方 ${f.version},本机 ${opts.clientVersion})`)
        }
        if (f.authRequired) {
          if (!opts.token) return fail('这台主机需要访问令牌,但没有配置')
          sentAuth = true
          sendFrame({ t: 'auth', token: opts.token })
        }
        return
      }

      if (f.t === 'ready') {
        // 自报家门:让对面在系统提示里说得出「是哪台设备答的门」。
        if (opts.clientLabel) { try { sendFrame({ t: 'identify', label: opts.clientLabel }) } catch { /* 已断 */ } }
        attempt = 1
        setState({ status: 'ready', version: peerVersion, methods: new Set(f.methods) })
        return
      }
      if (f.t === 'evt') { opts.onEvent(f.ch, f.payload); return }
      if (f.t === 'res') {
        const p = pending.get(f.id)
        if (!p) return                      // 迟到的响应(比如断线重连前发出的);丢掉即可
        pending.delete(f.id)
        if (f.ok) p.resolve(f.value); else p.reject(new Error(f.error))
        return
      }
    }

    sock.on('close', (code, reason) => {
      if (ws !== sock) return                // 已经被换掉的旧 socket,不管
      // ★4410 = 中转替对面转达的「主动关掉这条逻辑连接」(关闭码在那一跳丢了,见 `sentAuth`)。
      //  还没 ready 就被这么关掉、而且刚发过令牌 —— 那就是令牌被拒了。用退避去刷它没有意义。
      const relayRejected = code === 4410 && sentAuth && state.status !== 'ready'
      const why = code === 4403 || relayRejected ? 'token 不对,被对方拒绝'
        : code === 4401 ? '鉴权失败'
        : `连接断开(${code}${reason?.length ? ' ' + String(reason) : ''})`
      rejectAllPending(why)
      if (code === 4403 || code === 4401 || relayRejected) return fail(why)
      scheduleRetry(why)
    })

    sock.on('error', (e) => { log(`socket 出错: ${e.message}`) })   // 'close' 会跟着来
  }

  open()

  const waitReady = () => new Promise<void>((resolve, reject) => {
    if (state.status === 'ready') return resolve()
    if (state.status === 'failed') return reject(new Error(state.error))
    const t = setTimeout(() => { stateWaiters.delete(onS); reject(new Error('等待连接就绪超时')) }, readyTimeoutMs)
    const onS = (s: RemoteState) => {
      if (s.status === 'ready') { clearTimeout(t); stateWaiters.delete(onS); resolve() }
      else if (s.status === 'failed' || s.status === 'closed') { clearTimeout(t); stateWaiters.delete(onS); reject(new Error(s.status === 'failed' ? s.error : '连接已关闭')) }
    }
    stateWaiters.add(onS)
  })

  return {
    state: () => state,
    onState(cb) { stateWaiters.add(cb); return () => { stateWaiters.delete(cb) } },
    async invoke(ch, args) {
      // 重连中的短暂空窗不该让调用直接失败,等一会儿再说。
      if (state.status !== 'ready') await waitReady()
      const sock = ws
      if (!sock || sock.readyState !== sock.OPEN) throw new Error('连接不可用')
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try { sendFrame({ t: 'req', id, ch, args }) }
        catch (e) { pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))) }
      })
    },
    async close() {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      rejectAllPending('连接已关闭')
      const sock = ws
      ws = null
      setState({ status: 'closed' })
      // ★不能无条件等 'close':socket 可能早就关了(断线中、或握手失败时我们自己关的),
      // 那个事件不会再来第二次,await 就永远挂着 —— 表现为「断网时退出 app 卡死」。
      if (!sock || sock.readyState === sock.CLOSED) return
      await new Promise<void>((res) => {
        let done = false
        const finish = () => { if (!done) { done = true; res() } }
        sock.once('close', finish)
        // 还在握手途中的连接 close() 不一定收得住,terminate 是确定的。
        try { sock.readyState === sock.CONNECTING ? sock.terminate() : sock.close() } catch { finish() }
        // 最后一道兜底:退出流程绝不能被一个 socket 拖住。
        setTimeout(finish, 1000).unref?.()
      })
    },
  }
}
