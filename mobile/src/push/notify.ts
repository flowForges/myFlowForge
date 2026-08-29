import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import type { PushMessage } from '../../../src/shared/push/message'
import appJson from '../../app.json'
// ★纯函数单独一个零 import 的文件,这样它能被测(见 tapTarget.test.ts)。
import { tapTargetOf, type TapTarget } from './tapTarget'

export { tapTargetOf, type TapTarget }

/**
 * 手机这一侧碰 `expo-notifications` 的那一层。**判断逻辑一律不放这儿**(在 `decide.ts`)——
 * 这个文件里的东西在 node 那套 vitest 里跑不了。
 *
 * ★★这里每一个函数都**不抛**。通知是锦上添花的东西:权限被拒、原生模块没链上、
 *  系统版本不支持,任何一条都不该让 app 白屏或者某一屏进不去。全部压成返回值里的一句话。
 */

/** 和 daemon 那边 `ANDROID_CHANNEL` 必须一致,否则安卓上通知静默没声音。 */
export const CHANNEL_ID = 'default'

/**
 * Expo 推送项目 id。**没有它就拿不到远程推送令牌**(`getExpoPushTokenAsync` 直接抛)。
 *
 * ★从 `app.json` 读而不是 `expo-constants`:`expo-constants` 不是 `mobile/package.json` 的
 *  直接依赖 —— 原生在包里、JS 却 require 不到,这个坑 `expo-file-system` 上已经踩过一次。
 *  `app.json` 是编译期就打进 bundle 的普通 JSON,不会有这个问题。
 */
export const EAS_PROJECT_ID: string =
  ((appJson as { expo?: { extra?: { eas?: { projectId?: string } } } }).expo?.extra?.eas?.projectId ?? '').trim()

/** 前台也要显示横幅 —— 「app 开着但你在看别的会话」正是本地通知存在的理由。 */
export function installHandler(): void {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    })
  } catch { /* 原生模块缺失时静默 —— 见文件头 */ }
}

/** 安卓 8+ 没有渠道就不响。★渠道要在**请求权限之前**建好。 */
export async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: '门与完成提醒',
      importance: Notifications.AndroidImportance.DEFAULT,
      // 震动图案:一下短的。★给 null 在部分 ROM 上等于「完全不震」,而不是「用系统默认」。
      vibrationPattern: [0, 180],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    })
  } catch { /* 见文件头 */ }
}

export type PermState = 'granted' | 'denied' | 'undetermined' | 'unavailable'

export async function permissionState(): Promise<PermState> {
  try {
    const p = await Notifications.getPermissionsAsync()
    if (p.granted) return 'granted'
    return p.canAskAgain ? 'undetermined' : 'denied'
  } catch { return 'unavailable' }
}

/** ★只在用户**自己打开开关**的时候调。冷启动就弹系统权限框是最容易被直接拒掉的做法。 */
export async function requestPermission(): Promise<PermState> {
  try {
    const p = await Notifications.requestPermissionsAsync()
    if (p.granted) return 'granted'
    return p.canAskAgain ? 'undetermined' : 'denied'
  } catch { return 'unavailable' }
}

export type TokenResult =
  | { ok: true; token: string }
  /** 拿不到时**一定要有一句能读的原因** —— 否则设置里就是一个「没反应」的开关。 */
  | { ok: false; reason: string }

/**
 * 取远程推送令牌。
 *
 * ★★这一步是**远程推送**唯一的前置,而它需要用户自己在 Expo 上建一个项目:
 *  `app.json` 里没有 `extra.eas.projectId` 时,`getExpoPushTokenAsync` 直接抛。
 *  本地通知**不需要**它 —— 所以拿不到令牌不影响 app 里那一半提醒。
 */
export async function getPushToken(): Promise<TokenResult> {
  if (!EAS_PROJECT_ID) {
    return { ok: false, reason: '还没配 Expo 项目 id(app.json 的 extra.eas.projectId)—— 手机在后台时收不到提醒' }
  }
  try {
    const t = await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID })
    const token = (t?.data ?? '').trim()
    return token ? { ok: true, token } : { ok: false, reason: 'Expo 没给出令牌' }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** 立刻弹一条本地通知。 */
export async function presentLocal(m: PushMessage): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title: m.title, body: m.body, data: m.data as unknown as Record<string, unknown>, sound: 'default' },
      // null = 现在就弹。给一个 0 秒的 trigger 在 iOS 上会被当成非法值静默丢掉。
      trigger: null,
    })
  } catch { /* 见文件头 */ }
}


/** 点通知进来。★冷启动那一条要单独取一次 —— 监听器是在 app 起来之后才挂上的,赶不上。 */
export function onNotificationTap(cb: (t: TapTarget) => void): () => void {
  let disposed = false
  let sub: { remove: () => void } | null = null
  try {
    sub = Notifications.addNotificationResponseReceivedListener((e) => {
      const t = tapTargetOf(e?.notification?.request?.content?.data)
      if (t && !disposed) cb(t)
    })
    void Notifications.getLastNotificationResponseAsync().then((e) => {
      const t = tapTargetOf(e?.notification?.request?.content?.data)
      if (t && !disposed) cb(t)
    }).catch(() => {})
  } catch { /* 见文件头 */ }
  return () => { disposed = true; try { sub?.remove() } catch { /* 已卸 */ } }
}
