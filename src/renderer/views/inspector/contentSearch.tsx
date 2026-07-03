import { useEffect, useState } from 'react'
import type { ContentHit } from '@shared/types'
import { FileIc, splitPath } from './fileIcon'

// Full-text ("搜索内容") support shared by the 文件树 and 变更 panes.
// A search target is a root cwd plus an optional file subset (the 变更 pane restricts the
// search to the changed files; the 文件树 pane searches the whole root).
export interface SearchTarget { cwd: string; files?: string[] }
export type UiHit = ContentHit & { cwd: string }

interface SearchState { hits: UiHit[]; truncated: boolean; loading: boolean; ran: boolean }
const IDLE: SearchState = { hits: [], truncated: false, loading: false, ran: false }

// Debounced content search across one or more targets. Merges hits, tagging each with the
// target cwd so a click can open the file against the right repo.
export function useContentSearch(targets: SearchTarget[], query: string, enabled: boolean): SearchState {
  const [state, setState] = useState<SearchState>(IDLE)
  const q = query.trim()
  // Stable dependency for the target set (array identity changes every render).
  const key = JSON.stringify(targets.map((t) => [t.cwd, t.files ?? null]))
  useEffect(() => {
    if (!enabled || !q) { setState(IDLE); return }
    let live = true
    setState((s) => ({ ...s, loading: true }))
    const timer = setTimeout(() => {
      const runners = targets.map((t) =>
        window.forge
          .searchContent({ root: t.cwd, query: q, files: t.files })
          .then((r) => ({ t, r }))
          .catch(() => ({ t, r: { hits: [], truncated: false } }))
      )
      void Promise.all(runners).then((results) => {
        if (!live) return
        const hits: UiHit[] = []
        let truncated = false
        for (const { t, r } of results) {
          for (const h of r.hits) hits.push({ ...h, cwd: t.cwd })
          if (r.truncated) truncated = true
        }
        setState({ hits, truncated, loading: false, ran: true })
      })
    }, 250)
    return () => { live = false; clearTimeout(timer) }
    // targets tracked via `key`; window.forge is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, q, enabled])
  return state
}

// Segmented 文件名 / 内容 toggle — reuses the .pv-toggle look already in inspector.css.
export function SearchModeToggle({ mode, onChange }: { mode: 'name' | 'content'; onChange: (m: 'name' | 'content') => void }) {
  return (
    <div className="search-mode" role="tablist" aria-label="搜索方式">
      <button role="tab" aria-selected={mode === 'name'} className={mode === 'name' ? 'on' : ''} onClick={() => onChange('name')}>文件名</button>
      <button role="tab" aria-selected={mode === 'content'} className={mode === 'content' ? 'on' : ''} onClick={() => onChange('content')}>内容</button>
    </div>
  )
}

// Renders the content-search results. `onOpen(file, cwd)` opens the file in the preview.
export function ContentHits({ state, onOpen }: { state: SearchState; onOpen: (file: string, cwd: string) => void }) {
  if (state.loading) return <div className="content-hits empty">搜索中…</div>
  if (!state.ran) return <div className="content-hits empty">输入关键词搜索文件内容</div>
  if (!state.hits.length) return <div className="content-hits empty">无匹配内容</div>
  return (
    <div className="content-hits">
      {state.hits.map((h, i) => {
        const { file } = splitPath(h.file)
        return (
          <button
            key={h.cwd + h.file + ':' + h.line + ':' + i}
            className="content-hit"
            title={h.file}
            onClick={() => onOpen(h.file, h.cwd)}
          >
            <span className="ch-head">
              <FileIc name={file} />
              <span className="ch-file">{h.file}</span>
              <span className="ch-ln">:{h.line}</span>
            </span>
            <span className="ch-line">{h.preview}</span>
          </button>
        )
      })}
      {state.truncated ? <div className="content-hits empty">结果过多,仅显示前若干条</div> : null}
    </div>
  )
}
