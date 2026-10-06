import { connectHost, type ConnectOpts, type HostClient, type HostState } from './hostClient'
import { isLoopbackUrl } from './hosts'
import {
  afterLanDrop, firstRoute, routesFor, shouldProbeLan,
  LAN_CONNECT_BUDGET_MS, LAN_PROBE_BUDGET_MS,
  type Route, type RouteMemory,
} from '../../../src/shared/remote/routePick'

/**
 * 一台同时开了局域网和中转的主机:在家走局域网,出门走中转,回家自动迁回去,全程无感。
 *
 * ★★为什么包在 `connectHost` 外面,而不是改它:`connectHost` 只管**一条**线路,线协议的边角
 *  (握手、加密、断线时在飞的请求)全在里面,而且和桌面端那份逐条对齐过。选路是另一件事 ——
 *  「先拨哪条、什么时候换」—— 放在外面一层,两件事各自能测。对外仍是同一个 `HostClient`,
 *  `conn.tsx` 只是把 `connectHost` 换成它。
 * ★判断(先拨哪条、该不该探、断了要不要冷却)全在 `src/shared/remote/routePick.ts`,桌面端也用那一份。
 *
 * 几条硬规矩:
 *  · 局域网那条拨号**不自动重连**(backoff:false)。它失败了该由这一层换到中转,而不是在原地退避 ——
 *    出门之后对着一个够不着的局域网地址指数退避一整晚,就是这个功能要消灭的那种体验。
 *  · 局域网 1.5 秒连不上就放弃。外网上连 192.168.x.x 常常是**挂着**而不是被拒,不设上限要等几十秒。
 *  · 探测用的那条连接**本身就是新连接**:探通了直接换上去,不再重拨一次。
 *  · 事件只从当前在用的那条转发。探测连接和刚退役的旧连接收到的同一条事件不能再交给界面一次。
 *  · 迁移那一刻对外先报一帧「连接中」再回到「已连接」—— 和一次普通重连一样,各屏会重新拉一遍数据,
 *    补上切换那几十毫秒里可能漏掉的流式片段。用户最多看到一帧闪动。
 *  · ★手机端没有远程终端,所以「开着终端不迁」这条约束这里用不上;桌面端第二期做主动迁移时必须接上
 *    (终端的 pty 跟连接绑定,断连接就收 pty —— 见 src/main/terminal/terminalService.ts)。
 */
export type RoutedHost = { url: string; relay?: string; pubKey?: string; token?: string }

export type RoutedOpts = Omit<ConnectOpts, 'url' | 'relayUrl' | 'pubKey' | 'token' | 'backoff'> & {
  host: RoutedHost
  /** 这台主机的选路记忆。由调用方按主机 id 持有:重连会重建这一层,但冷却得跨过去。 */
  memory: RouteMemory
  /** 测试注入点。默认就是真的 `connectHost`。 */
  connect?: (o: ConnectOpts) => HostClient
}

export type RoutedClient = HostClient & {
  /** 此刻真正在用的那条路;还没连上时为 null。 */
  route(): Route | null
  /** 走着中转时去看一眼局域网。由调用方在回到前台 / 定时器上调,这里自己判该不该真去拨。 */
  probeLan(a: { foreground: boolean; force?: boolean }): void
}

type Leg = { route: Route; client: HostClient; phase: 'attempt' | 'probe' | 'active'; retired: boolean }

export function connectRouted(opts: RoutedOpts): RoutedClient {
  const dial = opts.connect ?? connectHost
  const { host, memory } = opts
  const routes = routesFor({ lanUsable: !!host.url && !isLoopbackUrl(host.url), relay: host.relay, pubKey: host.pubKey })
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000

  let state: HostState = { status: 'connecting', attempt: 1 }
  let active: Leg | null = null
  let probe: Leg | null = null
  let disposed = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const waiters = new Set<(s: HostState) => void>()

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => { timers.delete(t); fn() }, ms)
    timers.add(t)
    return t
  }
  const cancel = (t: ReturnType<typeof setTimeout> | null) => { if (t) { clearTimeout(t); timers.delete(t) } }

  const emit = (s: HostState) => {
    if (disposed) return
    state = s
    opts.onState?.(s)
    for (const w of [...waiters]) w(s)
  }

  /** 收掉一条腿。★先打退役标记再 close:真的 connectHost 关的时候会同步报一次 closed。 */
  const retire = (leg: Leg | null) => {
    if (!leg || leg.retired) return
    leg.retired = true
    try { leg.client.close() } catch { /* 已关 */ }
  }

  function open(route: Route, phase: Leg['phase']): Leg {
    const lan = route === 'lan'
    const leg: Leg = { route, phase, retired: false, client: null as unknown as HostClient }
    leg.client = dial({
      url: host.url,
      token: host.token,
      pubKey: host.pubKey,
      relayUrl: lan ? undefined : host.relay,
      clientVersion: opts.clientVersion,
      clientLabel: opts.clientLabel,
      onLog: opts.onLog,
      readyTimeoutMs: opts.readyTimeoutMs,
      // 只有一条路时照旧自动重连;两条路时局域网那条不重连,由这一层换路。
      ...(lan && routes.length > 1 ? { backoff: false as const } : {}),
      onEvent: (ch, payload) => { if (leg === active && !leg.retired) opts.onEvent(ch, payload) },
      onState: (s) => onLegState(leg, s),
    })
    return leg
  }

  function onLegState(leg: Leg, s: HostState) {
    if (disposed || leg.retired) return
    if (leg.phase === 'probe') return onProbeState(leg, s)
    if (leg.phase === 'attempt') {
      // 首次拨局域网:通了就转正;没通(被拒 / 失败)就换中转,失败**不外露**,对外一直是「连接中」。
      if (s.status === 'ready') {
        cancel(attemptTimer)
        leg.phase = 'active'
        memory.lanSince = Date.now()
        return emit(s)
      }
      if (s.status === 'connecting') return
      cancel(attemptTimer)
      retire(leg)
      return start('relay')
    }
    // 在用的那条。
    if (leg.route === 'lan' && routes.length > 1 && (s.status === 'closed' || s.status === 'retrying')) {
      // 局域网断了:用了很久才断 → 出门了;刚迁过来就断 → 信号边缘,冷却。然后重新选路。
      Object.assign(memory, afterLanDrop(memory, Date.now()))
      retire(leg)
      return start(firstRoute(routes, memory, Date.now()))
    }
    emit(s)
  }

  let attemptTimer: ReturnType<typeof setTimeout> | null = null

  function start(route: Route) {
    if (disposed) return
    if (state.status !== 'connecting') emit({ status: 'connecting', attempt: 1 })
    if (route === 'lan' && routes.length > 1) {
      active = open('lan', 'attempt')
      attemptTimer = later(LAN_CONNECT_BUDGET_MS, () => {
        const leg = active
        if (!leg || leg.phase !== 'attempt') return
        retire(leg)
        start('relay')
      })
      return
    }
    active = open(route, 'active')
  }

  let probeTimer: ReturnType<typeof setTimeout> | null = null

  function onProbeState(leg: Leg, s: HostState) {
    if (s.status === 'ready') {
      cancel(probeTimer)
      const old = active
      leg.phase = 'active'
      active = leg
      probe = null
      memory.lanSince = Date.now()
      retire(old)
      // 先报一帧「连接中」,下一拍再报「已连接」:让依赖 `online` 的各屏重新拉一遍,
      // 补上切换那几十毫秒里两条连接之间可能漏掉的事件。
      emit({ status: 'connecting', attempt: 1 })
      later(0, () => { if (active === leg && !leg.retired) emit(leg.client.state()) })
      return
    }
    if (s.status === 'connecting') return
    cancel(probeTimer)
    retire(leg)
    probe = null
  }

  start(firstRoute(routes, memory, Date.now()))

  async function waitReady(): Promise<void> {
    if (state.status === 'ready') return
    await new Promise<void>((resolve, reject) => {
      const t = later(readyTimeoutMs, () => { waiters.delete(on); reject(new Error('连接超时')) })
      const on = (s: HostState) => {
        if (s.status === 'ready') { cancel(t); waiters.delete(on); resolve() }
        else if (s.status === 'failed' || s.status === 'closed') { cancel(t); waiters.delete(on); reject(new Error(s.status === 'failed' ? s.error : '连接已关闭')) }
      }
      waiters.add(on)
    })
  }

  return {
    state: () => state,
    onState(cb) {
      waiters.add(cb)
      return () => { waiters.delete(cb) }
    },
    async invoke(ch, args = []) {
      // ★等的是**这一层**的「已连接」,不是某一条腿的:局域网失败换中转期间发出的调用,
      //  要落到中转上,而不是跟着那条被放弃的局域网一起失败。
      await waitReady()
      const leg = active
      if (!leg) throw new Error('连接不可用')
      return leg.client.invoke(ch, args)
    },
    route() {
      const leg = active
      return leg && leg.client.state().status === 'ready' ? leg.route : null
    },
    probeLan(a) {
      if (disposed || probe || !active) return
      const now = Date.now()
      if (!shouldProbeLan(memory, { route: active.route, routes, foreground: a.foreground, now, force: a.force })) return
      memory.lastProbeAt = now
      const leg = open('lan', 'probe')
      probe = leg
      probeTimer = later(LAN_PROBE_BUDGET_MS, () => {
        if (probe !== leg) return
        retire(leg)
        probe = null
      })
    },
    close() {
      if (disposed) return
      for (const t of [...timers]) clearTimeout(t)
      timers.clear()
      retire(probe)
      retire(active)
      probe = null
      state = { status: 'closed' }
      opts.onState?.(state)
      for (const w of [...waiters]) w(state)
      disposed = true
    },
  }
}
