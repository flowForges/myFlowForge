import { WebSocket } from 'ws'
import { decodeFrame, encodeFrame, PROTOCOL_VERSION } from '@shared/remote/protocol'

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
  /** 本客户端的版本,用来跟 daemon 比主版本号(决策 B-2) */
  clientVersion: string
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

  function open() {
    if (disposed) return
    setState({ status: 'connecting', attempt })
    const sock = new WebSocket(opts.url)
    ws = sock
    // hello 里的版本号要留到 ready 时一起报出去(ready 帧本身不带版本)。
    let peerVersion = ''

    sock.on('open', () => log(`已连上 ${opts.url}`))

    sock.on('message', (raw, isBinary) => {
      const d = decodeFrame(isBinary ? (raw as Buffer) : String(raw))
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
          sock.send(encodeFrame({ t: 'auth', token: opts.token }))
        }
        return
      }

      if (f.t === 'ready') {
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
    })

    sock.on('close', (code, reason) => {
      if (ws !== sock) return                // 已经被换掉的旧 socket,不管
      const why = code === 4403 ? 'token 不对,被对方拒绝'
        : code === 4401 ? '鉴权失败'
        : `连接断开(${code}${reason?.length ? ' ' + String(reason) : ''})`
      rejectAllPending(why)
      if (code === 4403 || code === 4401) return fail(why)
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
        try { sock.send(encodeFrame({ t: 'req', id, ch, args })) }
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
