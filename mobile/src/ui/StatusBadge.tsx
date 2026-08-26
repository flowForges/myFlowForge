import { View } from 'react-native'
import { MONO, useC } from '../theme/theme'
import { T } from './kit'
import { TIER_LABEL, type SessionTier } from '../data/sessionStatus'

/**
 * 四档阶梯的徽章胶囊。**形状语义照抄电脑端 `.ws-status-badge`**:
 * 小号等宽字、胶囊描边、多于一个加 `×N`。配色用手机端现有 token,不新造颜色。
 */
export function StatusBadge({ tier, count = 1 }: { tier: SessionTier; count?: number }) {
  const c = useC()
  if (tier === 'idle') return null
  const [fg, bd, bg] =
    tier === 'gate' ? [c.gate, c.pillGateBorder, c.gateDim]
    : tier === 'running' ? [c.ok, c.pillRunBorder, 'transparent']
    : [c.accent, c.pillAccBorder, 'transparent']
  const icon = tier === 'gate' ? '❓ ' : tier === 'running' ? '⚡ ' : ''
  return (
    <View style={{ borderWidth: 1, borderColor: bd, backgroundColor: bg,
                   borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 }}>
      <T style={{ fontFamily: MONO, fontSize: 9.5, color: fg }}>
        {icon}{TIER_LABEL[tier]}{count > 1 ? ` ×${count}` : ''}
      </T>
    </View>
  )
}
