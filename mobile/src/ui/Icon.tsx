import { Platform } from 'react-native'
import { useC } from '../theme/theme'
import { T } from './kit'
import { EMOJI, SF, type IconName } from './icons'

/**
 * 全 app 唯一画图标的地方。
 *
 * ★`expo-symbols` 走**运行时 require**,不是静态 import。它虽然已经编进当前这个包
 *  (ios/Podfile.lock 的 ExpoSymbols),但 web 端(`npm run --prefix mobile web`,真机验收
 *  一直在用的那条路)根本没有这个原生模块 —— 静态 import 会被 metro 提到最前无条件执行,
 *  整个 app 崩在那一行。同 `app/scan.tsx` / `chat.tsx` 的 CAN_PICK。
 *
 * ★探测失败就退 emoji,**不留空**:一个看不见的洞比一个不那么好看的 emoji 糟糕得多。
 */
const SYMBOLS: { SymbolView?: React.ComponentType<Record<string, unknown>> } = (() => {
  if (Platform.OS !== 'ios') return {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('expo-symbols') as { SymbolView?: React.ComponentType<Record<string, unknown>> }
  } catch {
    return {}
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
  // ★emoji 退路不吃 `color`:emoji 是彩色位图,染色染不动,硬染只会得到一个奇怪的方块。
  return <T style={{ fontSize: size }}>{EMOJI[name]}</T>
}
