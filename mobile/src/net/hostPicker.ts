import type { HostState } from './hostClient'
import type { MobileHost } from './hosts'
import { describeHostState, hostSubtitle, type HostStatusTone } from './hostStatusText'

/**
 * 顶部主机条那张切换单里的一行(设计文档 §4.4b)。
 *
 * ★**这一份是纯逻辑,不 import 任何 react-native**(两个 import 都是 type-only,编译后就没了),
 *  所以它能在 node 那套 vitest 项目里被直接钉住。切主机这件事上最容易犯的错是「顺手编一个数」,
 *  而编出来的数在界面上和真数长得一模一样 —— 只有测试能把它们分开。
 *
 * ★★`gates: number | null` 里的 **null 不是 0**,这是这个文件存在的主要理由:
 *  门的数量是**连上那台机器之后**才由它广播过来的(`store.tsx` 的 `gateMap` 只有当前这条连接的)。
 *  没连上的那几台,我们**不知道**它们上面有没有门 —— 写 0 就是在替它们说「没有事」,
 *  而人看到一片「0」之后就不会再切过去看,恰好把这一屏存在的理由(代理停在门上等你)吃掉。
 *  所以:`null` = 不说,界面上什么也不画;`0` = 确实知道、确实没有。
 */
export type HostPickRow = {
  id: string
  label: string
  icon: string
  /**
   * 副行。★走 `hostSubtitle` 这一份共享实现,不在这儿重写:
   * 「当前这台报地址+版本 / 别的只报地址」这条规矩已经在那边写清楚了,抄第二遍必然漂移。
   */
  sub: string
  /** 是不是此刻连着的那一台。 */
  active: boolean
  /** 连接状态点的色。★只有当前这台有状态可言,其余是 `null`(不画点)。 */
  tone: HostStatusTone | null
  /** 一句人话的状态,只有当前这台有。 */
  status: string | null
  /** 门的条数。★见上面:`null` = 不知道,别画;`0` = 知道且没有。 */
  gates: number | null
}

/**
 * @param hosts    手机上记着的全部主机,**原序**返回(切换单不重排 —— 每次打开顺序都变的话,
 *                 肌肉记忆就没了,而切主机是个高频的、闭着眼点的动作)。
 * @param activeId 当前选中的主机 id(没选就传 null)。
 * @param state    当前这条连接的状态。它只属于 `activeId` 那一台。
 * @param gateCount 当前这台机器上挂着的门的条数(`useStore().gates.length`)。
 */
export function hostPickRows(
  hosts: readonly MobileHost[],
  activeId: string | null,
  state: HostState | null,
  gateCount: number,
): HostPickRow[] {
  return hosts.map((h) => {
    const active = h.id === activeId
    return {
      id: h.id,
      label: h.label,
      icon: h.icon,
      sub: hostSubtitle(h.url, state, active),
      active,
      tone: active ? describeHostState(state).tone : null,
      status: active ? describeHostState(state).text : null,
      gates: active ? gateCount : null,
    }
  })
}
