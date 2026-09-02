import { Platform } from 'react-native'
import { useC } from '../theme/theme'
import { T } from './kit'
import { EMOJI, MATERIAL, SF, type IconName } from './icons'

/**
 * 全 app 唯一画图标的地方。
 *
 * ★`expo-symbols` 走**运行时 require**,不是静态 import。它虽然已经编进当前这个包
 *  (`npx expo-modules-autolinking resolve -p ios` 能看到 ExpoSymbols 会被链入 ——
 *  不是 `ios/Podfile.lock`:那份文件是 pod install 的下游产物,prebuild 会把它删掉,
 *  见 `icons.ts` 顶上同一条纠正),但 web 端(`npm run --prefix mobile web`,真机验收
 *  一直在用的那条路)根本没有这个原生模块 —— 静态 import 会被 metro 提到最前无条件执行,
 *  整个 app 崩在那一行。同 `app/scan.tsx` / `chat.tsx` 的 CAN_PICK。
 *
 * ★★安卓走 **Material Icons**(`@expo/vector-icons`),不再退 emoji。
 *  2026-08-29 真机反馈:安卓的 ＋ 面板上五个图标是「彩色 emoji + 单色字形 + 数学符号」三种画风混在一排,
 *  用户原话「太丑了」。emoji 那张表现在只是**最后的退路**(web,或者字体没加载上),
 *  真机上两个平台各走各的母语图标集。
 *
 * ★探测全失败才退 emoji,**不留空**:一个看不见的洞比一个不那么好看的 emoji 糟糕得多。
 */
/**
 * `expo-symbols` 的 `SymbolView` 我们**真正用到**的那几个 prop。
 * ★写成 `Record<string, unknown>` 的话,拼错一个 prop 名(`tintColour`)不会报错,
 *  只会静默变成「图标没有颜色」—— 而那是运行时才看得见的。这里把形状写实,交给 tsc 管。
 */
type SymbolViewProps = {
  name: string
  size: number
  tintColor: string
  resizeMode?: 'scaleAspectFit' | 'scaleAspectFill' | 'scaleToFill' | 'center'
  style?: { width: number; height: number }
}

const SYMBOLS: { SymbolView?: React.ComponentType<SymbolViewProps> } = (() => {
  if (Platform.OS !== 'ios') return {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('expo-symbols') as { SymbolView?: React.ComponentType<SymbolViewProps> }
  } catch {
    return {}
  }
})()

/**
 * 安卓(以及任何拿不到 SF Symbols 的原生平台)那一套。
 * ★同样走**运行时 require**,理由和上面那段一模一样:web 端没有这套字体,
 *  静态 import 会被 metro 提到最前无条件执行。
 */
const MaterialIcons: React.ComponentType<{ name: string; size: number; color: string; allowFontScaling?: boolean }> | null = (() => {
  if (Platform.OS === 'web') return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@expo/vector-icons/MaterialIcons').default ?? null
  } catch {
    return null
  }
})()

export function Icon({
  name,
  size = 17,
  color,
}: {
  name: IconName
  size?: number
  color?: string
}) {
  const c = useC()
  const tint = color ?? c.fg
  const SymbolView = SYMBOLS.SymbolView
  if (!SymbolView && MaterialIcons) {
    // ★`allowFontScaling={false}`:图标不该跟着系统字号一起变大 —— 它是在一个定死尺寸的
    //  方格里(＋ 面板那几格、行尾那颗 ›),跟着放大只会被裁掉一角。
    return <MaterialIcons name={MATERIAL[name]} size={size} color={tint} allowFontScaling={false} />
  }
  if (SymbolView) {
    return (
      <SymbolView
        name={SF[name]}
        size={size}
        tintColor={tint}
        // resizeMode 让符号按 size 等比缩放而不是被裁 —— SF Symbols 的默认行为会按字体基线对齐,
        // 摆在一行 flex 里会莫名其妙地偏上。
        resizeMode="scaleAspectFit"
        style={{ width: size, height: size }}
      />
    )
  }
  // ★color 路被所有字形认可:彩色位图(emoji)会忽略它,纯文本字形(›▾＋)会应用它。
  //  让每一个字形做它自己的事——不用维护「哪些是 emoji」的第二份真相。
  return <T style={{ fontSize: size, color: tint }}>{EMOJI[name]}</T>
}
