import type { PopupWorkspace } from './derivePopupData'

export function WorkspaceRow({ ws, onGo, selectable, selected, onSelect, sessionCount, onOpenPicker }: {
  ws: PopupWorkspace
  onGo: (path: string) => void
  selectable?: boolean
  selected?: boolean
  onSelect?: (path: string) => void
  sessionCount?: number
  onOpenPicker?: () => void
}) {
  const hasChips = ws.agents.length > 0 || ws.done
  const showScount = (sessionCount ?? 0) > 1
  // On the home view (selectable) clicking picks this workspace as the pet's command target and keeps the
  // popup open; otherwise it navigates the main window to the workspace (prototype behavior).
  return (
    <button className={`pp-ws${selected ? ' cur' : ''}`} data-go-ws={ws.path}
      aria-pressed={selectable ? !!selected : undefined}
      onClick={() => (selectable ? onSelect?.(ws.path) : onGo(ws.path))}>
      <span className={`pd ${ws.status}`} />
      <span className="pmeta">
        <span className="pn">{ws.name}</span>
        <span className="psub">{ws.sub}</span>
        {(hasChips || showScount) && (
          <span className="chips">
            {ws.agents.map(n => <span className="pp-chip" key={n}><span className="cd" />{n}</span>)}
            {ws.done && <span className="pp-chip done">已完成</span>}
            {showScount && (
              <span
                className="scount"
                role="button"
                tabIndex={0}
                onClick={e => { e.stopPropagation(); onOpenPicker?.() }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onOpenPicker?.() } }}
              >
                {sessionCount} 会话
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  )
}
