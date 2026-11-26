import './sessionTabs.css'
import { useState, useRef, useEffect, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ChatSession, ContextUsage, HandoffTarget } from '@shared/types'
import { SessionIdsPanel } from './SessionIdsPanel'

const X = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M18 6 6 18M6 6l12 12" /></svg>
)

const OUT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
)
/** 「已复制会话 ID」chip 停留多久。 */
const COPIED_MS = 2000

interface HandoffMenuState { sessionId: string; x: number; y: number; items: HandoffTarget[] }

// 右键会话标签:「在 <App> 中继续」。只列主进程说能交接的(有绑定、darwin、App 装了);我方这一轮在途时灰掉。
function HandoffMenu({ menu, onPick, onClose }: { menu: HandoffMenuState; onPick: (t: HandoffTarget) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])
  return createPortal(
    <div ref={ref} className="ws-menu-pop sess-ho-pop" role="menu" style={{ left: menu.x, top: menu.y }}>
      {menu.items.map(t => (
        <button key={t.agent} className="ws-menu-item" role="menuitem" disabled={t.disabled} onClick={() => onPick(t)}>
          <span className="wm-ico">{OUT_ICON}</span>
          {`在 ${t.app} 中继续`}
        </button>
      ))}
    </div>,
    document.body,
  )
}

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
  // Session ids with an in-flight agent turn — pulses that tab's dot (mirrors the sidebar dot).
  runningIds?: ReadonlySet<string>
  // 各 provider 在这条会话里最近上报的上下文用量 —— 透给 IDs 面板,画在每个 provider 的主 Agent 行旁。
  usageByProvider?: Record<string, ContextUsage>
}

export function SessionTabs({ sessions, activeSessionId, onSwitch, onClose, onRename, onNew, workspacePath, archived, attentionIds, runningIds, usageByProvider }: SessionTabsProps) {
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
  const [handoffMenu, setHandoffMenu] = useState<HandoffMenuState | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }, [])
  const openHandoff = (e: ReactMouseEvent, s: ChatSession) => {
    if (archived || s.readonly || !workspacePath || !window.forge?.sessionHandoffTargets) return
    e.preventDefault()
    const { clientX: x, clientY: y } = e
    void window.forge.sessionHandoffTargets({ workspacePath, sessionId: s.id }).then(items => {
      setHandoffMenu(items?.length ? { sessionId: s.id, x, y, items } : null)
    }).catch(() => setHandoffMenu(null))
  }
  const pickHandoff = (t: HandoffTarget) => {
    const m = handoffMenu
    setHandoffMenu(null)
    if (!m || !workspacePath) return
    void window.forge.sessionHandoff({ workspacePath, sessionId: m.sessionId, agent: t.agent }).then(r => {
      if (!r?.ok) return
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS)
    }).catch(() => {})
  }
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
              onContextMenu={e => openHandoff(e, s)}
            >
              {isReadOnly && s.external && (
                <span className="si-src-badge" title={s.external.source}>{s.external.source.slice(0, 2).toUpperCase()}</span>
              )}
              <span className={'sd ' + s.mode + (runningIds?.has(s.id) ? ' run' : '')} />
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
        {copied && <span className="sess-chip" role="status">已复制会话 ID</span>}
        {handoffMenu && <HandoffMenu menu={handoffMenu} onPick={pickHandoff} onClose={() => setHandoffMenu(null)} />}
        <div ref={idsWrapRef} className="sess-ids-wrap">
          <button className={'sess-ids-btn' + (idsOpen ? ' on' : '')} title="查看当前会话的 Agent Session ID" onClick={() => setIdsOpen(o => !o)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/></svg>
            IDs
          </button>
          {idsOpen && workspacePath && activeSessionId && (
            <SessionIdsPanel workspacePath={workspacePath} sessionId={activeSessionId} archived={!!archived} usageByProvider={usageByProvider} />
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
