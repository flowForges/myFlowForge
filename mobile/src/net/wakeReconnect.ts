import type { HostState } from './hostClient'

/**
 * 「息屏之后回到前台,要不要立刻重连?」—— 一个纯判断,好让它能在 node 下被测。
 *
 * ★★★为什么需要这一条,而不是让原有的退避自己爬回来:
 *  退避是给「**服务器挂了**」设计的 —— 反复猛敲一台死掉的机器没意义,所以间隔要指数增长。
 *  但息屏断开的原因**不是服务器挂了,是系统把我们挂起了**:iOS 一挂起就把 WebSocket 拆掉,
 *  而那之后排的重试定时器在挂起期间根本不走。醒来时我们坐在一个「还要等 N 秒」的状态里,
 *  N 是按失败次数算的,和「刚刚醒来」这件事毫无关系。几次之后进 `failed`,
 *  而 `failed` **不会自动重试**(hostClient 的 `fail()`)—— 于是用户必须手点一次。
 *  这就是「息屏再打开就得重连一次」的完整成因。
 *
 * ★所以判据是**「我们刚被唤醒」**,不是「又失败了一次」。唤醒是一个全新的事实,
 *  它让之前所有的失败计数都失去意义 —— 那些失败是在没有网络的挂起态里发生的。
 */
export function shouldReconnectOnWake(state: HostState | null): boolean {
  // 没选主机 / 已经连上了 → 什么都不用做。
  if (!state) return false
  if (state.status === 'ready') return false
  // 其余一律重连,**包括 `connecting`**:挂起期间发出的那次连接多半已经是具死的,
  // 它不会自己失败(没有网络栈给它报错),就那么挂着,界面上永远停在「连接中…」。
  return true
}

/**
 * 进后台时要不要主动断开。
 *
 * ★★不是为了省电 —— 是为了让**中转**干净地释放房间。一条半死不活的 host socket 会把房间占着,
 *  下次连进来撞上「房间已有一台主机」,而那台"主机"正是自己上一条死 socket
 *  (2026-09-09 栽过一次,见 [[trap-relay-zombie-room-and-keepalive]])。
 *  主动断开让中转当场知道我们走了。
 * ★只在真的连着的时候断:没连上的时候断什么都没有,反而会把一次正在进行的重连打掉。
 */
export function shouldDropOnBackground(state: HostState | null): boolean {
  return state?.status === 'ready'
}
