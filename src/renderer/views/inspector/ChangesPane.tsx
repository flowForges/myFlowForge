import { useMemo, useState } from 'react'
import type { ChangeItem, ChangeType } from '@shared/types'
import { FileIc, splitPath } from './fileIcon'
import { SearchModeToggle, ContentHits, useContentSearch, type SearchTarget } from './contentSearch'

// 变更 (file changes) tab content — ports the prototype's #pane-changes
// CONTENT (the outer .insp-pane is owned by WorkspaceView).
//
// Single-project mode: pass `changes` (a flat list against one cwd) + `cwd`.
// Aggregate mode ("全部项目"): pass `groups` — one section per project worktree, each with
// its own cwd so clicking a file opens the preview against the RIGHT repo. The summary
// counts then span every group. When `groups` is set it takes precedence over `changes`.
//
// Search: 文件名 filters the change rows by path; 内容 greps the CHANGED files' contents
// (restricted to this session's changes, per project cwd).

export interface ChangeGroup { name: string; cwd: string; changes: ChangeItem[] }

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

  const matchName = (c: ChangeItem) => !q || c.path.toLowerCase().includes(q)

  const Row = (c: ChangeItem, cwdOfRow?: string) => {
    const { dir, file } = splitPath(c.path)
    return (
      <button
        key={(cwdOfRow ?? '') + c.path}
        className={'chg-item' + (activePath === c.path ? ' on' : '')}
        data-file={c.path}
        data-type={c.type}
        onClick={() => onOpen(c.path, c.type, cwdOfRow)}
      >
        <span className={`chg-tag ${c.type}`}>{c.type}</span>
        <FileIc name={file} />
        <span className="chg-path">
          {dir ? <span className="dir">{dir}</span> : null}
          {file}
        </span>
        <span className="chg-delta">
          {c.add ? <span className="p">+{c.add}</span> : null}
          {c.del ? <span className="m">−{c.del}</span> : null}
        </span>
      </button>
    )
  }

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
        </div>
        {targets.length > 0 ? <SearchModeToggle mode={mode} onChange={setMode} /> : null}
        {onRefresh && (
          <div className="tree-expand-tools">
            <button className="tree-tool-btn" title="刷新" aria-label="刷新变更" onClick={doRefresh}>
              <svg className={refreshSpin ? 'spin' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
          </div>
        )}
      </div>
      {contentMode ? (
        <ContentHits
          state={search}
          onOpen={(file, hitCwd) => onOpen(file, typeByKey.get(hitCwd + '\0' + file) ?? 'M', hitCwd)}
        />
      ) : (
        <>
          <div className="chg-list-h">本次会话变更 · {all.length} 个文件</div>
          {groups ? (
            groups.map((g) => {
              const rows = g.changes.filter(matchName)
              if (q && !rows.length) return null
              return (
                <div key={g.cwd}>
                  <div className="chg-group-h"><span>{g.name}</span><span className="n">{rows.length}</span></div>
                  <div>{rows.map((c) => Row(c, g.cwd))}</div>
                </div>
              )
            })
          ) : (
            <div>{changes.filter(matchName).map((c) => Row(c, cwd))}</div>
          )}
        </>
      )}
    </>
  )
}
