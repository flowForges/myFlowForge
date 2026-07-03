import type { Pet } from '@shared/types'
import type { PopupActiveAgent } from './derivePopupData'
import { deriveBubble } from './deriveBubble'

interface PetBubbleProps {
  active: PopupActiveAgent[]
  seed: string
  corner: Pet['corner']
  onOpen: () => void
}

// 执行时自动弹出的漫画话语气泡(人格问候 + 动态阶段)。仿 PetToasts 定位,带指向宠物的三角尾巴。
export function PetBubble({ active, seed, corner, onOpen }: PetBubbleProps) {
  const b = deriveBubble(active, seed)
  if (!b) return null
  return (
    <div className="pet-bubble-wrap" data-corner={corner}>
      <button className="pet-bubble" onClick={onOpen} title="点击查看详情">
        <div className="pb-greet">{b.greet}</div>
        <div className="pb-stage">{b.stage}</div>
      </button>
    </div>
  )
}
