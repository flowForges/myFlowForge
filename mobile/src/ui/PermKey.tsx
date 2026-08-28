import { Pressable, StyleSheet } from 'react-native'
import type { PermissionMode } from '../../../src/shared/permissions'
import { useC } from '../theme/theme'
import { T } from './kit'
import { permShort } from './permShort'

/**
 * 输入行**左侧**那颗权限键。
 *
 * ★★为什么在左边:微信那个位置放的是语音/键盘切换 —— 一个「这条消息以什么方式发出去」的开关。
 *  权限档语义上完全对得上,而且常驻可见对安全是正确的。它原来是输入框**上方**
 *  一条横向滚动轨道里的一颗 chip,轨道一挤就滚出视野。
 *
 * ★★44×44 是硬下限,一点都不许缩。这套代码刚栽过一次:「复制」缩成 22×13pt 的死区,
 *  被当成剪贴板坏了。★而且**不许用 hitSlop 去补** —— 祖先紧贴子节点时 hitSlop 是死的
 *  (Fabric 的 overflowInset),那正是上面那个死区的成因。要热区就加真 padding。
 *
 * ★三色沿用 Chip 的那三档(permAutoBorder / permReadonlyBorder / permFullBorder),
 *  别在这儿另发明一套 —— 同一件事在两个地方用两种颜色说,人会以为它们是两件事。
 */
export function PermKey({
  mode, onPress, disabled,
}: {
  mode: PermissionMode
  onPress: () => void
  disabled?: boolean
}) {
  const c = useC()
  const map = {
    auto: { fg: c.accent, border: c.permAutoBorder },
    readonly: { fg: c.ok, border: c.permReadonlyBorder },
    full: { fg: c.err, border: c.permFullBorder },
  } as const
  const t = map[mode]
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityLabel={`权限:${permShort(mode)}`}
      style={({ pressed }) => [
        st.key,
        { borderColor: t.border, backgroundColor: c.bg2 },
        pressed && { backgroundColor: c.surface2 },
        disabled && { opacity: 0.42 },
      ]}
    >
      <T style={{ fontSize: 12.5, fontWeight: '600', color: t.fg }}>{permShort(mode)}</T>
    </Pressable>
  )
}

const st = StyleSheet.create({
  // ★宽 44、高 44 —— 最小触达线。两个字 12.5px ≈ 25pt 宽,剩下的是内边距,不是浪费。
  key: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
})
