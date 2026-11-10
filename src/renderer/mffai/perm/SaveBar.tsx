// 浮动保存条(08b R12):有改动才出现。保存的禁用规则和原来的内联按钮一样(保存中不可点)
import { Chip } from '../ui/Chip'

export function SaveBar({ dirty, busy, onSave }: { dirty: boolean; busy: boolean; onSave(): void }) {
  if (!dirty) return null
  return (
    <div className="mffai-savebar" role="group" aria-label="保存条">
      <Chip tone="warn" dot>未保存</Chip>
      <button className="set-btn mffai-primary" disabled={busy} onClick={onSave}>保存</button>
    </div>
  )
}
