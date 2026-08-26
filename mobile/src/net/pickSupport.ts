import { Platform } from 'react-native'
import { requireOptionalNativeModule } from 'expo-modules-core'

/**
 * 这台设备上「从相册发图」到底能不能用。
 *
 * ★★和 `scanSupport.ts` 同一个理由、同一次事故:`expo-image-picker` 是原生模块,装在手机上的那个包
 *  是加它之前打的,而原生模块在 **import 那一行**就抛。所以入口必须先问再摆,为假时**根本不渲染** ——
 *  摆一个灰的按钮等于告诉人「这里有东西,只是现在不能点」,而真相是「这个包里没有」。
 *  `requireOptionalNativeModule` 找不到时返回 null 而不是抛,是唯一能安全地问的办法。
 *
 * ★web 上直接 false:`expo-image-picker` 在 web 上走的是 `<input type=file>` 那一套,
 *  而手机端 web 通道只是开发时用的,不值得为它多养一条分支。
 */
export const canPickImage = (): boolean =>
  Platform.OS !== 'web' && !!requireOptionalNativeModule('ExpoImagePicker')
