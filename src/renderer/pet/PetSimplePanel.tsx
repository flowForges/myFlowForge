import type { Pet, PendingAction, ResolvePayload } from '@shared/types'
import type { SimpleKind } from './deriveSimpleKind'
import { PendingActionCard } from './PendingActionCard'

export interface RunningWorkspace { name: string; path: string }

interface PetSimplePanelProps {
  kind: SimpleKind
  // Which workspaces are currently executing — simpler + clearer than per-agent counts (a session
  // can have several agents). One row per running workspace; click a row to jump to it.
  runningWorkspaces: RunningWorkspace[]
  pending: PendingAction[]
  corner: Pet['corner']
  collapsed: boolean
  onToggleCollapse: () => void
  onResolve: (p: ResolvePayload) => void
  // Jump to the app, optionally to a specific workspace (a row) or the running one (「去 app 处理」).
  onJump: (path?: string) => void
}

const CHEVRON = (up: boolean) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {up ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
  </svg>
)
const CHECK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
  </svg>
)

// The light, collapsible codex-style bubble for the SIMPLE interaction mode. Shows running agents /
// a confirm-input request / a done ✓ — no dark popover, no workspace browser, no command box.
export function PetSimplePanel({ kind, runningWorkspaces, pending, corner, collapsed, onToggleCollapse, onResolve, onJump }: PetSimplePanelProps) {
  if (kind === 'idle') return null

  const title = kind === 'running' ? (runningWorkspaces.length > 0 ? `${runningWorkspaces.length} 个工作区在执行` : '执行中…')
    : kind === 'confirm' ? '需要确认'
      : kind === 'input' ? '需要输入'
        : '完成'

  return (
    <div className="pet-bubble-wrap" data-corner={corner}>
      <div className={`pet-simple${collapsed ? ' collapsed' : ''}`} data-kind={kind}>
        <div className="ps-head" onClick={collapsed ? onToggleCollapse : undefined}>
          {kind === 'done' && <span className="ps-check" aria-hidden="true">{CHECK}</span>}
          <span className="ps-title">{title}</span>
          <button
            className="ps-collapse"
            aria-label={collapsed ? '展开' : '折叠'}
            title={collapsed ? '展开' : '折叠'}
            onClick={e => { e.stopPropagation(); onToggleCollapse() }}
          >
            {CHEVRON(!collapsed)}
          </button>
        </div>

        {!collapsed && kind === 'running' && (
          <div className="ps-body">
            {runningWorkspaces.length === 0
              ? <div className="ps-empty">正在准备…</div>
              : runningWorkspaces.map((w, i) => (
                <button key={`${w.path}-${i}`} className="ps-agent" onClick={() => onJump(w.path)} title={`跳到 ${w.name}`}>
                  <span className="ps-dot" aria-hidden="true" />
                  <span className="ps-name">{w.name}</span>
                </button>
              ))}
          </div>
        )}

        {!collapsed && (kind === 'confirm' || kind === 'input') && (
          <div className="ps-body">
            {pending.map(p => <PendingActionCard key={p.id} action={p} onResolve={onResolve} />)}
            <button className="ps-jump" onClick={() => onJump()}>去 app 处理 →</button>
          </div>
        )}

        {!collapsed && kind === 'done' && (
          <div className="ps-body">
            <div className="ps-done">任务已完成</div>
          </div>
        )}
      </div>
    </div>
  )
}
