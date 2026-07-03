import type { Pet, PendingAction, ResolvePayload } from '@shared/types'
import type { PopupActiveAgent } from './derivePopupData'
import type { SimpleKind } from './deriveSimpleKind'
import { PendingActionCard } from './PendingActionCard'

interface PetSimplePanelProps {
  kind: SimpleKind
  agents: PopupActiveAgent[]
  pending: PendingAction[]
  corner: Pet['corner']
  collapsed: boolean
  onToggleCollapse: () => void
  onResolve: (p: ResolvePayload) => void
  // Jump to the app: an agent row / 「去 app 处理」 focuses the running workspace's main window.
  onJump: () => void
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
export function PetSimplePanel({ kind, agents, pending, corner, collapsed, onToggleCollapse, onResolve, onJump }: PetSimplePanelProps) {
  if (kind === 'idle') return null

  const title = kind === 'running' ? `${agents.length} 个代理在执行`
    : kind === 'confirm' ? '需要确认'
      : kind === 'input' ? '需要输入'
        : '完成'

  return (
    <div className="pet-bubble-wrap" data-corner={corner}>
      <div className={`pet-simple${collapsed ? ' collapsed' : ''}`} data-kind={kind}>
        <div className="ps-head">
          {kind === 'done' && <span className="ps-check" aria-hidden="true">{CHECK}</span>}
          <span className="ps-title">{title}</span>
          <button className="ps-collapse" aria-label={collapsed ? '展开' : '折叠'} title={collapsed ? '展开' : '折叠'} onClick={onToggleCollapse}>
            {CHEVRON(!collapsed)}
          </button>
        </div>

        {!collapsed && kind === 'running' && (
          <div className="ps-body">
            {agents.length === 0
              ? <div className="ps-empty">正在准备…</div>
              : agents.map((a, i) => (
                <button key={`${a.name}-${i}`} className="ps-agent" onClick={onJump} title={`跳到 ${a.name}`}>
                  <span className="ps-dot" aria-hidden="true" />
                  <span className="ps-name">{a.name}</span>
                  <span className="ps-stage">{a.stage || a.role}</span>
                </button>
              ))}
          </div>
        )}

        {!collapsed && (kind === 'confirm' || kind === 'input') && (
          <div className="ps-body">
            {pending.map(p => <PendingActionCard key={p.id} action={p} onResolve={onResolve} />)}
            <button className="ps-jump" onClick={onJump}>去 app 处理 →</button>
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
