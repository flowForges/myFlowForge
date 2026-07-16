import { useEffect, useRef, useState } from 'react'
import type { TreeNode, ChangeType } from '@shared/types'
import { FileIc } from './fileIcon'
import { SearchModeToggle, ContentHits, useContentSearch } from './contentSearch'

// 文件树 (file tree) tab content — ports the prototype's #pane-files
// CONTENT (the outer .insp-pane is owned by WorkspaceView).

const FolderIcon = () => (
  <svg
    className="fi"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    style={{ color: 'var(--accent)' }}
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
)

const ChevIcon = ({ hidden }: { hidden?: boolean }) =>
  hidden ? (
    <span className="chev hidden" />
  ) : (
    <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )

// Collect the path of every directory node in the tree (for collapse-all / default-collapsed).
function allDirPaths(nodes: TreeNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === 'dir') { acc.push(n.path); if (n.children) allDirPaths(n.children, acc) }
  }
  return acc
}

// Drop dot-files / dot-dirs (.env, .github, …) unless the user opts to show hidden files. Heavy dirs
// like .git/node_modules are already excluded by the backend walk (SKIP_DIRS); this is the softer,
// user-toggleable layer for ordinary hidden entries.
function stripHidden(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .filter(n => !n.name.startsWith('.'))
    .map(n => (n.children ? { ...n, children: stripHidden(n.children) } : n))
}

// Prune the tree to nodes matching the query, preserving folder structure.
// - file: kept iff its NAME (case-insensitive) includes the query
// - dir: kept iff it has ≥1 matching descendant file (with filtered children)
function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  const out: TreeNode[] = []
  for (const n of nodes) {
    if (n.type === 'dir') {
      const children = filterTree(n.children ?? [], q)
      if (children.length) out.push({ ...n, children })
    } else if (n.name.toLowerCase().includes(q)) {
      out.push(n)
    }
  }
  return out
}

export function FileTreePane({
  tree,
  onOpen,
  selected,
  searchRoot,
  onRefresh,
  focusSignal
}: {
  tree: TreeNode[]
  onOpen: (file: string, type: ChangeType, cwd?: string) => void
  /** Path of the file currently shown in the preview — its row gets the `.on` highlight. */
  selected?: string
  /** Root cwd for content (full-text) search. When absent, only 文件名 filtering is available. */
  searchRoot?: string
  /** Manual 刷新: re-read the tree now (aggregate mode has no git watcher, so new files need it). */
  onRefresh?: () => void
  /** 递增即聚焦搜索框(全局搜索 Cmd+Shift+F);由上层传入,与其它状态解耦。 */
  focusSignal?: number
}) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'name' | 'content'>('name')
  const searchInputRef = useRef<HTMLInputElement>(null)
  // 全局搜索触发:聚焦并全选搜索框内容,用户直接开打。切到本 tab 是父层(WorkspaceView)负责的。
  useEffect(() => { if (focusSignal) { const el = searchInputRef.current; el?.focus(); el?.select() } }, [focusSignal])
  const [showHidden, setShowHidden] = useState(false)
  // Spin the 刷新 icon on click so the refresh is visibly acknowledged. onRefresh is fire-and-forget
  // (the tree re-fetches via parent state), so spin for a fixed short beat rather than awaiting it.
  const [refreshSpin, setRefreshSpin] = useState(false)
  const doRefresh = () => { if (!onRefresh) return; setRefreshSpin(true); onRefresh(); window.setTimeout(() => setRefreshSpin(false), 600) }
  const contentMode = mode === 'content' && !!searchRoot
  const search = useContentSearch(searchRoot ? [{ cwd: searchRoot }] : [], query, contentMode)
  // local set of CLOSED folder paths (empty set = everything open)
  const [closed, setClosed] = useState<Set<string>>(new Set())

  // Start collapsed instead of dumping a fully-expanded tree on the user. Seed ONCE, the first time
  // the tree has content — not on every `tree` change, or a background refetch (git status polling
  // re-fetches the tree) would wipe folders the user just opened. A remount (switching project) resets
  // the ref, so each newly-opened tree starts collapsed again.
  const seeded = useRef(false)
  useEffect(() => {
    if (!seeded.current && tree.length) {
      seeded.current = true
      setClosed(new Set(allDirPaths(tree)))
    }
  }, [tree])

  const toggleFolder = (path: string) => {
    setClosed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const expandAll = () => setClosed(new Set())
  const collapseAll = () => setClosed(new Set(allDirPaths(tree)))
  // One toggle instead of two buttons: collapse when anything is open, expand when all is collapsed.
  const treeDirs = allDirPaths(tree)
  const allCollapsed = treeDirs.length > 0 && treeDirs.every(p => closed.has(p))

  const FileRow = ({ node }: { node: TreeNode }) => (
    <button
      className={'tree-row' + (selected && node.path === selected ? ' on' : '')}
      data-file={node.name}
      data-type={node.chg || ''}
      onClick={() => onOpen(node.path, node.chg ?? 'M')}
    >
      <ChevIcon hidden />
      <FileIc name={node.name} />
      <span>{node.name}</span>
      {node.chg ? <span className={`chg-mini ${node.chg}`} /> : null}
    </button>
  )

  const renderNodes = (nodes: TreeNode[], forceOpen = false): React.ReactNode =>
    nodes.map((n) => {
      if (n.type === 'dir') {
        const isClosed = !forceOpen && closed.has(n.path)
        return (
          <div
            key={n.path}
            className={`tree-folder${isClosed ? ' closed' : ''}`}
            data-folder={n.name}
          >
            <button className="tree-row" data-foldertoggle onClick={() => toggleFolder(n.path)}>
              <ChevIcon />
              <FolderIcon />
              <span>{n.name}</span>
              {n.branch && (
                <span className="tree-branch-tag" title={`git 分支:${n.branch}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
                  {n.branch}
                </span>
              )}
            </button>
            <div className="tree-children">{renderNodes(n.children ?? [], forceOpen)}</div>
          </div>
        )
      }
      return <FileRow key={n.path} node={n} />
    })

  const q = query.trim().toLowerCase()
  const baseTree = showHidden ? tree : stripHidden(tree)
  // When a query is active, render the SAME nested structure but pruned to
  // matching files, with all folders force-expanded (ignore the closed Set).
  const nodesToRender = q ? filterTree(baseTree, q) : baseTree

  return (
    <>
      <div className="tree-tools">
        <div className="tree-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            id="treeSearch"
            placeholder={contentMode ? '搜索文件内容…' : '筛选文件…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* 文件名/内容 切换嵌进搜索框内,与筛选合成一个 input。后面紧跟工具按钮,同一行自适应、不换行。 */}
          {searchRoot ? <SearchModeToggle mode={mode} onChange={setMode} /> : null}
        </div>
        <div className="tree-expand-tools">
          {onRefresh && (
            <button className="tree-tool-btn" title="刷新" aria-label="刷新" onClick={doRefresh}>
              <svg className={refreshSpin ? 'spin' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
          )}
          <button
            className={'tree-tool-btn' + (showHidden ? ' on' : '')}
            title={showHidden ? '隐藏 . 开头的文件' : '显示隐藏文件'}
            aria-label="显示隐藏文件"
            aria-pressed={showHidden}
            onClick={() => setShowHidden(v => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {showHidden ? (
                <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>
              ) : (
                <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></>
              )}
            </svg>
          </button>
          <button
            className="tree-tool-btn"
            title={allCollapsed ? '全部展开' : '全部收起'}
            aria-label={allCollapsed ? '全部展开' : '全部收起'}
            onClick={allCollapsed ? expandAll : collapseAll}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {allCollapsed ? (
                <><polyline points="7 13 12 18 17 13" /><polyline points="7 6 12 11 17 6" /></>
              ) : (
                <><polyline points="7 11 12 6 17 11" /><polyline points="7 18 12 13 17 18" /></>
              )}
            </svg>
          </button>
        </div>
      </div>
      {contentMode && query.trim() ? (
        // Only swap the tree for content-hits once the user has actually typed a keyword. Switching to
        // 内容 mode with an EMPTY box used to blank the tree immediately (just the "输入关键词" hint),
        // which read as "my files vanished". Keep the tree visible until there's something to search.
        <ContentHits state={search} onOpen={(file, cwd) => onOpen(file, 'M', cwd)} />
      ) : (
        <div className="tree" id="fileTree">
          {renderNodes(nodesToRender, !!q)}
        </div>
      )}
    </>
  )
}
