import { useCallback, useEffect, useMemo, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import { useConn } from '../net/conn'

/**
 * 这台**远程主机**上装了哪些编码代理、各自有哪些模型。
 *
 * ★一律现问,绝不预置。模型列表是每台机器的本地事实(装了哪个版本、登录的是哪个账号),
 *  硬编码一份在手机里,出个新模型就得发新版 app。
 */
export type AgentModel = { id: string; label: string; description?: string }
export type AgentInfo = {
  id: string
  displayName: string
  installed: boolean
  models: AgentModel[]
  /**
   * 那台机器上这个代理**登录了没有**。
   *
   * ★★三态,而且 `'unknown'`(以及字段缺失 —— 老版本主机不回这个字段)时**界面上什么都不说**。
   *  这一条正是远程场景里最容易白等的地方:装了 CLI ≠ 登录过。但把「不知道」画成「没登录」
   *  会把人支去重登一个本来好好的代理,那和白等一样浪费时间。判据在
   *  `src/main/agents/credProbe.ts`,每一条都在真机上跑过。
   */
  auth?: 'ok' | 'missing' | 'unknown'
}

/** `settings:changed` 广播和 `config:get-host-settings` 的返回里,我们只关心这一个字段。 */
type HostSettingsLite = { disabledProviders?: string[] }

const readDisabled = (s: unknown): string[] => {
  const list = (s as HostSettingsLite | null)?.disabledProviders
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
}

export function useAgents() {
  const { invoke, on, online, epoch } = useConn()
  const [agents, setAgents] = useState<AgentInfo[]>([])
  // ★★2026-08-29 真机第六轮:电脑端**关掉**的代理照样摆在手机的选代理单子里。
  //  「装了」和「开着」是两件事:`agents:detect` 只回答前者,后者是主机设置里的
  //  `disabledProviders`(设置 → 代理 → 那个启用/已禁用开关)。电脑端自己的选择列表一直是
  //  按这份名单过滤的(`src/renderer/state/useConfig.ts`),手机端从来没读过它 —— 于是手机上
  //  能选中一个用户明确关掉的代理,选完还会写回会话。
  //  ★两半都要:进屏那一刻先拉一份(`config:get-host-settings`),之后跟着 `settings:changed`
  //   实时改 —— 那条广播确实到得了手机(网关挂的是同一条 hub 总线),所以「在选代理界面时
  //   电脑上把它关掉」这一档是**做得到**实时的,不用退而求其次。
  const [disabled, setDisabled] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  // 手动重拉的触发器。★打开选代理单子时递增一次 —— 广播万一没送到(刚重连、刚切主机),
  //  至少每次打开看到的是当场问来的那份,而不是一份不知道多旧的快照。
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!online) {
      setAgents([])
      setDisabled([])
      return
    }
    let alive = true
    setLoading(true)
    void (async () => {
      try {
        const list = (await invoke(CH.agentsDetect, [])) as AgentInfo[]
        if (!alive) return
        setAgents(Array.isArray(list) ? list.filter((a) => a.installed) : [])
      } catch {
        // 探测失败不该拦住整个界面 —— 没探到就是没探到,选择器会显示空。
        if (alive) setAgents([])
      } finally {
        if (alive) setLoading(false)
      }
    })()
    void (async () => {
      try {
        const s = await invoke(CH.configGetHostSettings, [])
        if (alive) setDisabled(readDisabled(s))
      } catch {
        // ★拉不到就当「一个都没禁用」。反过来(拉不到就全隐藏)会把整个选代理单子清空,
        //  那是个比「多显示一个」严重得多的失败方式。
        if (alive) setDisabled([])
      }
    })()
    return () => {
      alive = false
    }
  }, [invoke, online, epoch, nonce])

  // 电脑端在设置里现场开/关某个代理 → 广播过来,手机端的单子当场跟着变。
  useEffect(() => {
    if (!online) return
    return on(CH.settingsChanged, (payload) => setDisabled(readDisabled(payload)))
  }, [on, online])

  const visible = useMemo(() => agents.filter((a) => !disabled.includes(a.id)), [agents, disabled])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  // 探到了、但被用户在电脑端关掉的有几个。★空态文案要靠它分岔:「一个都没探到」和
  //  「探到了但你自己全关了」是两个完全不同的处境,前者的指引(去检查 CLI 装没装好)
  //  用在后者身上是把人支到一条走不通的路上。
  const hiddenCount = agents.length - visible.length

  return { agents: visible, loading, refresh, hiddenCount }
}
