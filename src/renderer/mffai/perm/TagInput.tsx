// 标签式输入(08 §11):规则的 match/noMatch 用例、联网名单共用。回车或点「添加」加一个标签(去空白、去重),
// 每个标签自己的按钮删它。失焦也提交(评审修订 5):用户点别处(包括保存按钮)时浏览器先触发 blur,
// 文字就不会因为没点「添加」而丢。registerFlush 让父组件在保存前再强制提交一次,不依赖事件顺序。
// errors 按 value 的下标标红(联网名单的 reason:'network' 用,评审修订 1),不是规则表的行错误。
import { useEffect, useRef, useState } from 'react'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'

export function TagInput({ label, value, onChange, disabled, errors, registerFlush }: {
  label: string
  value: readonly string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  errors?: ReadonlyMap<number, { reason: string }>
  /** 父组件保存前调一次,把还没点「添加」的文字也收进来 */
  registerFlush?: (flush: () => void) => () => void
}) {
  const [text, setText] = useState('')
  const add = () => {
    const v = text.trim()
    if (v && !value.includes(v)) onChange([...value, v])
    setText('')
  }
  // 总是最新的 add(闭包里的 value/onChange 跟着最近一次渲染),registerFlush 调的是这个 ref,不是某次渲染的快照
  const addRef = useRef(add)
  addRef.current = add
  useEffect(() => (registerFlush ? registerFlush(() => addRef.current()) : undefined), [registerFlush])

  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i))
  return (
    <span className="mffai-tags">
      {value.map((t, i) => {
        const err = errors?.get(i)
        return (
          <span key={`${i}-${t}`} className={`mffai-tag${err ? ' mffai-tag-bad' : ''}`}>
            <Chip>{t}</Chip>
            {err && <CodeChip code={err.reason} />}
            <button type="button" disabled={disabled} aria-label={`删除 ${t}`} onClick={() => remove(i)}>删除</button>
          </span>
        )
      })}
      <input aria-label={label} value={text} disabled={disabled} onChange={(e) => setText(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
      <button type="button" className="set-btn" disabled={disabled} onClick={add}>添加</button>
    </span>
  )
}
