// 第三方写的文字(插件的名字、描述、命令、参数、地址……):只当文字,包在 .mffai-ptext 里,和界面自己的块分得开。
// 后台已经把控制字符、双向控制符、零宽字符写成看得见的 \uXXXX,这里原样显示;漏网的格式字符再显示成 \u{…}。
// 从不渲染成链接、按钮或状态块。
import { visibleChars } from './visible'

export { visibleChars }

export function PText({ text, mono }: { text: string; mono?: boolean }) {
  return <span className={`mffai-ptext${mono ? ' mono' : ''}`}>{visibleChars(text)}</span>
}
