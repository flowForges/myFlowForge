// 看不见的字符(双向控制、零宽、软连字符…格式字符,和行/段分隔符)显示成看得见的 \u{…}:
// 屏幕上的顺序就是真实的顺序。PText(第三方文字)和审批卡片(要跑的命令)共用这一份。
import type { ReactNode } from 'react'

const INVISIBLE = /[\p{Cf}\u2028\u2029]/gu

export function visibleChars(text: string, key = 'v'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INVISIBLE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const cp = m[0].codePointAt(0)!.toString(16).toUpperCase()
    out.push(<span key={`${key}e${n++}`} className="mffai-esc">{`\\u{${cp}}`}</span>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
