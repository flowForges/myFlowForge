import { createPushBridge, type PushBridge } from './pushBridge'
import { sendExpoPush } from './expoPush'
import { readDevices, registerDevice, removeDevice, removeDevices, touchDevice, type PushDevice } from './pushStore'
import { readSettings } from '../config/store'
import { readWorkspaceRegistry } from '../config/store'
import { logInfo } from '../log/appLog'

/**
 * 推送的单例接线。**跟 `botBridge` 同一个形状** —— `index.ts` 在广播路径上调 `observe`,
 * `registerIpc` 注册那几个 `push:*` 方法,两边看到的是同一个实例。
 *
 * ★为什么是懒建:`readSettings` 会读盘,而这个模块在 `handlers.ts` 顶上就被 import 了 ——
 *  模块加载期读盘会在测试里凭空多出一堆 I/O,也会让「一个从来不用推送的用户」白读一次文件。
 */
let bridge: PushBridge | null = null

function get(): PushBridge {
  if (bridge) return bridge
  bridge = createPushBridge({
    cfg: () => readSettings().push,
    devices: () => readDevices(),
    send: (msgs) => sendExpoPush(msgs, { onLog: (m) => logInfo('push', m) }),
    dropTokens: (tokens) => {
      removeDevices(tokens)
      logInfo('push', `摘掉 ${tokens.length} 枚已失效的推送令牌`)
    },
    workspaceName: (path) => readWorkspaceRegistry().find((w) => w.path === path)?.name ?? '',
    now: () => Date.now(),
    onLog: (m) => logInfo('push', m),
  })
  return bridge
}

/** 测试专用:把单例丢掉,下次调用重新建。 */
export function __resetPushService(): void { bridge = null }

export const pushService = {
  observe(channel: string, payload: unknown): void { get().observe(channel, payload) },

  /** 手机登记它的推送令牌。★同一台手机重复调是安全的(按令牌认人)。 */
  register(d: { token: string; label?: string; platform?: PushDevice['platform'] }): PushDevice[] {
    const list = registerDevice(d, Date.now())
    logInfo('push', `登记了一台设备: ${d.label || d.platform || '手机'}(现在共 ${list.length} 台)`)
    return list
  },

  unregister(token: string): PushDevice[] {
    // ★注销的同时把在场状态也清掉:留着的话,一台刚刚注销的设备会以「他正看着呢」的身份
    //  继续压着别的判断,而它其实已经不在表里了。
    get().clearPresence(token)
    return removeDevice(token)
  },

  devices(): PushDevice[] { return readDevices() },

  /**
   * 手机报告「我现在在不在、在看哪儿」。
   *
   * ★`token` 可能是空的 —— 手机拿不到 Expo 推送令牌(没配 EAS 凭据)时照样会上报在场,
   *  那种情况下这条上报没有对应设备,直接忽略。不忽略的话内存里会攒一堆匿名 presence。
   */
  presence(token: string, p: { visible: boolean; at: { workspacePath: string; sessionId?: string | null } | null }): void {
    if (!token) return
    const now = Date.now()
    get().setPresence(token, { visible: !!p.visible, at: p.at ?? null, reportedAt: now })
    touchDevice(token, now)
  },

  sendTest() { return get().sendTest() },
}
