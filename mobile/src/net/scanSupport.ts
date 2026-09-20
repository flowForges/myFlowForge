import { Platform } from 'react-native'
import { requireOptionalNativeModule } from 'expo-modules-core'

/**
 * 这台设备上「扫一扫」到底能不能用。
 *
 * ★★这不是防御性编程,是真机上崩过一次:JS 包是新的、装在手机上的**原生二进制是旧的**
 *  (Expo 的日常开发就是这样 —— 改 JS 不用重装,加原生模块才要)。而 `expo-camera` 的
 *  `requireNativeModule('ExpoCamera')` 是在 **import 那一行**就抛,不是等你用到相机才抛。
 *  于是「扫一扫」这个按钮照常显示、点下去整个 app 当场崩在 `scan.tsx:4`。
 *  比「没有这个功能」糟得多:没有功能只是少一条路,崩了是把人从正在做的事里踢出去。
 *
 * `requireOptionalNativeModule` 找不到时返回 null 而不是抛 —— 这是唯一能**安全地问**
 * 「这个包里有没有相机」的办法。
 */
export type ScanSupport =
  /** 能扫 */
  | 'ok'
  /** 网页版:相机开得了,但解码要浏览器的 BarcodeDetector,Safari 没有 */
  | 'web'
  /** 装在这台手机上的这个包里没有相机模块 —— 要重新装一次才有 */
  | 'missing'

export function scanSupport(): ScanSupport {
  if (Platform.OS === 'web') return 'web'
  return requireOptionalNativeModule('ExpoCamera') ? 'ok' : 'missing'
}
