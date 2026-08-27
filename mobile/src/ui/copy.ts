import { Platform } from 'react-native'
import { requireOptionalNativeModule } from 'expo-modules-core'

/**
 * 这个包里到底有没有剪贴板。
 *
 * ★★探测的理由和 `src/net/scanSupport.ts` 一模一样,而且是同一次事故:JS 包是新的、装在手机上的
 *  **原生二进制是旧的**(Expo 日常开发就是这样 —— 改 JS 不用重装,加原生模块才要),而原生模块是在
 *  **import 那一行**就抛,不是等你用到它才抛。上一次的现象是「扫一扫」照常显示、点下去整个 app
 *  当场崩(commit 144f1e4)。比「没有这个功能」糟得多:没有功能只是少一条路,崩了是把人从正在做的
 *  事里踢出去。所以 `canCopy()` 为假时**连那两个字都不摆**,不是摆一个灰的。
 *
 * ★RN 0.86 已经把内置的 `Clipboard` **移除**了,所以这件事非 `expo-clipboard` 不可 ——
 *  不是我们多引了一个包。
 *
 * ★★**下面这一段整个链路已经在真机同级环境上实测过一遍,别再从这里开始怀疑。**
 *  用户报「复制好像不是真的复制,没有到粘贴板里」时,第一反应都是怀疑这个文件。查下来全是好的:
 *   - 注册名对得上:原生 `ios/ClipboardModule.swift` 是 `Name("ExpoClipboard")`,JS 侧
 *     `build/ExpoClipboard.js` 是 `requireNativeModule('ExpoClipboard')`,和上面这句探测**同名**。
 *     (`expo-image-picker` 那种「注册名 `ExponentImagePicker` ≠ 包名」的坑,这个包**没有**。)
 *   - `require('expo-clipboard')` 拿到的就是命名空间本身:实测 `Object.keys(mod)` 头几个是
 *     `ClipboardPasteButton,getStringAsync,setStringAsync,…`,`typeof mod.setStringAsync === 'function'`,
 *     `mod.default === undefined` —— **没有藏在 `.default` 后面**。
 *   - 不传 options 是对的:原生 `SetStringOptions` 是个 `Record`,`@Field var inputFormat = .plainText`,
 *     空对象 `{}` 落到默认值。
 *   - 端到端:`copyText()` 回 true,紧接着 `getStringAsync()` 读回来一字不差,连 app 外面
 *     `xcrun simctl pbpaste` 都拿得到同一串。**写进去了。**
 *  真正的毛病在**按钮点不中**(22×13pt 的可点区域),已修在 `CopyBtn.tsx` —— 理由写在那里。
 */
export const canCopy = (): boolean =>
  Platform.OS === 'web' || !!requireOptionalNativeModule('ExpoClipboard')

export async function copyText(text: string): Promise<boolean> {
  try {
    if (Platform.OS === 'web') {
      // 浏览器里 `navigator.clipboard` 只在安全上下文(https / localhost)里有 —— 手机端 web 通道
      // 是开发时用的,常常就是明文 http 的内网地址,那里它是 undefined。所以必须判,不能直接点下去。
      const w = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } }).navigator
      if (!w?.clipboard?.writeText) return false
      await w.clipboard.writeText(text)
      return true
    }
    // ★**运行时 require,绝不能静态 import**:metro 会把静态 import 提到模块最前面无条件执行,
    //  那样上面那句探测就白做了 —— 旧包照样崩在 import 那一行(见 `app/scan.tsx:20-23` 的同一写法)。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('expo-clipboard') as { setStringAsync: (t: string) => Promise<boolean> }
    await mod.setStringAsync(text)
    return true
  } catch {
    // 复制这件事没有「一半成功」。失败就如实返回 false,由调用方去说一句话 ——
    // 静默失败的话人看到的是「我点了,什么都没发生」,然后再点三次。
    return false
  }
}
