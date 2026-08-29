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
 *
 * ★★★注册名是 `ExponentImagePicker`,**不是** `ExpoImagePicker` —— 别「顺手改正」它。
 *  `ExpoImagePicker` 只是 CocoaPods / SPM 的**包名**;原生模块**注册**用的仍是老名字,两端都是:
 *    - `node_modules/expo-image-picker/src/ExponentImagePicker.ts:2` → `requireNativeModule('ExponentImagePicker')`
 *    - `node_modules/expo-image-picker/ios/ImagePickerModule.swift:26` → `Name("ExponentImagePicker")`
 *    - Android 那份同名,而且两边原生源码里都还挂着 `// TODO: rename to "ExpoImagePicker"`(还没改)。
 *  ★教训:原生模块的注册名**只能从这个模块自己的源码里读出来**,不能照包名猜。猜错了
 *   `requireOptionalNativeModule` 恒返回 null → 探测永远说「没有」→ 入口一辈子不摆,
 *   而且是**朝着「看起来像这功能本来就没做」的方向静默失败**:typecheck 绿、全量测试绿、
 *   native:check 也绿,连新打的包上都是空的,没有任何一处会喊。第一版就是这么错的。
 */
export const canPickImage = (): boolean =>
  Platform.OS !== 'web' && !!requireOptionalNativeModule('ExponentImagePicker')

/**
 * 这台设备上「从文件选择器发文件」到底能不能用。同一套理由,不同一个模块:
 *
 * ★★注册名是 `ExpoDocumentPicker`(和这次的包名一致 —— 与 `expo-image-picker` 那个历史包袱
 *  `ExponentImagePicker` 不同,别顺手照抄那边的名字)。核实过两端:
 *    - `node_modules/expo-document-picker/src/ExpoDocumentPicker.ts:2` → `requireNativeModule('ExpoDocumentPicker')`
 *    - `node_modules/expo-document-picker/ios/DocumentPickerModule.swift:15` → `Name("ExpoDocumentPicker")`
 *    - Android 同名(`android/.../DocumentPickerModule.kt:29`)。
 *
 * ★web 上直接 false,和 `canPickImage` 一样的理由:手机端 web 通道只是开发时用的,
 *  不值得为它多养一条分支。
 */
export const canPickFile = (): boolean =>
  Platform.OS !== 'web' && !!requireOptionalNativeModule('ExpoDocumentPicker')
