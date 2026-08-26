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

/**
 * 主机行下面那一行小字。**两屏共用同一句**(`app/hosts.tsx` / `app/settings.tsx`)。
 *
 * 三种情况,刻意分开:
 *  - **不是当前这台**:只报地址。它根本没有连接状态,写「未连接」会让人以为它刚断线。
 *  - **当前这台 · 连上了**:地址 · 对面版本。版本对不上是「功能突然置灰」最常见的原因。
 *  - **当前这台 · 没连上**:报**为什么**。那时右边那枚「已连接」pill 已经不在了,
 *    这一行是屏幕上唯一说明原因的地方,写成一句「未连接」等于什么也没说。
 */
export function hostSubtitle(url: string, s: HostState | null, active: boolean): string {
  const addr = url.replace(/^wss?:\/\//, '')
  if (!active) return addr
  if (s?.status === 'ready') return `${addr} · ${s.version}`
  return describeHostState(s).text
}
