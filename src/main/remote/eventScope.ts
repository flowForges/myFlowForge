import { CH } from '../ipc/channels'
import { pickHost, type Settings } from '../config/schema'

/**
 * 「广播出去之前,这条事件该让**连上来的那台设备**看见多少」。
 *
 * ★★为什么需要这一层:`settings:changed` 推的是这台机器 `readSettings()` 的**整份**设置,
 *  里面一半是「跟设备走」的(主题、壁纸、宠物、这台电脑对手机开不开门)。那一半是**这台电脑
 *  自己的**,对连上来的手机/另一台电脑毫无意义 —— 更糟的是,客户端会把它存进自己的设置快照,
 *  下一次它改任何一项设置时再写回自己的 client.json,于是主机的外观悄悄同化掉客户端的外观。
 *
 * ★2026-09-20 那个事故是这条路的**反方向**(客户端整份写回主机,把主机的代理改成了自己的),
 *  已经在 `configSetSettings` 那头用「只写在场的键」堵住。这一头堵的是同一个洞的另一端:
 *  **每一半设置,只有拥有它的那台机器才有资格往外说**。
 *
 * ★手机端只从这条事件里读 `disabledProviders`(见 mobile/src/data/useAgents.ts),
 *  那是 host 键 —— 收窄之后它拿到的东西一个字节都没少。
 */
export function scopeEventForRemoteClient(channel: string, payload: unknown): unknown {
  if (channel !== CH.settingsChanged) return payload
  if (!payload || typeof payload !== 'object') return payload
  return pickHost(payload as Settings)
}

/**
 * 把一条 `addSink` 包成「只对远程客户端说该说的」。
 *
 * ★包在**挂 sink 这一处**,而不是在网关或中转各写一遍:局域网那条和中转那条跑的是同一份
 *  `serveConnection`,但 sink 是各自挂的 —— 只改一边就是这个项目里最贵的那类 bug(两条路同一件事
 *  两种行为)。所以两处都从这里拿。
 */
export type AddSink = (sink: (channel: string, payload: unknown) => void) => () => void

export const remoteAddSink = (addSink: AddSink): AddSink =>
  (sink) => addSink((channel, payload) => sink(channel, scopeEventForRemoteClient(channel, payload)))
