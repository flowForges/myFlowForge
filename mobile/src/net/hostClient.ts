import {
  decodeFrame,
  encodeFrame,
  PROTOCOL_VERSION,
} from '../../../src/shared/remote/protocol'
import { clientE2ELink, type E2ELink } from '../../../src/shared/remote/e2eChannel'
import type { Channel } from '../../../src/shared/remote/channel'
import { asRelayStatus, joinFrame } from '../../../src/shared/remote/relayWire'
import { fromBase64 } from '../../../src/shared/remote/base64'

/**
 * 手机端的远程主机客户端。
 *
 * 语义**照搬** `src/main/remote/remoteClient.ts`(桌面端主进程那一份),因为它已经把线协议的
 * 边角情况踩完了 —— 版本不兼容、鉴权失败、断线时在飞的请求、退出时的幂等关闭。
 * 两边不能各写一套:同一个 daemon,两种客户端行为,那是最难查的一类问题。
 *
 * 与桌面端的**唯一实现差异**:这里用平台自带的 `WebSocket`(RN / 浏览器都有),
 * 不是 node 的 `ws` 包。所以:
 *   - 用 `addEventListener` 而不是 `.on()`
 *   - 没有 `terminate()`,只有 `close()`
 *   - `readyState` 常量挂在实例/构造器上,数值与 node 版一致(0..3)
 */

export type HostState =
  | { status: 'connecting'; attempt: number }
  | { status: 'ready'; version: string; methods: ReadonlySet<string> }
  | { status: 'retrying'; attempt: number; error: string; nextInMs: number }
  /** 重试也没用的那类失败(协议对不上、token 不对、主版本不兼容)。不再自动重连。 */
  | { status: 'failed'; error: string }
  | { status: 'closed' }

export type HostClient = {
  invoke(ch: string, args?: unknown[]): Promise<unknown>
  state(): HostState
  onState(cb: (s: HostState) => void): () => void
  close(): void
}

export type ConnectOpts = {
  url: string
  token?: string
  /** 本客户端的版本,用来跟对面比主版本号(决策 B-2) */
  clientVersion: string
  /** 自报的名字,对面在「是谁答的门」里显示。纯展示,不是凭证。 */
  clientLabel?: string
  onEvent: (channel: string, payload: unknown) => void
  onState?: (s: HostState) => void
  onLog?: (msg: string) => void
  /** 退避参数;false = 不自动重连(测试用) */
  backoff?: { baseMs: number; maxMs: number } | false
  /** invoke 在「还没 ready」时最多等多久 —— 重连中的短暂空窗不该让调用直接失败 */
  readyTimeoutMs?: number
  /**
   * daemon 的长期公钥(base64,来自配对二维码)。**有它就走端到端加密。**
   *
   * ★没有它 = 老版本配对码 = 明文直连。局域网上那条链路没有第三方,所以这仍然成立,
   *  但只要有,就该加密 —— 同一套代码,少一跳,安全性更高。
   */
  pubKey?: string
  /**
   * 中转地址。有它就**不直连**,改成拨号到中转、进 daemon 的房间。
   * ★★必须同时有 `pubKey`。没有身份验证的中转 = 把令牌和全部内容交给一台第三方服务器,
   *  配对链接那一层已经拒掉了这种组合(见 `pairingLink.ts`),这里再挡一次:
   *  两处都挡是因为这条路也可能被手工构造的 host 记录走到。
   */
  relayUrl?: string
}

const major = (v: string) => v.split('.')[0] ?? ''

export function connectHost(opts: ConnectOpts): HostClient {
  const backoff = opts.backoff === false ? null : opts.backoff ?? { baseMs: 500, maxMs: 15_000 }
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000
  const log = opts.onLog ?? (() => {})

  let ws: WebSocket | null = null
  let state: HostState = { status: 'connecting', attempt: 1 }
  let attempt = 1
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let nextId = 1

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  // ★协议帧的唯一出口。`open()` 每次重连都会重建它(加密模式下它指向的是加密信道),
  //  所以放在一个 ref 上而不是闭包变量里 —— `invoke` 活在 open() 外面。
  const sendRef: { current: ((o: unknown) => void) | null } = { current: null }
  const stateWaiters = new Set<(s: HostState) => void>()

  const setState = (s: HostState) => {
    state = s
    opts.onState?.(s)
    for (const cb of [...stateWaiters]) cb(s)
  }

  /**
   * ★socket 一断,所有还在飞的请求必须**立刻 reject**。
   * 不 reject 的话它们永远不 settle —— 界面上不是报错,是一个永远转下去的圈,
   * 而且用户完全看不出跟断线有关。手机比桌面更容易撞上这个(切后台、走出 wifi)。
   */
  const rejectAllPending = (why: string) => {
    for (const [, p] of pending) p.reject(new Error(why))
    pending.clear()
  }

  const scheduleRetry = (why: string) => {
    if (disposed || !backoff) {
      setState({ status: 'closed' })
      return
    }
    const delay = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (attempt - 1))
    setState({ status: 'retrying', attempt, error: why, nextInMs: delay })
    retryTimer = setTimeout(() => {
      attempt++
      open()
    }, delay)
  }

  /** 重试也没用的失败:别用退避把同一个错误刷一整晚。 */
  const fail = (why: string) => {
    disposed = true
    sendRef.current = null
    rejectAllPending(why)
    try {
      ws?.close()
    } catch {
      /* 已关 */
    }
    setState({ status: 'failed', error: why })
  }

  /**
   * 这一次连接是怎么走的。
   * ★三档,判据只有两个字段,别在别处再判一遍:
   *  · 没有 pubKey                → 明文直连(老配对码;局域网上没有第三方)
   *  · 有 pubKey、没有 relayUrl   → 直连 + 端到端加密
   *  · 两个都有                   → 中转 + 端到端加密
   */
  const trustedPub = opts.pubKey ? fromBase64(opts.pubKey) : null
  const encrypted = !!trustedPub && trustedPub.length === 32
  // ★★有中转地址却没有(或解不出)公钥时,**不许**悄悄降级成明文中转 ——
  //  那正是这一层要防的事。当成配置错误直接失败,让人看得见。
  const relayUrl = opts.relayUrl?.trim() || ''
  const badRelay = !!relayUrl && !encrypted

  function open() {
    if (disposed) return
    if (badRelay) {
      return fail('这台主机配了中转但没有身份公钥 —— 请在电脑上重新生成配对码')
    }
    setState({ status: 'connecting', attempt })

    let sock: WebSocket
    try {
      // 走中转时连的是**中转**,不是主机地址。主机地址那时只是个记录,连不到。
      sock = new WebSocket(relayUrl || opts.url)
    } catch (e) {
      // RN 对畸形 URL 是**同步抛**的(浏览器亦然)。不接住的话整个 connect 调用当场炸,
      // 连一次 retrying 状态都进不去,界面永远停在「连接中」。
      scheduleRetry(e instanceof Error ? e.message : String(e))
      return
    }
    ws = sock
    // hello 里的版本号要留到 ready 时一起报出去(ready 帧本身不带版本)。
    let peerVersion = ''

    /** 加密层。明文直连时是 null。 */
    let link: E2ELink | null = null
    /** 握完手之后拿到的那条信道 —— 协议帧从这儿发。明文时是 null。 */
    let sealed: Channel | null = null
    /** 走中转时:进房间了没有。 */
    let joined = false

    /** 发一帧协议帧。加密开着就走加密层,否则直接落 socket。 */
    const sendFrame = (o: unknown) => {
      const text = encodeFrame(o as never)
      if (sealed) sealed.send(text)
      else sock.send(text)
    }
    // ★`invoke` 那边也要用同一条出口。挂在闭包外面的 ref 上,因为 open() 每次重连都重建。
    sendRef.current = sendFrame

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

    // ★监听器必须在**构造之后立刻**挂上。放到任何 await 之后,握手期间到达的
    //  hello / ready 就会落在没人听的地方,表现是「连上了但永远不 ready」。
    sock.addEventListener('open', () => {
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

    sock.addEventListener('message', (ev: MessageEvent) => {
      const raw = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(new Uint8Array(ev.data as ArrayBuffer))

      // ── ① 中转自己的状态帧。★它不属于两端的对话,而且**只在中转模式下才可能出现**。
      if (relayUrl) {
        const st = asRelayStatus(raw)
        if (st) {
          if (st.status === 'error') return fail(st.error || '中转拒绝了这次连接')
          if (st.status === 'peer-online') {
            if (!joined) { joined = true; log('电脑在线,开始握手'); startE2E() }
            return
          }
          if (st.status === 'waiting') {
            // ★房间里还没有 daemon。**这不是错误** —— 电脑可能只是还没开机。
            //  保持连着等它上线(上线时中转会推 peer-online),别退避重连:
            //  重连只会让"等着"变成一串连接噪音。
            log('电脑还没上线,等着')
            return
          }
          if (st.status === 'peer-offline') {
            // 电脑掉线了。★把在飞的请求立刻 reject —— 不 reject 的话它们永远不 settle,
            //  界面上是一个永远转下去的圈,而且完全看不出跟掉线有关。
            joined = false
            rejectAllPending('电脑掉线了')
            setState({ status: 'retrying', attempt, error: '电脑掉线了', nextInMs: 0 })
            return
          }
          return
        }
      }

      // ── ② 加密层。密文在这儿被拆开,明文经 `handleProtocol` 往下走。
      if (encrypted) {
        if (!link) return log('还没起握手就收到东西,丢掉')
        link.receive(raw)
        return
      }

      handleProtocol(raw)
    })

    /** 一帧**明文的**协议帧。加密与否、走不走中转,到这儿都已经没有区别了。 */
    function handleProtocol(raw: string) {
      const d = decodeFrame(raw)
      if (!d.ok) {
        log(`丢弃一条坏帧: ${d.error}`)
        return
      }
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
          sendFrame({ t: 'auth', token: opts.token })
        }
        return
      }

      if (f.t === 'ready') {
        // 自报家门:让对面在系统提示里说得出「是哪台设备答的门」。
        if (opts.clientLabel) {
          try {
            sendFrame({ t: 'identify', label: opts.clientLabel })
          } catch {
            /* 已断 */
          }
        }
        attempt = 1
        setState({ status: 'ready', version: peerVersion, methods: new Set(f.methods) })
        return
      }
      if (f.t === 'evt') {
        opts.onEvent(f.ch, f.payload)
        return
      }
      if (f.t === 'res') {
        const p = pending.get(f.id)
        if (!p) return // 迟到的响应(比如断线重连前发出的);丢掉即可
        pending.delete(f.id)
        if (f.ok) p.resolve(f.value)
        else p.reject(new Error(f.error))
        return
      }
    }

    sock.addEventListener('close', (ev: CloseEvent) => {
      if (ws !== sock) return // 已经被换掉的旧 socket,不管
      const code = ev.code
      const why =
        code === 4403
          ? '令牌不对,被对方拒绝'
          : code === 4401
            ? '鉴权失败'
            : `连接断开(${code}${ev.reason ? ' ' + ev.reason : ''})`
      rejectAllPending(why)
      if (code === 4403 || code === 4401) return fail(why)
      scheduleRetry(why)
    })

    // 'close' 会跟着来,这里只记一笔。RN 的 error 事件对象没有统一形状,别指望 e.message。
    sock.addEventListener('error', () => log('socket 出错'))
  }

  open()

  const waitReady = () =>
    new Promise<void>((resolve, reject) => {
      if (state.status === 'ready') return resolve()
      if (state.status === 'failed') return reject(new Error(state.error))
      const t = setTimeout(() => {
        stateWaiters.delete(onS)
        reject(new Error('等待连接就绪超时'))
      }, readyTimeoutMs)
      const onS = (s: HostState) => {
        if (s.status === 'ready') {
          clearTimeout(t)
          stateWaiters.delete(onS)
          resolve()
        } else if (s.status === 'failed' || s.status === 'closed') {
          clearTimeout(t)
          stateWaiters.delete(onS)
          reject(new Error(s.status === 'failed' ? s.error : '连接已关闭'))
        }
      }
      stateWaiters.add(onS)
    })

  return {
    state: () => state,
    onState(cb) {
      stateWaiters.add(cb)
      return () => {
        stateWaiters.delete(cb)
      }
    },
    async invoke(ch, args = []) {
      // 重连中的短暂空窗不该让调用直接失败,等一会儿再说。
      if (state.status !== 'ready') await waitReady()
      const sock = ws
      if (!sock || sock.readyState !== 1 /* OPEN */) throw new Error('连接不可用')
      const send = sendRef.current
      // ★加密模式下必须走加密那条出口。直接 `sock.send` 会把**明文**推到中转上 ——
      //  而且它会"看起来能用"(对面解不开,静默丢),表现是发出去的消息石沉大海。
      if (!send) throw new Error('连接不可用')
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          send({ t: 'req', id, ch, args })
        } catch (e) {
          pending.delete(id)
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    },
    /**
     * 关闭。**同步返回** —— 桌面端要 await 是因为退出前得确认 socket 真的没了(否则留孤儿 ssh),
     * 手机端没有「退出进程」这一步,切主机时等一个可能永远不来的 close 事件只会卡住界面。
     */
    close() {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      // ★把出口摘掉。留着的话,关闭之后的 invoke 会往一条已死的加密信道上写 ——
      //  `seal` 还会推进计数器,而那把会话密钥已经没人在听了。
      sendRef.current = null
      rejectAllPending('连接已关闭')
      const sock = ws
      ws = null
      setState({ status: 'closed' })
      if (!sock) return
      try {
        sock.close()
      } catch {
        /* 已关 */
      }
    },
  }
}
