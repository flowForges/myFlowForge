// 标签式输入(08 §11):规则的 match/noMatch 用例、联网名单共用。回车或点「添加」加一个标签(去空白、去重),
// 每个标签自己的按钮删它。
import { useState } from 'react'
import { Chip } from '../ui/Chip'

export function TagInput({ label, value, onChange }: {
  label: string
  value: readonly string[]
  onChange: (next: string[]) => void
}) {
  const [text, setText] = useState('')
  const add = () => {
    const v = text.trim()
    if (v && !value.includes(v)) onChange([...value, v])
    setText('')
  }
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i))
  return (
    <span className="mffai-tags">
      {value.map((t, i) => (
        <span key={`${i}-${t}`} className="mffai-tag">
          <Chip>{t}</Chip>
          <button type="button" aria-label={`删除 ${t}`} onClick={() => remove(i)}>删除</button>
        </span>
      ))}
      <input aria-label={label} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
      <button type="button" className="set-btn" onClick={add}>添加</button>
    </span>
  )
}
