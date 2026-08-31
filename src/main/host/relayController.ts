import { toBase64 } from '@shared/remote/e2e'
import type { MethodTable } from '../ipc/invokeCtx'
import { daemonTable } from '../ipc/channelRouting'
import { ensureToken } from '../daemon/config'
import { readIdentity } from '../remote/identity'
import { readSettings } from '../config/store'
import { startRelayHost, type RelayHostHandle, type RelayHostStatus } from '../remote/relayHost'
import type { RelayConfig } from '../config/schema'

/**
 * 「这台机器要不要通过中转对外可达」的开关。
 *
 * 形状**照抄 `appGateway.ts`**(`apply` / `status` + 一个状态广播),因为设置界面上这两个
 * 开关长得一样、用起来也该一样。★两者不是二选一:
 *  · `mobileGateway` = 局域网里有人能连上来。
 *  · 这个        = NAT 后面也能被连上。
 * 同时开着是完全正常的 —— 在家走局域网(快、少一跳),出门走中转,**同一个二维码**。
 */

export type RelayStatusView = {
  enabled: boolean
  url: string
  /** 底下那条连接现在什么样。没开时是 `off`。 */
  detail: RelayHostStatus
  /** 这台机器的长期身份公钥(base64)。★配对二维码要用它,所以**没开中转时也要有**。 */
  publicKey: string
  /** 访问令牌。★和局域网那条路是**同一个** —— 一个二维码要在两条路上都能用。 */
  token: string
}

export type RelayDeps = {
  table: MethodTable
  addSink: (channel: string, sink: (ch: string, payload: unknown) => void) => () => void | (() => void)
  version: string
  onLog?: (msg: string) => void
  onStatus?: (s: RelayStatusView) => void
}

export function createRelayController(deps: {
  table: MethodTable
  addSink: (sink: (ch: string, payload: unknown) => void) => () => void
  version: string
  onLog?: (msg: string) => void
  onStatus?: (s: RelayStatusView) => void
}) {
  const log = deps.onLog ?? (() => {})
  // ★和手机端网关同一张筛过的表。两条路提供的方法必须**一模一样** ——
  //  否则同一台 daemon 在局域网和中转上能力不同,而客户端是按 ready.methods 置灰的,
  //  用户会看到「在家能点、出门变灰」这种说不清的差别。
  const table = daemonTable(deps.table)

  let handle: RelayHostHandle | null = null
  let cur: RelayConfig = { enabled: false, url: '' }
  let lastError = ''

  const status = (): RelayStatusView => ({
    enabled: cur.enabled,
    url: cur.url,
    detail: handle?.status() ?? (lastError ? { status: 'failed', error: lastError } : { status: 'off' }),
    // ★★**读身份会在第一次调用时生成一把并落盘**。放在 status() 里是有意的:
    //  设置界面一打开就要显示二维码,而二维码里必须有公钥。代价是"打开过设置的人"
    //  磁盘上就有了一把私钥 —— 可以接受;`readIdentity` 的注释解释了为什么不更早生成。
    publicKey: toBase64(readIdentity().publicKey),
    token: ensureToken(),
  })

  const announce = () => deps.onStatus?.(status())

  const stop = async () => {
    if (!handle) return
    await handle.close()
    handle = null
  }

  return {
    status,
    /** 这台机器的长期公钥(base64)。二维码那边直接用。 */
    publicKey: () => toBase64(readIdentity().publicKey),

    async apply(cfg: RelayConfig): Promise<RelayStatusView> {
      const same = cfg.enabled === cur.enabled && cfg.url === cur.url
      // ★没变就什么都不做。不判的话,设置界面每保存一次(哪怕改的是别的字段)都会把
      //  中转连接断开重连一次,而重连会**作废所有逻辑连接** —— 手机会莫名其妙掉线。
      if (same && (handle || !cfg.enabled)) return status()
      cur = cfg
      lastError = ''
      await stop()
      if (!cfg.enabled) {
        log('中转已关闭')
        announce()
        return status()
      }
      const url = cfg.url.trim()
      if (!url) {
        // ★开了但没填地址:这是"配错了"不是"出错了",要说人话。
        //  **没有官方中转**(设计文档决策 4),所以这里没有可以偷偷回落的默认值。
        lastError = '没有填中转地址。中转要你自己部署一台 —— 见 relay/README.md'
        log(lastError)
        announce()
        return status()
      }
      handle = startRelayHost({
        relayUrl: url,
        identity: readIdentity(),
        table,
        addSink: deps.addSink,
        version: deps.version,
        // ★中转这条路上仍然要令牌,而且和局域网那条**共用同一个**:
        //  加密回答"谁能听",令牌回答"谁能用"。共用是为了一个二维码两条路都能用。
        token: ensureToken(),
        // ★★「app 自身的网络」那个代理。漏了它的现象是**永远「正在连中转」**:
        //  `ws` 不认 `https_proxy` 环境变量,不给它 agent 就直连,而直连一个够不着的地址
        //  既不报错也不关闭,就是不回。2026-08-31 真机上就是这么卡住的。
        //  ★用 appProxy 不用 agentProxy:拨中转是**这个 app 自己**在上网(和字体、壁纸、
        //   更新检查同一类),不是 coding agent 的出口。
        proxy: readSettings().appProxy,
        onLog: log,
        onStatus: () => announce(),
      })
      log(`中转已开启:${url}`)
      announce()
      return status()
    },

    async close() {
      await stop()
    },
  }
}
