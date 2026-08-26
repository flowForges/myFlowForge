import type { HostState } from './hostClient'

export type HostStatusTone = 'ok' | 'wait' | 'off' | 'idle'
export type HostStatusText = { text: string; tone: HostStatusTone }

/**
 * 一句人话的连接状态。断线态必须**显式**,不能拿缓存假装在线。
 *
 * ★这份**只有一处**:主机屏(`app/hosts.tsx`)和设置屏(`app/settings.tsx`)的「主机」那一组
 *  都从这里 import。两屏各写一句「已断开」看着一样,但退避秒数、第几次重试、失败原因这些
 *  只有一边会跟着协议改 —— 于是同一台机器在两屏上说两种话,而人只会觉得其中一屏在骗他。
 *
 * ★不 import 任何 react-native(`HostState` 是 type-only,编译后就没了),
 *  所以它能在 node 那套 vitest 项目里被直接测。
 */
export function describeHostState(s: HostState | null): HostStatusText {
  if (!s) return { text: '未连接', tone: 'idle' }
  switch (s.status) {
    case 'connecting':
      return { text: s.attempt > 1 ? `连接中(第 ${s.attempt} 次)` : '连接中…', tone: 'wait' }
    case 'ready':
      return { text: `已连接 · ${s.version}`, tone: 'ok' }
    case 'retrying':
      return { text: `已断开,${Math.round(s.nextInMs / 1000)} 秒后重连 — ${s.error}`, tone: 'off' }
    case 'failed':
      return { text: `连接失败:${s.error}`, tone: 'off' }
    case 'closed':
      return { text: '未连接', tone: 'idle' }
  }
}
