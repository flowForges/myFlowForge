import type { ReactNode } from 'react'
import { CopyButton } from './blocks'

// 对话正文里的链接。
//
// 两件事以前是断的:
//  1) 模型甩一个裸地址(「打开 http://localhost:8766/ review」)时它只是普通文字,点不了;
//  2) [文字](url) 虽然渲染成 <a target="_blank">,但主进程从没设过 setWindowOpenHandler —— 点击的结果
//     是 Electron 默认新建一个裸 BrowserWindow,不是用户的浏览器。
//
// 所以这里把点击整个接管:一律 preventDefault,再按协议分流。**不导航是硬要求**——模型很爱写
// [index.html](index.html) 这种相对路径,在渲染进程里点下去会把整个 SPA 导航走,app 直接白屏。
const EXTERNAL = /^https?:$/i

function protocolOf(href: string): string {
  try { return new URL(href, 'file:///').protocol } catch { return '' }
}

export function MdLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  // 相对路径经 new URL(href, 'file:///') 解析后是 'file:',自然落到「不可外开」那一侧。
  const external = EXTERNAL.test(protocolOf(href))
  return (
    <span className="md-link-wrap">
      <a
        className="md-link"
        href={href}
        onClick={e => {
          e.preventDefault()
          if (external) void window.forge?.openExternal?.(href)
        }}
      >
        {children}
      </a>
      {/* 复制只对真能访问的地址给 —— 相对路径复制出去也没人能用。
          按钮常驻占位、hover 才显形(见 chat.css):hover 时才撑开宽度会让整段文字跳一下。 */}
      {external ? <CopyButton className="md-link-copy" title="复制链接" text={() => href} /> : null}
    </span>
  )
}
