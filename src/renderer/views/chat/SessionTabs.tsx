import './sessionTabs.css'
import { useState, useRef, useEffect } from 'react'
import type { ChatSession } from '@shared/types'
import { SessionIdsPanel } from './SessionIdsPanel'

const X = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M18 6 6 18M6 6l12 12" /></svg>
)

export interface SessionTabsProps {
  sessions: ChatSession[]
  activeSessionId: string | undefined
  onSwitch: (id: string) => void
  onClose: (id: string) => void
  onRename: (id: string, title: string) => void
  onNew: () => void
  workspacePath?: string
  archived?: boolean
  // #3: sessions whose (off-screen) workflow run is waiting on a permission gate — badge their tab so
  // the user knows to switch there, instead of the gate stealing the current tab.
  attentionIds?: ReadonlySet<string>
}

export function SessionTabs({ sessions, activeSessionId, onSwitch, onClose, onRename, onNew, workspacePath, archived, attentionIds }: SessionTabsProps) {
  const multi = sessions.length > 1
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [idsOpen, setIdsOpen] = useState(false)
  const idsWrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!idsOpen) return
    function onDoc(e: MouseEvent) {
      if (idsWrapRef.current && !idsWrapRef.current.contains(e.target as Node)) setIdsOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [idsOpen])
  const beginRename = (s: ChatSession) => {
    setEditingId(s.id)
    setDraftTitle(s.title)
  }
  const commitRename = (s: ChatSession) => {
    const next = draftTitle.replace(/\s+/g, ' ').trim()
    setEditingId(null)
    if (next && next !== s.title) onRename(s.id, next)
  }
  return (
    <>
      <div className="sess-bar">
        <div className="sess-tabs" id="sessTabs">
          {sessions.map(s => {
            const editing = editingId === s.id
            const isReadOnly = !!s.readonly
            return (
            <button
              key={s.id}
              className={'sess-tab' + (s.id === activeSessionId ? ' on' : '') + (isReadOnly ? ' si-ro' : '')}
              onClick={() => onSwitch(s.id)}
              onDoubleClick={e => { if (!isReadOnly) { e.stopPropagation(); beginRename(s) } }}
            >
              {isReadOnly && s.external && (
                <span className="si-src-badge" title={s.external.source}>{s.external.source.slice(0, 2).toUpperCase()}</span>
              )}
              <span className={'sd ' + s.mode} />
              {attentionIds?.has(s.id) && s.id !== activeSessionId && (
                <span className="sess-attn" title="该会话的工作流在等待你确认" />
              )}
              {editing ? (
                <input
                  className="st-edit"
                  value={draftTitle}
                  autoFocus
                  onClick={e => e.stopPropagation()}
                  onChange={e => setDraftTitle(e.target.value)}
                  onBlur={() => commitRename(s)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); commitRename(s) }
                    if (e.key === 'Escape') { e.preventDefault(); setEditingId(null) }
                  }}
                />
              ) : (
                <span className="st-name">{s.title}</span>
              )}
              {isReadOnly && <span className="si-ro-tag">只读</span>}
              {multi && (
                <span className="sx" title={isReadOnly ? '关闭(从列表移除此导入会话)' : '关闭会话'} onClick={e => { e.stopPropagation(); onClose(s.id) }}>{X}</span>
              )}
            </button>
          )})}
        </div>
        <div ref={idsWrapRef} className="sess-ids-wrap">
          <button className={'sess-ids-btn' + (idsOpen ? ' on' : '')} title="查看当前会话的 Agent Session ID" onClick={() => setIdsOpen(o => !o)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/></svg>
            IDs
          </button>
          {idsOpen && workspacePath && activeSessionId && (
            <SessionIdsPanel workspacePath={workspacePath} sessionId={activeSessionId} archived={!!archived} />
          )}
        </div>
        <button
          className={'sess-new' + (archived ? ' disabled' : '')}
          id="sessNew"
          title={archived ? '工作区已归档，无法新建会话' : '新建会话'}
          aria-disabled={archived || undefined}
          onClick={onNew}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        </button>
      </div>
    </>
  )
}
