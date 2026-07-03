import { useState } from 'react'
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
  searchRoot
}: {
  tree: TreeNode[]
  onOpen: (file: string, type: ChangeType, cwd?: string) => void
  /** Path of the file currently shown in the preview — its row gets the `.on` highlight. */
  selected?: string
  /** Root cwd for content (full-text) search. When absent, only 文件名 filtering is available. */
  searchRoot?: string
}) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'name' | 'content'>('name')
  const contentMode = mode === 'content' && !!searchRoot
  const search = useContentSearch(searchRoot ? [{ cwd: searchRoot }] : [], query, contentMode)
  // local set of CLOSED folder paths (default = open)
  const [closed, setClosed] = useState<Set<string>>(new Set())

  const toggleFolder = (path: string) => {
    setClosed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

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
            </button>
            <div className="tree-children">{renderNodes(n.children ?? [], forceOpen)}</div>
          </div>
        )
      }
      return <FileRow key={n.path} node={n} />
    })

  const q = query.trim().toLowerCase()
  // When a query is active, render the SAME nested structure but pruned to
  // matching files, with all folders force-expanded (ignore the closed Set).
  const nodesToRender = q ? filterTree(tree, q) : tree

  return (
    <>
      <div className="tree-tools">
        <div className="tree-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            id="treeSearch"
            placeholder={contentMode ? '搜索文件内容…' : '筛选文件…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {searchRoot ? <SearchModeToggle mode={mode} onChange={setMode} /> : null}
      </div>
      {contentMode ? (
        <ContentHits state={search} onOpen={(file, cwd) => onOpen(file, 'M', cwd)} />
      ) : (
        <div className="tree" id="fileTree">
          {renderNodes(nodesToRender, !!q)}
        </div>
      )}
    </>
  )
}
