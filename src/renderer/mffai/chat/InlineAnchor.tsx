// 面板展开时,对话流里卡片原位置的锚点块(08b §4.3、R3):待批审批(琥珀)、运行中 / 结束未合并的委派(强调色)。点了在面板里打开那张卡片。
import { Icon } from '../shell/icons'

export function InlineAnchor({ tone, label, onOpen }: { tone: 'warn' | 'run'; label: string; onOpen(): void }) {
  return (
    <button type="button" className={`mffai-anchor ${tone}`} onClick={onOpen}>
      {label}
      <Icon name="chevr" size={12} />
    </button>
  )
}
