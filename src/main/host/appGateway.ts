import { networkInterfaces } from 'node:os'
import { startGateway, type GatewayHandle } from '../remote/gateway'
import { daemonTable } from '../ipc/channelRouting'
import type { MethodTable } from '../ipc/invokeCtx'
import { ensureToken, isLoopback, resetToken } from '../daemon/config'
import type { MobileGateway } from '../config/schema'

/**
 * 让 **Electron app 自己**把手机端网关端起来。
 *
 * ★这是决策 3(mac/Windows 上 daemon 与 app 同生共死)的落地。
 *  在此之前想让手机连进来只能另起一个 `daemon.js`,那是**第二个独立的核心** ——
 *  两份会话缓存、两张权限门表、两条广播总线,读写同一批文件却互不通气:
 *  手机上答掉的门,电脑上那张卡不会消失;手机发的消息,电脑上看不见。
 *
 *  端在 app 进程里之后,手机和本机窗口共用**同一张方法表、同一条广播总线**:
 *  代理升起的门只有一份,谁先答谁算数,另一边当场看见它消失,并留下「是谁答的」那行系统提示。
 */

export type MobileStatus = {
  running: boolean
  host: string
  port: number
  /** 只有绑非回环时才有;回环监听不要令牌 */
  token: string
  /** 这台机器上别人连得到的 IPv4 —— 手机要照抄的就是它 */
  addresses: string[]
  /** 现在有几台设备连着 */
  clients: number
  /** 起不来时的原因(端口被占之类)。★不能静默失败:开关拨过去了却没起来,是最难查的一类。 */
  error: string
}

/** 这台机器上别人连得到的 IPv4。虚拟网卡排后面 —— 手机永远连不上那些。 */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address)
    }
  }
  const virt = (ip: string) => ip.startsWith('10.211.55.') || ip.startsWith('10.37.129.') || ip.startsWith('172.17.')
  return out.sort((a, b) => Number(virt(a)) - Number(virt(b)))
}

export type AppGatewayDeps = {
  table: MethodTable
  addSink: (sink: (channel: string, payload: unknown) => void) => () => void
  version: string
  onLog?: (msg: string) => void
  /** 状态一变就叫一声,渲染层据此刷新那一栏 */
  onStatus?: (s: MobileStatus) => void
}

export type AppGateway = {
  /** 按新配置重开。关→开、开→关、换端口 都走这一个入口。 */
  apply(cfg: MobileGateway): Promise<MobileStatus>
  status(): MobileStatus
  /** 换一把钥匙。已连着的设备会在下次连接时被拒 —— 这正是「撤销」该有的样子。 */
  regenToken(): MobileStatus
  close(): Promise<void>
}

export function createAppGateway(deps: AppGatewayDeps): AppGateway {
  const log = deps.onLog ?? (() => {})
  let gw: GatewayHandle | null = null
  let cur: MobileGateway = { enabled: false, host: '0.0.0.0', port: 6789 }
  let error = ''
  // 手机端只该拿到 daemon 那张表:被排除的两个本质是「在这台机器上弹一个系统对话框」,
  // 手机那头根本看不见那扇窗,点了就是本机凭空弹窗、而手机永远等不到答案。
  const table = daemonTable(deps.table)

  const status = (): MobileStatus => ({
    running: !!gw,
    host: cur.host,
    port: gw?.port ?? cur.port,
    token: isLoopback(cur.host) ? '' : ensureToken(),
    addresses: lanAddresses(),
    clients: gw?.clientCount() ?? 0,
    error,
  })

  const announce = () => deps.onStatus?.(status())

  const stop = async () => {
    const g = gw
    gw = null
    if (g) await g.close()
  }

  return {
    status,
    async apply(cfg) {
      // ★「同一份配置就别动它」。设置面板里改任何别的东西都会走一次 apply —— 每次都重启的话,
      //  连着的手机被无缘无故踢下线,正在等的调用全部作废。
      //  端口要拿**实际绑上的**那个一起比:请求 0(交给内核挑)时 cur.port 存的是 0,
      //  而界面回填的是真实端口号,只比 cur.port 会把「其实没变」误判成「换端口了」。
      const portSame = cfg.port === cur.port || (gw != null && cfg.port === gw.port)
      const same = gw && cur.enabled === cfg.enabled && cur.host === cfg.host && portSame
      cur = cfg
      if (same) return status()
      await stop()
      error = ''
      if (!cfg.enabled) {
        log('手机端网关已关闭')
        announce()
        return status()
      }
      // ★非回环强制令牌。绑 0.0.0.0 又不要凭据,等于把「起 agent + 替你答门 + 开终端」挂在网上。
      const token = isLoopback(cfg.host) ? undefined : ensureToken()
      try {
        gw = await startGateway({
          table, addSink: deps.addSink, version: deps.version,
          host: cfg.host, port: cfg.port, token, onLog: log,
          onClientsChanged: announce,
        })
        log(`手机端网关已启动 ${gw.host}:${gw.port} · ${Object.keys(table).length} 个方法${token ? ' · 需要令牌' : ' · 仅本机'}`)
      } catch (e) {
        // 端口被占、地址不存在 …… 都要留下一句人话,并且**开关自己弹回去**,
        // 否则界面显示「已开启」而实际没有任何东西在听。
        error = e instanceof Error ? e.message : String(e)
        log(`手机端网关启动失败:${error}`)
      }
      announce()
      return status()
    },
    regenToken() {
      resetToken()
      announce()
      return status()
    },
    close: stop,
  }
}
