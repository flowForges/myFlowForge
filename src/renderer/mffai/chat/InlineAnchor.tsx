// 面板展开时,对话流里卡片原位置的锚点块(08b §4.3、R3):待批审批(琥珀)、运行中 / 结束未合并的委派(强调色)。点了在面板里打开那张卡片。
import type { ReactNode } from 'react'
import { Icon } from '../shell/icons'
import { visibleChars } from '../ui/visible'

/** name 是第三方的工具名 / 执行器名:看不见的字符显示成转义;state 是我们的字 */
export function InlineAnchor({ tone, name, state, onOpen }: { tone: 'warn' | 'run'; name: string; state: string; onOpen(): void }) {
  const label: ReactNode[] = [...visibleChars(name, 'n'), ` ${state}`]
  return (
    <button type="button" className={`mffai-anchor ${tone}`} onClick={onOpen}>
      {label}
      <Icon name="chevr" size={12} />
    </button>
  )
}
