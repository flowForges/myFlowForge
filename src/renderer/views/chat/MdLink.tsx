import { useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CopyButton } from './blocks'
import { classifyHref } from '@shared/fileRef'
import { OpenFileCtx, OPEN_FILE_MSG } from './openFile'
import type { OpenFileResult } from './openFile'

// 对话正文里的链接。
//
// 两件事以前是断的:
//  1) 模型甩一个裸地址(「打开 http://localhost:8766/ review」)时它只是普通文字,点不了;
//  2) [文字](url) 虽然渲染成 <a target="_blank">,但主进程从没设过 setWindowOpenHandler —— 点击的结果
//     是 Electron 默认新建一个裸 BrowserWindow,不是用户的浏览器。
//
// 所以这里把点击整个接管:一律 preventDefault,再按协议分流。**不导航是硬要求**——模型很爱写
// [index.html](index.html) 这种相对路径,在渲染进程里点下去会把整个 SPA 导航走,app 直接白屏。
//
// 第三件事(本次):模型产出文档/图片后写的 [设计文档](docs/design.md) 以前点了完全没反应。现在这类
// href 交给 OpenFileCtx —— 工作区内的文件开进 app 的全屏查看器,预览不了的类型丢给系统默认程序。
// 解析(存在性/越界)在主进程,且**只在点击时做**:渲染时探测会让每条消息都打一批 IPC 还闪。

function protocolOf(href: string): string {
  try { return new URL(href, 'file:///').protocol } catch { return '' }
}

export function MdLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  const kind = classifyHref(href)
  // 相对路径经 new URL(href, 'file:///') 解析后是 'file:',自然落到「不可外开」那一侧。
  const external = kind === 'external' && /^https?:$/i.test(protocolOf(href))
  const opener = useContext(OpenFileCtx)
  const canOpenFile = kind === 'path' && !!opener
  const [err, setErr] = useState<Exclude<OpenFileResult, 'ok'> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return (
    <span className="md-link-wrap">
      <a
        className={'md-link' + (canOpenFile ? ' md-link-file' : '')}
        href={href}
        title={err ? OPEN_FILE_MSG[err] : canOpenFile ? `打开 ${href}` : undefined}
        onClick={e => {
          e.preventDefault()
          if (external) { void window.forge?.openExternal?.(href); return }
          if (!opener || kind !== 'path') return
          void opener.open(href).then(r => {
            if (r === 'ok') { setErr(null); return }
            // 主窗口没有 toast 系统,失败就在链接后面挂一条 2 秒自动消失的小字。
            setErr(r)
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => setErr(null), 2000)
          })
        }}
      >
        {children}
      </a>
      {/* 复制只对真能访问的地址给 —— 相对路径复制出去也没人能用。
          按钮常驻占位、hover 才显形(见 chat.css):hover 时才撑开宽度会让整段文字跳一下。 */}
      {external ? <CopyButton className="md-link-copy" title="复制链接" text={() => href} /> : null}
      {err ? <span className="md-link-err">{OPEN_FILE_MSG[err]}</span> : null}
    </span>
  )
}
