import { createContext } from 'react'
import { previewKindOf } from '@shared/fileRef'

/** open() 的结果:'ok' 之外都是给用户看的失败原因(见 MdLink 的短暂提示)。 */
export type OpenFileResult = 'ok' | 'missing' | 'outside' | 'dir' | 'bad' | 'error'

export interface OpenFileApi {
  /** 解析相对路径的基准目录,按优先级:当前会话 worktree → 工作区根。 */
  bases: string[]
  open: (href: string) => Promise<OpenFileResult>
}

/**
 * 对话正文里的文件链接怎么打开。由 WorkspaceView 提供(它才知道 cwd / 工作区根,也只有它能开预览)。
 *
 * 和 MdImageBaseCtx 一样走 context 而不是逐层传 prop —— MdLink 埋在 Markdown → renderInline 底下,
 * 中间隔着好几层纯渲染函数。**拿不到 ctx 时 MdLink 保持原来的静默 no-op**(测试、别的面板),零回归。
 */
export const OpenFileCtx = createContext<OpenFileApi | null>(null)

export const OPEN_FILE_MSG: Record<Exclude<OpenFileResult, 'ok'>, string> = {
  missing: '文件不存在',
  outside: '不在工作区内',
  dir: '这是个目录',
  bad: '路径无效',
  error: '打不开',
}


export type ResolvedRefResult =
  | { ok: true; cwd: string; file: string; abs: string }
  | { ok: false; reason: 'missing' | 'outside' | 'dir' | 'bad' }

export interface OpenFileDeps {
  resolveFileRef?: (bases: string[], href: string) => Promise<ResolvedRefResult>
  openFilePath?: (bases: string[], href: string) => Promise<{ ok: boolean; error?: string }>
  /** 把解析出来的文件开进 app 的全屏查看器(WorkspaceView 的 openBrowse)。 */
  openInViewer: (file: string, cwd: string) => void
}

/**
 * 点击一个文件链接后的分流。抽成纯函数(依赖全部注入)是为了能脱开 WorkspaceView 单测 —— 这一层
 * 「什么进预览、什么丢给系统」的判断才是这个功能真正会出错的地方。
 */
export function makeOpenFileApi(bases: string[], deps: OpenFileDeps): OpenFileApi {
  return {
    bases,
    open: async (href: string): Promise<OpenFileResult> => {
      const r = await deps.resolveFileRef?.(bases, href)
      if (!r) return 'error'
      if (!r.ok) return r.reason
      // 预览显示不了的类型(pdf/xlsx/zip…)交给系统默认程序;其余(图片/markdown/代码/html)开进全屏
      // 查看器 —— 与工作流卡片的「打开文档」同一条路,聊天模式下右侧 inspector 是收起的,开那儿看不见。
      if (previewKindOf(r.file) === 'system') {
        const o = await deps.openFilePath?.(bases, href)
        return o?.ok ? 'ok' : 'error'
      }
      deps.openInViewer(r.file, r.cwd)
      return 'ok'
    },
  }
}
