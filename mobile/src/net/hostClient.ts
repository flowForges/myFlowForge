import {
  decodeFrame,
  encodeFrame,
  PROTOCOL_VERSION,
} from '../../../src/shared/remote/protocol'

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
    rejectAllPending(why)
    try {
      ws?.close()
    } catch {
      /* 已关 */
    }
    setState({ status: 'failed', error: why })
  }

  function open() {
    if (disposed) return
    setState({ status: 'connecting', attempt })

    let sock: WebSocket
    try {
      sock = new WebSocket(opts.url)
    } catch (e) {
      // RN 对畸形 URL 是**同步抛**的(浏览器亦然)。不接住的话整个 connect 调用当场炸,
      // 连一次 retrying 状态都进不去,界面永远停在「连接中」。
      scheduleRetry(e instanceof Error ? e.message : String(e))
      return
    }
    ws = sock
    // hello 里的版本号要留到 ready 时一起报出去(ready 帧本身不带版本)。
    let peerVersion = ''

    // ★监听器必须在**构造之后立刻**挂上。放到任何 await 之后,握手期间到达的
    //  hello / ready 就会落在没人听的地方,表现是「连上了但永远不 ready」。
    sock.addEventListener('open', () => log(`已连上 ${opts.url}`))

    sock.addEventListener('message', (ev: MessageEvent) => {
      const d = decodeFrame(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer))
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
          sock.send(encodeFrame({ t: 'auth', token: opts.token }))
        }
        return
      }

      if (f.t === 'ready') {
        // 自报家门:让对面在系统提示里说得出「是哪台设备答的门」。
        if (opts.clientLabel) {
          try {
            sock.send(encodeFrame({ t: 'identify', label: opts.clientLabel }))
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
    })

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
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          sock.send(encodeFrame({ t: 'req', id, ch, args }))
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
