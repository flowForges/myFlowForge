import { View } from 'react-native'
import { useC } from '../theme/theme'
import { DEFAULT_HOST_ICON } from '../net/hosts'
import { T } from './kit'

/**
 * 主机行左边那枚 34×34 的图标片。★**只此一份**:主机屏和设置屏都用它。
 *
 * 这块几何(34 / 圆角 10 / 1px 边)和 `Row` 的 54px 行高是配好的,两边各写一遍的话,
 * 改了其中一边就会出现「同一台机器在两屏上大小不一样」——而那种偏差没人会当成 bug 报上来,
 * 只会觉得这个 app 做得糙。
 */
export function HostIcon({ icon }: { icon: string }) {
  const c = useC()
  return (
    <View
      style={{
        width: 34,
        height: 34,
        borderRadius: 10,
        backgroundColor: c.bg2,
        borderWidth: 1,
        borderColor: c.border2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <T style={{ fontSize: 16 }}>{icon || DEFAULT_HOST_ICON}</T>
    </View>
  )
}
