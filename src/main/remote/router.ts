import { isClientEvent, routeOf } from '../ipc/channelRouting'
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
}

export type HostRouterDeps = {
  localTable: MethodTable
  /** 事件真正送到渲染层的出口 */
  toWindows: (channel: string, payload: unknown) => void
  clientVersion: string
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
    ? { hostId: current.id, label: current.label, state: remoteState, methods: remoteState.status === 'ready' ? [...remoteState.methods] : [] }
    : { hostId: null, label: '本机', state: { status: 'local' }, methods: localMethods }

  const pushStatus = () => deps.onStatus(status())

  async function teardown() {
    const r = remote; const t = cleanupTunnel
    remote = null; cleanupTunnel = null
    if (r) await r.close()
    if (t) await t()
  }

  return {
    status,

    /** 本机核心广播出来的事件走这里 —— 连着远程时,只有「描述这台设备本身」的那几条放行。 */
    localEvent(channel: string, payload: unknown) {
      if (current && !isClientEvent(channel)) return
      deps.toWindows(channel, payload)
    },

    /**
     * 每一刀的分岔口。
     * - 跟设备走的(外观/宠物/更新/「用默认程序打开」)→ 永远本机
     * - 没连远程 → 本机
     * - 连了远程但对方没这个方法 → **明确报错**,不许悄悄回落到本机
     */
    async invoke(channel: string, ctx: InvokeCtx, args: unknown[]): Promise<unknown> {
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
        onEvent: (ch, payload) => deps.toWindows(ch, payload),
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
