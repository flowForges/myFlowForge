import { useState } from 'react'
import type { AgentState, ChatSession } from '@shared/types'
import { sessionBadge } from './sessionBadge'
import { reorder } from './reorder'
import { WsMenu, type WsMenuItem } from './WsMenu'
import './shell.css'

export interface WorkspaceItem {
  id: string
  name: string
  sub: string
  status: AgentState
  badge?: string
  pinned?: boolean
  live?: boolean          // an agent (chat or run) is executing here → force the dot to the run state
  lastActivity?: string   // relative "last conversation" label, e.g. 5 分钟前 / 昨天 / 6月1日
  imported?: boolean      // workspace was imported from a native tool session
  archived?: boolean
  archivedAt?: number | null
  createdAt?: number
}

export interface WorkspaceGroup {
  key: string
  label: string
  items: WorkspaceItem[]
}

export interface SidebarProps {
  groups: WorkspaceGroup[]
  archivedItems?: WorkspaceItem[]
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
  onPin?: (id: string, pinned: boolean) => void
  onArchive?: (id: string) => void
  onRestore?: (id: string) => void
  onDelete?: (id: string) => void
  onReveal?: (id: string) => void
  onRemove?: (id: string) => void
  onReorder?: (ids: string[]) => void
  collapsed: boolean
  width?: number
  sessions?: ChatSession[]
  activeSessionId?: string
  onSwitchSession?: (workspaceId: string, sessionId: string) => void
  onCloseSession?: (id: string) => void
  onRenameSession?: (id: string, title: string) => void
  onNewSession?: () => void
  // C2: expand state for multi-workspace session lists (C3 will render/toggle)
  expandedIds?: Set<string>
  sessionsByWs?: Record<string, ChatSession[]>
  onToggleExpand?: (id: string) => void
}

const GRIP_ICON = (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
)
const PIN_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><line x1="12" y1="17" x2="12" y2="22" /><path d="M5 17h14l-1.5-3V6a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v8z" /></svg>
)
const CHAT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" /></svg>
)
const X_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3"><path d="M18 6 6 18M6 6l12 12" /></svg>
)
const FOLDER_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h5l2 3h9a1 1 0 0 1 1 1v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /></svg>
)
const REMOVE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><line x1="8" y1="12" x2="16" y2="12" /></svg>
)
// 在系统文件管理器中打开 —— 文案随平台变化(Windows 没有 Finder)。
const REVEAL_LABEL = /Mac/i.test(navigator.userAgent) ? '在 Finder 中显示'
  : /Win/i.test(navigator.userAgent) ? '在资源管理器中显示'
  : '打开所在文件夹'
const PLUS_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
)
const IMPORT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
)
const ARCHIVE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 8v12H3V8" /><path d="M1 4h22v4H1z" /><path d="M9 12h6" /></svg>
)
const RESTORE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-15-6.7L3 13" /></svg>
)
const TRASH_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6M9 6V4h6v2" /></svg>
)

function avaStClass(status: AgentState): string {
  if (status === 'run') return 'st run'
  if (status === 'ok')  return 'st ok'
  return 'st idle'
}

function avaInitial(name: string): string {
  return name.charAt(0).toUpperCase()
}

interface GroupSectionProps {
  group: WorkspaceGroup
  activeId: string
  // When true, rows are drag-reorderable (independent of whether the section shows a header).
  draggable?: boolean
  // Hide the collapsible section header — the group renders as a plain flat list.
  hideHeader?: boolean
  onReorder?: (ids: string[]) => void
  onSelect: (id: string) => void
  onPin?: (id: string, pinned: boolean) => void
  onArchive?: (id: string) => void
  onRestore?: (id: string) => void
  onDelete?: (id: string) => void
  onReveal?: (id: string) => void
  onRemove?: (id: string) => void
  sessions?: ChatSession[]
  activeSessionId?: string
  onSwitchSession?: (workspaceId: string, sessionId: string) => void
  onCloseSession?: (id: string) => void
  onRenameSession?: (id: string, title: string) => void
  onNewSession?: () => void
  expandedIds?: Set<string>
  sessionsByWs?: Record<string, ChatSession[]>
  onToggleExpand?: (id: string) => void
}

function GroupSection({ group, activeId, draggable, hideHeader, onReorder, onSelect, onPin, onArchive, onRestore, onDelete, onReveal, onRemove, sessions = [], activeSessionId, onSwitchSession, onCloseSession, onRenameSession, onNewSession, expandedIds, sessionsByWs, onToggleExpand }: GroupSectionProps) {
  const [open, setOpen] = useState(true)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  // Drag-reorder state (only used when `draggable`): the row being dragged and the one hovered over.
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const dropOn = (targetId: string) => {
    if (dragId && dragId !== targetId) onReorder?.(reorder(group.items.map(i => i.id), dragId, targetId))
    setDragId(null)
    setOverId(null)
  }
  const beginRename = (s: ChatSession) => {
    setEditingSessionId(s.id)
    setDraftTitle(s.title)
  }
  const commitRename = (s: ChatSession) => {
    const next = draftTitle.replace(/\s+/g, ' ').trim()
    setEditingSessionId(null)
    if (next && next !== s.title) onRenameSession?.(s.id, next)
  }

  const collapsed = !hideHeader && !open
  return (
    <div className={`ws-group${collapsed ? ' closed' : ''}${draggable ? ' flat' : ''}`}>
      {!hideHeader && (
        <button className="ws-group-h" onClick={() => setOpen(o => !o)}>
          {/* chevron */}
          <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          {group.label}
          <span className="count">{group.items.length}</span>
        </button>
      )}
      <div className="ws-list">
        {group.items.map(item => {
          const isOn = item.id === activeId
          // An executing agent (chat or run) forces the run indicator on even when the persisted
          // workspace status lags behind ('idle'). Grouping still uses the raw status.
          const dotStatus: AgentState = item.live ? 'run' : item.status
          // Idle workspaces show NO marker at all; running ones get an animated left rail + 运行中
          // pill (the gray status dot is gone, per prototype).
          const running = dotStatus === 'run' && !item.archived
          return (
            <div key={item.id}>
              <button
                className={`ws-item${isOn ? ' on' : ''}${item.archived ? ' archived' : ''}${running ? ' is-running' : ''}${expandedIds?.has(item.id) ? ' expanded' : ''}${draggable && dragId === item.id ? ' dragging' : ''}${draggable && overId === item.id && dragId !== item.id ? ' drag-over' : ''}`}
                onClick={() => { onSelect(item.id); onToggleExpand?.(item.id) }}
                draggable={draggable || undefined}
                onDragStart={draggable ? e => { setDragId(item.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id) } : undefined}
                onDragOver={draggable ? e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overId !== item.id) setOverId(item.id) } : undefined}
                onDrop={draggable ? e => { e.preventDefault(); dropOn(item.id) } : undefined}
                onDragEnd={draggable ? () => { setDragId(null); setOverId(null) } : undefined}
              >
                {draggable && <span className="ws-grip" aria-hidden="true">{GRIP_ICON}</span>}
                {/* avatar initial (visible only in collapsed mode via CSS); its .st dot marks run state */}
                <span className="ws-ava">
                  {avaInitial(item.name)}
                  <i className={avaStClass(dotStatus)} />
                </span>
                {/* meta */}
                <span className="ws-meta">
                  <span className="ws-name">
                    <span className="ws-name-txt">{item.name}</span>
                    {item.imported && <span className="ws-imp-ico" title="本机导入的工作区">{IMPORT_ICON}</span>}
                    {running && <span className="ws-run-pill">运行中</span>}
                  </span>
                  <span className="ws-sub">{item.sub}</span>
                </span>
                <span className="ws-aside">
                  {item.lastActivity && <span className="ws-time" title="最后活动时间">{item.lastActivity}</span>}
                  {isOn && item.badge && <span className="ws-badge">{item.badge}</span>}
                  {!isOn && (sessionsByWs?.[item.id]?.length ?? 0) > 1 && <span className="ws-scount" title={`${sessionsByWs![item.id].length} 个会话`}>{CHAT_ICON}{sessionsByWs![item.id].length}</span>}
                </span>
                <span className="ws-actions">
                  {(() => {
                    // 收进「更多操作」下拉,替代原来一排容易误点的图标(图标+文字);归档/移除的确认弹层由上层负责。
                    const menu: WsMenuItem[] = []
                    if (onReveal) menu.push({ key: 'reveal', label: REVEAL_LABEL, icon: FOLDER_ICON, onClick: () => onReveal(item.id) })
                    if (!item.archived && onArchive) menu.push({ key: 'archive', label: '归档工作区', icon: ARCHIVE_ICON, onClick: () => onArchive(item.id) })
                    if (item.archived && onRestore) menu.push({ key: 'restore', label: '恢复工作区', icon: RESTORE_ICON, onClick: () => onRestore(item.id) })
                    if (!item.archived && onRemove) menu.push({ key: 'remove', label: '从列表移除(保留文件)', icon: REMOVE_ICON, onClick: () => onRemove(item.id) })
                    if (onDelete) menu.push({ key: 'delete', label: '永久删除(连同文件)', icon: TRASH_ICON, danger: true, onClick: () => onDelete(item.id) })
                    return menu.length ? <WsMenu items={menu} /> : null
                  })()}
                </span>
                {!item.archived && onPin && (
                  <span
                    className={`ws-pin${item.pinned ? ' on' : ''}`}
                    role="button"
                    title={item.pinned ? '取消置顶' : '置顶'}
                    aria-label={item.pinned ? '取消置顶' : '置顶'}
                    onClick={e => { e.stopPropagation(); onPin(item.id, !item.pinned) }}
                  >
                    {PIN_ICON}
                  </span>
                )}
              </button>
              {expandedIds?.has(item.id) && (sessionsByWs?.[item.id]?.length ?? 0) > 0 && (
                <div className="ws-sess-list">
                  {(() => {
                    const itemSessions = sessionsByWs![item.id]
                    const multi = itemSessions.length > 1
                    return itemSessions.map(s => {
                      const editing = editingSessionId === s.id
                      return (
                        <button
                          key={s.id}
                          className={`ws-sess${s.id === activeSessionId ? ' on' : ''}`}
                          title={s.title}
                          onClick={() => onSwitchSession?.(item.id, s.id)}
                          onDoubleClick={e => { e.stopPropagation(); beginRename(s) }}
                        >
                          <span className={'sd ' + s.mode} />
                          {editing ? (
                            <input
                              className="ws-sess-edit"
                              value={draftTitle}
                              autoFocus
                              onClick={e => e.stopPropagation()}
                              onChange={e => setDraftTitle(e.target.value)}
                              onBlur={() => commitRename(s)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { e.preventDefault(); commitRename(s) }
                                if (e.key === 'Escape') { e.preventDefault(); setEditingSessionId(null) }
                              }}
                            />
                          ) : (
                            <span className="ws-sess-name">{s.title}</span>
                          )}
                          {(() => { const b = sessionBadge(s); return b.kind !== 'new'
                            ? <span className={`ws-sess-badge ${b.kind}`}>{b.label}</span> : null })()}
                          {multi && (
                            <span
                              className="ws-sess-x"
                              title="关闭会话"
                              onClick={e => { e.stopPropagation(); onCloseSession?.(s.id) }}
                            >
                              {X_ICON}
                            </span>
                          )}
                        </button>
                      )
                    })
                  })()}
                  <button className="ws-sess-new" onClick={() => onNewSession?.()}>{PLUS_ICON}新建会话</button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface ArchiveDockProps {
  items: WorkspaceItem[]
  activeId: string
  onSelect: (id: string) => void
  onRestore?: (id: string) => void
  onDelete?: (id: string) => void
}

// Collapsible dock at the sidebar bottom. Idle by default — a faint icon + count that the user
// hovers/clicks to reveal the archived workspace list (keeps archives out of the way).
function ArchiveDock({ items, activeId, onSelect, onRestore, onDelete }: ArchiveDockProps) {
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  return (
    <div className={`ws-archive-dock${open ? ' open' : ''}`}>
      <div className="ws-archive-tray">
        <button
          className="ws-archive-toggle"
          aria-label="查看归档工作区"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          <span className="archive-icon">{ARCHIVE_ICON}</span>
          <span className="archive-label">归档工作区</span>
          <span className="count">{items.length}</span>
        </button>
        <div className="ws-archive-list">
          {open && items.map(item => (
            <button
              key={item.id}
              className={`ws-item archived${item.id === activeId ? ' on' : ''}`}
              onClick={() => onSelect(item.id)}
            >
              <span className="ws-meta">
                <span className="ws-name">
                  <span className="ws-name-txt">{item.name}</span>
                  {item.imported && <span className="ws-imp-ico" title="本机导入的工作区">{IMPORT_ICON}</span>}
                </span>
                <span className="ws-sub">{item.sub}</span>
              </span>
              <span className="ws-actions">
                {onRestore && (
                  <span className="ws-act" role="button" title="恢复工作区" onClick={e => { e.stopPropagation(); onRestore(item.id) }}>
                    {RESTORE_ICON}
                  </span>
                )}
                {onDelete && (
                  <span className="ws-act danger" role="button" title="永久删除" onClick={e => { e.stopPropagation(); onDelete(item.id) }}>
                    {TRASH_ICON}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function Sidebar({ groups, archivedItems = [], activeId, onSelect, onNew, onPin, onArchive, onRestore, onDelete, onReveal, onRemove, onReorder, collapsed, width, sessions, activeSessionId, onSwitchSession, onCloseSession, onRenameSession, onNewSession, expandedIds, sessionsByWs, onToggleExpand }: SidebarProps) {
  const sidebarStyle = (!collapsed && width !== undefined)
    ? { flex: `0 0 ${width}px`, width }
    : undefined
  return (
    <aside className="sidebar" style={sidebarStyle}>
      {/* Header */}
      <div className="sb-head">
        <h2>工作区</h2>
        <button className="sb-new" onClick={onNew} title="新建工作区" aria-label="新建工作区">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* Scrollable workspace list */}
      <div className="sb-scroll">
        {groups.map(group => (
          <GroupSection
            key={group.key}
            group={group}
            activeId={activeId}
            draggable={group.key === 'all'}
            // The flat list gets its own header only when a 置顶 group sits above it, so the two
            // sections read as distinct; with nothing pinned it stays a clean headerless list.
            hideHeader={group.key === 'all' && !groups.some(g => g.key === 'pinned')}
            onReorder={onReorder}
            onSelect={onSelect}
            onPin={onPin}
            onArchive={onArchive}
            onRestore={onRestore}
            onDelete={onDelete}
            onReveal={onReveal}
            onRemove={onRemove}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSwitchSession={onSwitchSession}
            onCloseSession={onCloseSession}
            onRenameSession={onRenameSession}
            onNewSession={onNewSession}
            expandedIds={expandedIds}
            sessionsByWs={sessionsByWs}
            onToggleExpand={onToggleExpand}
          />
        ))}
      </div>

      {!collapsed && (
        <ArchiveDock
          items={archivedItems}
          activeId={activeId}
          onSelect={onSelect}
          onRestore={onRestore}
          onDelete={onDelete}
        />
      )}
    </aside>
  )
}
