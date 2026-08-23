import { isClientEvent, routeOf } from '../ipc/channelRouting'
import { CH } from '../ipc/channels'
import { connectRemote, type RemoteClient, type RemoteState } from './remoteClient'
import type { InvokeCtx, MethodTable } from '../ipc/invokeCtx'
import type { RemoteHost } from './hostStore'

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
}

export function createHostRouter(deps: HostRouterDeps) {
  const log = deps.onLog ?? (() => {})
  let remote: RemoteClient | null = null
  let cleanupTunnel: (() => Promise<void>) | null = null
  let current: RemoteHost | null = null
  let remoteState: RemoteState = { status: 'closed' }

  const localMethods = Object.keys(deps.localTable)

  const status = (): HostStatus => current
    ? {
        hostId: current.id, label: current.label, state: remoteState,
        methods: remoteState.status === 'ready' ? [...remoteState.methods] : [],
        icon: current.icon, display: current.display,
      }
    : { hostId: null, label: '本机', state: { status: 'local' }, methods: localMethods }

  const pushStatus = () => deps.onStatus(status())

  async function teardown() {
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
      const patch = args[0]
      const host = await invoke(CH.configSetHostSettings, ctx, [patch])
      const client = await invoke(CH.configSetClientSettings, ctx, [patch])
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
    const s = remote.state()
    if (s.status === 'ready' && !s.methods.has(channel)) {
      // ★绝不回落到本机。回落的话「工作区列表」会在你以为在看服务器的时候显示本机的工作区,
      // 而界面上没有任何迹象 —— 比报错危险得多。
      throw new Error(`「${current?.label ?? '远程主机'}」不提供这个功能(${channel}),可能是两端版本不一致`)
    }
    return remote.invoke(channel, args)
  }

  return {
    status,
    invoke,

    /** 本机核心广播出来的事件走这里 —— 连着远程时,只有「描述这台设备本身」的那几条放行。 */
    localEvent(channel: string, payload: unknown) {
      if (current && !isClientEvent(channel)) return
      deps.toWindows(channel, payload)
    },


    current: () => current,

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

      remote = connectRemote({
        url,
        token: host.token || undefined,
        clientVersion: deps.clientVersion,
        clientLabel: deps.clientLabel,
        onEvent: (ch, payload) => (deps.onRemoteEvent ?? deps.toWindows)(ch, payload),
        onState: (s) => { remoteState = s; pushStatus() },
        onLog: log,
      })
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
