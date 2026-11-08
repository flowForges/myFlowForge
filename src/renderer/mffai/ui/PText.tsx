// 第三方写的文字(插件的名字、描述、命令、参数、地址……):只当文字,包在 .mffai-ptext 里,和界面自己的块分得开。
// 后台已经把控制字符、双向控制符、零宽字符写成看得见的 \uXXXX,这里原样显示;漏网的格式字符再显示成 \u{…}。
// 从不渲染成链接、按钮或状态块。
import type { ReactNode } from 'react'

/** 格式字符(双向控制、零宽、软连字符…)和行/段分隔符 */
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

export function PText({ text, mono }: { text: string; mono?: boolean }) {
  return <span className={`mffai-ptext${mono ? ' mono' : ''}`}>{visibleChars(text)}</span>
}
