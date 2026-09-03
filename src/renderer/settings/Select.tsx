import { useEffect, useRef, useState } from 'react'

/**
 * 设置里的下拉框。**自绘,不是 `<select>`。**
 *
 * ★★为什么非换掉原生的不可:原生 `<select>` 展开的那张单子是**操作系统画的**,CSS 一个字都管不着。
 *  这个 app 是深色/浅色/毛玻璃三套皮肤 + 壁纸取色,而那张系统单子只会按系统主题画 ——
 *  用户截图里那张半透明深绿的菜单就是它,和旁边的界面完全不是一个世界。
 *  这不是"再调调 CSS"能解决的,只能自己画。
 *
 * ★视觉语言抄的是聊天区那套 `.menu-pop` / `.menu-item`(模型选择器),不是新发明一套:
 *  同一个 app 里「点开一张单子挑一项」应该只有一种长相。
 *
 * ★键盘可用:↑↓ 移动、Enter/空格 选中、Esc 关掉、Tab 走开就关。原生 select 白送的这些,
 *  自绘就得自己补 —— 少补一样,这个控件对只用键盘的人就是坏的。
 * ★`role="listbox"` + `role="option"`:除了无障碍,测试也靠它定位(不再是 `querySelector('select')`)。
 */
export type SelectOption<T extends string> = { value: T; label: string }

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (v: T) => void
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  // 键盘高亮到第几项。★和 `value` 分开:光标移到哪儿和选中了哪个是两件事,
  //  合成一个的话「↓ 一下就直接改了值」——那和原生 select 的行为不一样,也更容易误改。
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  // 点外面关掉。★挂在 document 上而不是给页面盖一层透明遮罩:遮罩会吃掉「点另一个下拉框」
  //  这一下(得点两次才切),而那正是设置页里最常见的操作。
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const pick = (v: T) => { onChange(v); setOpen(false) }
  const openAt = () => {
    setCursor(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }

  return (
    <div className="set-sel" ref={rootRef}>
      <button
        type="button"
        className={`set-sel-btn${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openAt())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (!open) { openAt(); return }
          }
          if (!open) return
          if (e.key === 'ArrowDown') setCursor((i) => (i + 1) % options.length)
          else if (e.key === 'ArrowUp') setCursor((i) => (i - 1 + options.length) % options.length)
          else if (e.key === 'Enter' || e.key === ' ') pick(options[cursor]!.value)
          else if (e.key === 'Escape') setOpen(false)
        }}
        onBlur={(e) => { if (!rootRef.current?.contains(e.relatedTarget as Node)) setOpen(false) }}
      >
        <span className="set-sel-val">{current?.label ?? value}</span>
        <svg className="set-sel-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="set-sel-pop" role="listbox" aria-label={ariaLabel}>
          {options.map((o, i) => (
            <button
              type="button"
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`set-sel-item${o.value === value ? ' on' : ''}${i === cursor ? ' cur' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(o.value)}
            >
              {o.label}
              <svg className="set-sel-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
