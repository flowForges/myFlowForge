import { Pressable, View } from 'react-native'
import { useC } from '../theme/theme'
import { T } from './kit'
import { TIER_LABEL, type SessionTier } from '../data/sessionStatus'

/**
 * 贴底的定位气泡:「❓ 1 条等你答话 ↓」。点一下滚到那一条。
 *
 * ★**只显示最高的那一档。** 处理完自动降级到下一档,全清了整个气泡消失 ——
 *  「没有气泡 = 没你的事」是这一屏的核心承诺,所以它绝不显示 0。
 *
 * ★箭头指的是**目标相对当前视口的方向**,不固定朝下:门那条被你滑过去之后就在上面了。
 */
export function JumpBubble({
  tier, count, direction, onPress,
}: {
  tier: Exclude<SessionTier, 'idle'>
  count: number
  direction: 'up' | 'down'
  onPress: () => void
}) {
  const c = useC()
  const [bg, fg] =
    tier === 'gate' ? [c.gate, c.onGate]
    : tier === 'running' ? [c.ok, c.bg]
    : [c.accent, c.onAccent]
  return (
    <View pointerEvents="box-none"
          style={{ position: 'absolute', left: 0, right: 0, bottom: 16, alignItems: 'center' }}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          paddingHorizontal: 15, paddingVertical: 9, borderRadius: 999,
          backgroundColor: bg, shadowColor: c.shadow, shadowOpacity: 0.4,
          shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 6,
        }, pressed && { opacity: 0.85 }]}
      >
        <T style={{ fontSize: 12.5, fontWeight: '600', color: fg }}>
          {count} 条{TIER_LABEL[tier]}
        </T>
        <T style={{ fontSize: 14, color: fg }}>{direction === 'down' ? '↓' : '↑'}</T>
      </Pressable>
    </View>
  )
}
