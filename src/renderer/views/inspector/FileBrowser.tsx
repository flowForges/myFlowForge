import { useEffect } from 'react'
import type { TreeNode, ChangeType, ChangeItem } from '@shared/types'
import { FileTreePane } from './FileTreePane'
import { FilePreview } from './FilePreview'
import { ProjectPicker } from './ProjectPicker'
import { ChangesPane, type ChangeGroup } from './ChangesPane'

// 全屏文件浏览器 —— 覆盖整个工作区视图:左侧窄列是文件树(可持续点选),右侧一大片是文件内容/Diff。
// 取代原来挤在 380px 检查器下半段的上下分屏。Esc 或右上角「关闭」返回对话。
//
// source='changes' 时左栏换成变更清单(复用 ChangesPane),供「变更」pane 点进来后
// 连续评审:点一条切右侧预览(默认 diff),当前预览行高亮。
export function FileBrowser({
  tree,
  projects,
  activeCwd,
  onSelectProject,
  preview,
  onOpen,
  onClose,
  source = 'files',
  changes = [],
  groups,
  changesCwd,
  searchRoot,
  onOpenChange,
}: {
  tree: TreeNode[]
  projects: { name: string; cwd: string }[]
  activeCwd: string | undefined
  onSelectProject: (cwd: string) => void
  preview: { file: string; type: ChangeType; cwd: string; mode?: 'diff' | 'full' } | null
  onOpen: (file: string, type: ChangeType, cwd?: string) => void
  onClose: () => void
  /** What the left sidebar shows: the file tree (default) or the changes list. */
  source?: 'files' | 'changes'
  changes?: ChangeItem[]
  groups?: ChangeGroup[]
  /** cwd for the flat single-project changes list (content search of changed files). */
  changesCwd?: string
  /** Root cwd for file-tree content (full-text) search. */
  searchRoot?: string
  onOpenChange?: (file: string, type: ChangeType, cwd?: string) => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="file-browser" role="dialog" aria-label="文件浏览">
      <div className="fb-head">
        <span className="fb-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
          文件浏览
        </span>
        <button className="fb-close" onClick={onClose} aria-label="关闭文件浏览">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          关闭
        </button>
      </div>
      <div className="fb-body">
        <div className="fb-tree">
          <ProjectPicker projects={projects} activeCwd={activeCwd} onSelect={onSelectProject} />
          {source === 'changes' ? (
            <ChangesPane changes={changes} groups={groups} cwd={changesCwd} onOpen={onOpenChange ?? (() => {})} activePath={preview?.file} />
          ) : (
            <FileTreePane tree={tree} onOpen={onOpen} selected={preview?.file} searchRoot={searchRoot} />
          )}
        </div>
        <div className="fb-main">
          {preview ? (
            <FilePreview embedded open cwd={preview.cwd} file={preview.file} type={preview.type} initialMode={preview.mode} onClose={onClose} />
          ) : (
            <div className="fb-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
              <span>从左侧选择一个文件查看内容</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
