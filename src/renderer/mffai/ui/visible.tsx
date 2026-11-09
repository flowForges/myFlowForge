// 看不见的字符(双向控制、零宽、软连字符…格式字符,和行/段分隔符)显示成看得见的 \u{…}:
// 屏幕上的顺序就是真实的顺序。PText(第三方文字)和审批卡片(要跑的命令)共用这一份。
import type { ReactNode } from 'react'

const INVISIBLE = /[\p{Cf}\u2028\u2029]/gu
const escOf = (ch: string) => `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`

/** 纯文本版本:铃铛的通知是 HTML 字符串,先换成可见的 \u{…} 再 sanitize() */
export function visibleText(text: string): string {
  return text.replace(INVISIBLE, escOf)
}

export function visibleChars(text: string, key = 'v'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INVISIBLE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(<span key={`${key}e${n++}`} className="mffai-esc">{escOf(m[0])}</span>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
