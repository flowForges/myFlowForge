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
  const addr = addrOf(url)
  if (!active) return addr
  if (s?.status === 'ready') return `${addr} · ${s.version}`
  return describeHostState(s).text
}

/** 地址,去掉协议前缀。三个函数共用同一个口径。 */
const addrOf = (url: string): string => url.replace(/^wss?:\/\//, '')

/**
 * 顶栏那条横幅的**标题**。一句人话,跟微信「Mac 微信已登录」一个调调。
 *
 * ★2026-08-28 加这条横幅的理由:原来顶栏是两行 —— 主机名 + 一串
 *  `192.168.1.7:7777 · v1.2.0`。用户指着微信那条「Mac 微信已登录」说这块可以照着做,
 *  而他是对的:一切正常的时候,地址和版本一个字都不解决问题,它们只在**出事**的时候有用。
 *
 * ★和 `hostSubtitle` **不是同一件事,别合并**:那一份给的是主机屏 / 主机详情屏,
 *  那两屏就是用来看技术细节的,地址和版本必须一直显示。这一份要的正相反。
 *  合成一个带 `mode` 参数的函数,只会让每个调用方都先得想清楚自己要哪一档。
 */
export function hostBannerTitle(label: string, s: HostState | null): string {
  const name = label.trim() || '未选主机'
  if (!label.trim()) return name
  if (!s) return `${name} 未连接`
  switch (s.status) {
    case 'ready':
      return `${name} 已连接`
    case 'connecting':
      return `${name} 连接中…`
    case 'retrying':
    case 'failed':
      return `${name} 连不上`
    case 'closed':
      return `${name} 未连接`
  }
}

/**
 * 横幅的**第二行**。★★连上的时候返回 `null` —— 这是整条横幅存在的意义。
 *
 * 返回空串而不是 null 的话,调用方会渲染出一个高度不为 0 的空 `<T>`,顶栏平白高一截;
 * 而返回地址的话,就等于什么都没改。**必须是 null,调用方必须判 null 才渲染。**
 *
 * 出事的时候相反:那一刻屏幕上没有别的地方在说明原因,地址和原因都得给。
 */
export function hostBannerDetail(url: string, s: HostState | null): string | null {
  const addr = addrOf(url)
  if (s?.status === 'ready') return null
  if (s?.status === 'retrying' || s?.status === 'failed') return `${addr} · ${describeHostState(s).text}`
  return addr
}
