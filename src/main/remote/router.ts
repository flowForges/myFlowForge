import { isClientEvent, routeOf } from '../ipc/channelRouting'
import { CH } from '../ipc/channels'
import { connectRemote, type ConnectOpts, type RemoteClient, type RemoteState } from './remoteClient'
import {
  afterLanDrop, firstRoute, freshMemory, isLoopbackAddress, routesFor, LAN_CONNECT_BUDGET_MS,
  type Route, type RouteMemory,
} from '@shared/remote/routePick'
import type { HopInput } from '@shared/remote/hopDiagnosis'
import type { InvokeCtx, MethodTable } from '../ipc/invokeCtx'
import type { RemoteHost } from './hostStore'
import { readSettings } from '../config/store'
import { pickClient, pickHost, pickHostPatch, pickClientPatch, type Settings } from '../config/schema'

export type HostStatus = {
  /** null = 正在看本机 */
  hostId: string | null
  label: string
  state: RemoteState | { status: 'local' }
  /** 当前这台机器提供的方法。渲染层据此把对不上的入口置灰(决策 B-2) */
  methods: string[]
  /** 标识与显示方式(本机时不给) */
  icon?: string
  display?: 'icon' | 'name' | 'both'
  /**
   * 链路分段遥测的**原始事实**。渲染层拿它喂 `@shared/remote/hopDiagnosis` 得出「断在哪一跳」。
   * ★这里刻意只搬事实、不搬结论 —— 结论在那个纯函数里一处判定,两端共用同一份。
   */
  hops?: HopInput
}

export type HostRouterDeps = {
  localTable: MethodTable
  /** 事件真正送到渲染层的出口 */
  toWindows: (channel: string, payload: unknown) => void
  /**
   * **远程主机**推来的事件走这个出口(不给就等同 toWindows)。
   *
   * ★为什么要和 toWindows 分开:本机事件的通知嗅探挂在 registerIpc 收到的那个 broadcast 上,
   * 远程事件不经过它。要给远程补上通知,就只能在这儿补 —— 而如果把它并进 toWindows,
   * 本机事件会从两条路各触发一次通知(它们也走 toWindows),变成**每条本机回复弹两个通知**。
   */
  onRemoteEvent?: (channel: string, payload: unknown) => void
  clientVersion: string
  /** 本设备自报的名字,远程那台在「是谁答的门」里显示 */
  clientLabel?: string
  onStatus: (s: HostStatus) => void
  /**
   * 把一条 host 配置解析成一个可连的 URL。SSH 那种要先把隧道拉起来,
   * 所以返回值带一个 cleanup。抽出来是为了让路由器本身不认识 ssh。
   */
  resolveUrl: (h: RemoteHost) => Promise<{ url: string; cleanup?: () => Promise<void> }>
  onLog?: (msg: string) => void
  /** 测试注入点。默认就是真的 `connectRemote`。 */
  connect?: (o: ConnectOpts) => RemoteClient
}

export function createHostRouter(deps: HostRouterDeps) {
  const log = deps.onLog ?? (() => {})
  let remote: RemoteClient | null = null
  let cleanupTunnel: (() => Promise<void>) | null = null
  let current: RemoteHost | null = null
  let remoteState: RemoteState = { status: 'closed' }
  /**
   * ★★选路(2026-10-07):主机同时有局域网和中转时,先局域网、不通再中转;局域网断了重新选。
   *  判断全在 `@shared/remote/routePick.ts`(手机端用的同一份)。桌面第一期**不做**「走中转时主动
   *  迁回局域网」:笔记本合盖再打开本来就会重连,重连时自然先试局域网。
   *  ★第二期要做主动迁移的话,必须先看有没有开着的远程终端 —— pty 跟连接绑定,
   *   断连接就收 pty(terminalService.ts),迁移会把终端里跑着的东西打掉。
   * ★`dialGen`:每次换路 / 断开都 +1。旧连接关闭时会同步报一次 closed,拿代数一比就知道
   *  那是自己收掉的,不是它自己断了 —— 否则一次主动关闭会被当成断线,再触发一轮选路。
   */
  const dial = deps.connect ?? connectRemote
  const routeMem = new Map<string, RouteMemory>()
  let dialGen = 0
  let attemptTimer: ReturnType<typeof setTimeout> | null = null
  const readyWaiters = new Set<() => void>()

  const localMethods = Object.keys(deps.localTable)

  const status = (): HostStatus => current
    ? {
        hostId: current.id, label: current.label, state: remoteState,
        methods: remoteState.status === 'ready' ? [...remoteState.methods] : [],
        icon: current.icon, display: current.display,
        hops: remote?.hops(),
      }
    : { hostId: null, label: '本机', state: { status: 'local' }, methods: localMethods }

  const pushStatus = () => {
    deps.onStatus(status())
    for (const w of [...readyWaiters]) w()
  }

  /**
   * 等这一层「已连接」。★等的是 router 的状态,不是某一条连接的:局域网失败换中转期间发出的调用,
   *  要落到中转上,而不是跟着那条被放弃的局域网一起失败(首屏加载在外面打开时就是这个时刻)。
   */
  function waitReady(timeoutMs = 10_000): Promise<void> {
    if (remoteState.status === 'ready') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(t); readyWaiters.delete(check) }
      const t = setTimeout(() => { done(); reject(new Error('连接超时')) }, timeoutMs)
      const check = () => {
        if (remoteState.status === 'ready') { done(); resolve() }
        else if (remoteState.status === 'failed' || remoteState.status === 'closed') {
          done(); reject(new Error(remoteState.status === 'failed' ? remoteState.error : '连接已关闭'))
        }
      }
      readyWaiters.add(check)
    })
  }

  function dialRoute(host: RemoteHost, url: string, routes: Route[], mem: RouteMemory, route: Route) {
    const gen = ++dialGen
    const lan = route === 'lan'
    const routed = routes.length > 1
    let phase: 'attempt' | 'active' = lan && routed ? 'attempt' : 'active'
    // 换一条路:把当前这条收掉(代数已经变了,它报的 closed 会被忽略),对外保持「连接中」。
    const switchTo = (next: Route) => {
      // ★先作废这一代,再关旧连接:它关闭时会同步报一次 closed,代数没变的话会被当成
      //  「当代这条断了」,再触发一轮换路 —— 测试里看到的就是中转被拨了两次。
      dialGen++
      const old = remote
      remote = null
      if (old) void old.close()
      remoteState = { status: 'connecting', attempt: 1 }
      pushStatus()
      dialRoute(host, url, routes, mem, next)
    }
    const client = dial({
      url,
      token: host.token || undefined,
      pubKey: host.pubKey || undefined,
      relayUrl: lan ? undefined : host.relay || undefined,
      proxy: readSettings().appProxy,
      clientVersion: deps.clientVersion,
      clientLabel: deps.clientLabel,
      // 两条路时局域网那条不自动重连:失败了由这里换路,而不是对着够不着的地址退避一整晚。
      ...(lan && routed ? { backoff: false as const } : {}),
      onEvent: (ch, payload) => {
        if (gen !== dialGen) return
        ;(deps.onRemoteEvent ?? deps.toWindows)(
          ch,
          // ★★收进来的 `settings:changed` 也只取「跟机器走」那一半。发的那头已经收窄过了
          //  (`remote/eventScope.ts`),这头再收一次是给**旧主机**兜底:1.2.0 及更早的机器推的仍是
          //  整份设置。不拦的话,连过去一次,你这台的外观就会被对面同化,而界面上没有任何迹象。
          ch === CH.settingsChanged && payload && typeof payload === 'object' ? pickHost(payload as Settings) : payload,
        )
      },
      onState: (s) => {
        if (gen !== dialGen) return
        if (phase === 'attempt') {
          // 首次拨局域网:通了转正;没通就换中转,失败**不外露**,对外一直是「连接中」。
          if (s.status === 'ready') {
            if (attemptTimer) { clearTimeout(attemptTimer); attemptTimer = null }
            phase = 'active'
            mem.lanSince = Date.now()
            remoteState = s
            pushStatus()
            return
          }
          if (s.status === 'connecting') return
          if (attemptTimer) { clearTimeout(attemptTimer); attemptTimer = null }
          log('局域网不通,改走中转')
          return switchTo('relay')
        }
        if (lan && routed && (s.status === 'closed' || s.status === 'retrying')) {
          // 局域网断了:用了很久才断 → 出门了;刚连上就断 → 信号边缘,冷却。然后重新选路。
          Object.assign(mem, afterLanDrop(mem, Date.now()))
          log('局域网断了,重新选路')
          return switchTo(firstRoute(routes, mem, Date.now()))
        }
        remoteState = s
        pushStatus()
      },
      onLog: log,
    })
    remote = client
    if (phase === 'attempt') {
      attemptTimer = setTimeout(() => {
        attemptTimer = null
        if (gen !== dialGen || phase !== 'attempt') return
        log(`局域网 ${LAN_CONNECT_BUDGET_MS}ms 没连上,改走中转`)
        switchTo('relay')
      }, LAN_CONNECT_BUDGET_MS)
    }
  }

  async function teardown() {
    dialGen++
    if (attemptTimer) { clearTimeout(attemptTimer); attemptTimer = null }
    const r = remote; const t = cleanupTunnel
    remote = null; cleanupTunnel = null
    if (r) await r.close()
    if (t) await t()
  }

  /**
   * 每一刀的分岔口。提成具名函数(而不是对象方法)是因为设置那两条要**递归调用自己**,
   * 依赖 `this` 的话被解构一次就断了。
   */
  async function invoke(channel: string, ctx: InvokeCtx, args: unknown[]): Promise<unknown> {
    if (channel === CH.configGetSettings) {
      const [host, client] = await Promise.all([
        invoke(CH.configGetHostSettings, ctx, []),
        invoke(CH.configGetClientSettings, ctx, []),
      ])
      return { ...(host as object), ...(client as object) }
    }
    if (channel === CH.configSetSettings) {
      // ★收到的是**补丁**。空的那一半根本不发 —— 改一个主题不该往远程机器上写一次设置
      //  (那边会落盘、广播、记一行「谁改了设置」的日志,而其实一个字段都没变)。
      //  返回值是「这次真写进去的那些」,调用方只用它做可选的回显。
      const patch = (args[0] ?? {}) as Partial<Settings>
      const hostHalf = pickHostPatch(patch)
      const clientHalf = pickClientPatch(patch)
      const host = Object.keys(hostHalf).length ? await invoke(CH.configSetHostSettings, ctx, [hostHalf]) : {}
      const client = Object.keys(clientHalf).length ? await invoke(CH.configSetClientSettings, ctx, [clientHalf]) : {}
      return { ...(host as object), ...(client as object) }
    }
    // 导出:内容归那台机器,文件归你面前这台。没连远程时下面那条 localFn 分支就够了 ——
    // 本机的 config:export-projects 自己会弹保存对话框。
    if (channel === CH.configExportProjects && remote) {
      const data = await invoke(CH.configExportProjectsData, ctx, []) as { name: string; content: string; title?: string }
      return invoke(CH.clientSaveFile, ctx, [data])
    }

    const localFn = deps.localTable[channel]
    if (routeOf(channel) === 'client' || !remote) {
      if (!localFn) throw new Error(`没有这个方法: ${channel}`)
      return localFn(ctx, ...args)
    }
    // 正在换路(局域网 → 中转)的那一小会儿,等这一层连上再发,别让调用跟着被放弃的那条一起失败。
    if (remoteState.status !== 'ready') await waitReady()
    const live = remote
    if (!live) throw new Error('连接不可用')
    const s = live.state()
    if (s.status === 'ready' && !s.methods.has(channel)) {
      // ★绝不回落到本机。回落的话「工作区列表」会在你以为在看服务器的时候显示本机的工作区,
      // 而界面上没有任何迹象 —— 比报错危险得多。
      throw new Error(`「${current?.label ?? '远程主机'}」不提供这个功能(${channel}),可能是两端版本不一致`)
    }
    return live.invoke(channel, args)
  }

  return {
    status,
    invoke,

    /** 本机核心广播出来的事件走这里 —— 连着远程时,只有「描述这台设备本身」的那几条放行。 */
    localEvent(channel: string, payload: unknown) {
      if (current && !isClientEvent(channel)) return
      // ★★连着远程时,本机这份 `settings:changed` 里的 host 那一半说的是**本机**的机器设置
      //  (本机的 agentProxy、本机的中转地址)。整份放进界面,设置页上「跟机器走」那几块就会
      //  显示成本机的值,而你正看着的是远程那台 —— 然后你在那个框里一改,改的是远程那台。
      //  这就是 2026-09-20 那个事故的另一半路。只放行「跟设备走」的那一半。
      if (current && channel === CH.settingsChanged) {
        deps.toWindows(channel, pickClient(payload as Settings))
        return
      }
      deps.toWindows(channel, payload)
    },


    current: () => current,

    /**
     * 主机配置被改了(改名、换标识、换显示方式)。
     *
     * ★`current` 是 connect 那一刻的**快照** —— 不同步的话,你在设置里把「只显示标识」存下去,
     * 标题栏那枚芯片纹丝不动,看起来就是「保存了但没生效」。真机验收就卡在这儿。
     * 只有改的正是当前这台才需要动;连接本身不受影响,不用重连。
     */
    hostUpdated(h: RemoteHost) {
      if (!current || current.id !== h.id) return
      current = { ...h }
      pushStatus()
    },

    async connect(host: RemoteHost) {
      await teardown()
      current = host
      remoteState = { status: 'connecting', attempt: 1 }
      pushStatus()

      let url: string
      try {
        const r = await deps.resolveUrl(host)
        url = r.url
        cleanupTunnel = r.cleanup ?? null
      } catch (e) {
        current = null
        remoteState = { status: 'closed' }
        pushStatus()
        throw e
      }

      const routes = routesFor({
        // SSH 主机走隧道,不参与选路;码里是回环地址 = 分享时没开局域网,那不是一条路。
        lanUsable: host.kind === 'direct' && !!url && !isLoopbackAddress(url),
        relay: host.relay, pubKey: host.pubKey,
      })
      let mem = routeMem.get(host.id)
      if (!mem) { mem = freshMemory(); routeMem.set(host.id, mem) }
      dialRoute(host, url, routes, mem, firstRoute(routes, mem, Date.now()))
      pushStatus()
    },

    async disconnect() {
      await teardown()
      current = null
      remoteState = { status: 'closed' }
      pushStatus()
    },
  }
}
