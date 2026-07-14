import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeItem, ChangeType } from '@shared/types'
import { FileIc } from './fileIcon'
import { SearchModeToggle, ContentHits, useContentSearch, type SearchTarget } from './contentSearch'

// 变更 (file changes) tab content — ports the prototype's #pane-changes
// CONTENT (the outer .insp-pane is owned by WorkspaceView).
//
// Single-project mode: pass `changes` (a flat list against one cwd) + `cwd`.
// Aggregate mode ("全部项目"): pass `groups` — one section per project worktree, each with
// its own cwd so clicking a file opens the preview against the RIGHT repo. The summary
// counts then span every group. When `groups` is set it takes precedence over `changes`.
//
// The flat ChangeItem[] is aggregated into a collapsible FOLDER TREE (like the 文件树 tab) so a large
// change set no longer sprawls open with no way to fold it. Folders collapse/expand individually; a
// header toggle does 全部展开/全部折叠. Default = all folders collapsed (seeded once). File leaves keep
// the original .chg-item row (A/M/D tag + type + add/del counts + click-to-open/diff).
//
// Search: 文件名 prunes the tree to matching paths (folders force-expanded); 内容 greps the CHANGED
// files' contents (restricted to this session's changes, per project cwd).

export interface ChangeGroup { name: string; cwd: string; changes: ChangeItem[] }

// ---- Folder-tree aggregation (renderer-side; must NOT import main's fileTree.ts) --------------
interface ChgNode {
  type: 'dir' | 'file'
  name: string
  path: string // dir: the folder prefix (e.g. "src/views"); file: the full ChangeItem path
  children?: ChgNode[]
  item?: ChangeItem
}

// Fold a flat list of change paths into a nested dir/file tree, preserving input order.
function buildChgTree(items: ChangeItem[]): ChgNode[] {
  const root: ChgNode[] = []
  const dirs = new Map<string, ChgNode>()
  for (const item of items) {
    const parts = item.path.split('/')
    const fileName = parts.pop() ?? item.path
    let level = root
    let prefix = ''
    for (const part of parts) {
      prefix = prefix ? prefix + '/' + part : part
      let node = dirs.get(prefix)
      if (!node) {
        node = { type: 'dir', name: part, path: prefix, children: [] }
        dirs.set(prefix, node)
        level.push(node)
      }
      level = node.children!
    }
    level.push({ type: 'file', name: fileName, path: item.path, item })
  }
  return root
}

// Collect every folder's collapse KEY (namespaced by the owning cwd so identical folder names across
// projects don't collide in the shared `closed` set).
function collectDirKeys(nodes: ChgNode[], prefix: string, acc: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === 'dir') { acc.push(prefix + '\0' + n.path); if (n.children) collectDirKeys(n.children, prefix, acc) }
  }
  return acc
}

// Prune the tree to files whose PATH includes the query (preserving matchName's path-based semantics),
// keeping folder structure. Empty folders drop out.
function filterChgTree(nodes: ChgNode[], q: string): ChgNode[] {
  const out: ChgNode[] = []
  for (const n of nodes) {
    if (n.type === 'dir') {
      const children = filterChgTree(n.children ?? [], q)
      if (children.length) out.push({ ...n, children })
    } else if (n.item!.path.toLowerCase().includes(q)) {
      out.push(n)
    }
  }
  return out
}

function countFiles(nodes: ChgNode[]): number {
  let n = 0
  for (const x of nodes) n += x.type === 'file' ? 1 : countFiles(x.children ?? [])
  return n
}

const FolderIcon = () => (
  <svg className="fi" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" style={{ color: 'var(--accent)' }}>
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

export function ChangesPane({
  changes,
  groups,
  cwd,
  onOpen,
  activePath,
  onRefresh
}: {
  changes: ChangeItem[]
  groups?: ChangeGroup[]
  /** cwd for the flat single-project `changes` list (needed for content search). */
  cwd?: string
  onOpen: (file: string, type: ChangeType, cwd?: string) => void
  /** Path of the file currently being previewed — its row gets the selected state.
      Used when the pane doubles as the full-screen browser's sidebar (continuous picking). */
  activePath?: string
  /** Manual 刷新: re-read git changes now. */
  onRefresh?: () => void
}) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'name' | 'content'>('name')
  const [refreshSpin, setRefreshSpin] = useState(false)
  const doRefresh = () => { if (!onRefresh) return; setRefreshSpin(true); onRefresh(); window.setTimeout(() => setRefreshSpin(false), 600) }
  const q = query.trim().toLowerCase()

  const all = groups ? groups.flatMap((g) => g.changes) : changes
  const adds = all.filter((c) => c.type === 'A').length
  const edits = all.filter((c) => c.type === 'M').length
  const dels = all.filter((c) => c.type === 'D').length

  // Build the folder tree(s). Single mode → one tree keyed by `cwd`; aggregate → one per group keyed
  // by that group's cwd. Keyed so the shared `closed` set never conflates same-named folders.
  const singleTree = useMemo(() => (groups ? null : buildChgTree(changes)), [groups, changes])
  const groupTrees = useMemo(
    () => (groups ? groups.map((g) => ({ ...g, tree: buildChgTree(g.changes) })) : null),
    [groups]
  )
  const allDirKeys = useMemo(() => {
    const acc: string[] = []
    if (groupTrees) for (const g of groupTrees) collectDirKeys(g.tree, g.cwd, acc)
    else if (singleTree) collectDirKeys(singleTree, cwd ?? '', acc)
    return acc
  }, [groupTrees, singleTree, cwd])

  // local set of CLOSED folder keys (empty set = everything open)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  // Start collapsed instead of dumping every changed file open (the reported complaint: "铺开且收不
  // 起来"). Seed ONCE, the first time there ARE folders — not on every changes update, or the git-status
  // poll would wipe folders the user just opened. A remount (switching project) resets the ref.
  const seeded = useRef(false)
  useEffect(() => {
    if (!seeded.current && allDirKeys.length) {
      seeded.current = true
      setClosed(new Set(allDirKeys))
    }
  }, [allDirKeys])

  const toggleFolder = (key: string) => {
    setClosed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const expandAll = () => setClosed(new Set())
  const collapseAll = () => setClosed(new Set(allDirKeys))
  // One toggle: collapse when anything is open, expand when all is collapsed.
  const allCollapsed = allDirKeys.length > 0 && allDirKeys.every((k) => closed.has(k))

  // Content search restricted to the changed files (per project cwd).
  const targets: SearchTarget[] = useMemo(() => {
    if (groups) return groups.filter((g) => g.changes.length).map((g) => ({ cwd: g.cwd, files: g.changes.map((c) => c.path) }))
    if (cwd && changes.length) return [{ cwd, files: changes.map((c) => c.path) }]
    return []
  }, [groups, cwd, changes])
  // Map (cwd + path) → change type so a content hit row can carry the correct A/M/D preview mode.
  const typeByKey = useMemo(() => {
    const m = new Map<string, ChangeType>()
    if (groups) for (const g of groups) for (const c of g.changes) m.set(g.cwd + '\0' + c.path, c.type)
    else if (cwd) for (const c of changes) m.set(cwd + '\0' + c.path, c.type)
    return m
  }, [groups, cwd, changes])
  const contentMode = mode === 'content' && targets.length > 0
  const search = useContentSearch(targets, query, contentMode)

  // File leaf — keeps the original .chg-item row so click-to-open, the A/M/D tag, add/del deltas and the
  // `activePath` selected state all behave exactly as before. The dir prefix is dropped because the
  // folder hierarchy now shows it; the basename stays a direct text node so getByText(basename) works.
  const Leaf = ({ item, name, openCwd }: { item: ChangeItem; name: string; openCwd?: string }) => (
    <button
      className={'chg-item chg-leaf' + (activePath === item.path ? ' on' : '')}
      data-file={item.path}
      data-type={item.type}
      onClick={() => onOpen(item.path, item.type, openCwd)}
    >
      <ChevIcon hidden />
      <span className={`chg-tag ${item.type}`}>{item.type}</span>
      <FileIc name={name} />
      <span className="chg-path">{name}</span>
      <span className="chg-delta">
        {item.add ? <span className="p">+{item.add}</span> : null}
        {item.del ? <span className="m">−{item.del}</span> : null}
      </span>
    </button>
  )

  // Render a folder tree. `keyPrefix` namespaces collapse keys; `openCwd` is the real cwd passed to
  // onOpen (may be undefined in single mode). `forceOpen` (search) ignores the collapsed set.
  const renderNodes = (nodes: ChgNode[], keyPrefix: string, openCwd: string | undefined, forceOpen: boolean): React.ReactNode =>
    nodes.map((n) => {
      if (n.type === 'dir') {
        const key = keyPrefix + '\0' + n.path
        const isClosed = !forceOpen && closed.has(key)
        return (
          <div key={key} className={`tree-folder${isClosed ? ' closed' : ''}`} data-folder={n.name}>
            <button className="tree-row" data-foldertoggle onClick={() => toggleFolder(key)}>
              <ChevIcon />
              <FolderIcon />
              <span>{n.name}</span>
            </button>
            <div className="tree-children">{renderNodes(n.children ?? [], keyPrefix, openCwd, forceOpen)}</div>
          </div>
        )
      }
      return <Leaf key={keyPrefix + '\0' + n.path} item={n.item!} name={n.name} openCwd={openCwd} />
    })

  return (
    <>
      <div className="chg-summary">
        <div className="chg-stat add">
          <div className="n">{adds}</div>
          <div className="l">新建</div>
        </div>
        <div className="chg-stat edit">
          <div className="n">{edits}</div>
          <div className="l">编辑</div>
        </div>
        <div className="chg-stat del">
          <div className="n">{dels}</div>
          <div className="l">删除</div>
        </div>
      </div>
      <div className="tree-tools">
        <div className="tree-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder={contentMode ? '搜索变更内容…' : '筛选变更文件…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {targets.length > 0 ? <SearchModeToggle mode={mode} onChange={setMode} /> : null}
        </div>
        {(onRefresh || (!(contentMode && q) && allDirKeys.length > 0)) && (
          <div className="tree-expand-tools">
            {onRefresh && (
              <button className="tree-tool-btn" title="刷新" aria-label="刷新变更" onClick={doRefresh}>
                <svg className={refreshSpin ? 'spin' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </button>
            )}
            {!(contentMode && q) && allDirKeys.length > 0 && (
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
            )}
          </div>
        )}
      </div>
      {/* 与 FileTreePane 对齐:切到「内容」但搜索框为空时不要清空文件列表,
          等真正有关键词再换成 content-hits(否则读作「文件列表消失了」)。 */}
      {contentMode && q ? (
        <ContentHits
          state={search}
          onOpen={(file, hitCwd) => onOpen(file, typeByKey.get(hitCwd + '\0' + file) ?? 'M', hitCwd)}
        />
      ) : (
        <>
          <div className="chg-list-h">本次会话变更 · {all.length} 个文件</div>
          {groupTrees ? (
            groupTrees.map((g) => {
              const tree = q ? filterChgTree(g.tree, q) : g.tree
              if (q && !countFiles(tree)) return null
              return (
                <div key={g.cwd}>
                  <div className="chg-group-h"><span>{g.name}</span><span className="n">{countFiles(tree)}</span></div>
                  <div className="tree chg-tree">{renderNodes(tree, g.cwd, g.cwd, !!q)}</div>
                </div>
              )
            })
          ) : (
            <div className="tree chg-tree">
              {renderNodes(q ? filterChgTree(singleTree ?? [], q) : singleTree ?? [], cwd ?? '', cwd, !!q)}
            </div>
          )}
        </>
      )}
    </>
  )
}
