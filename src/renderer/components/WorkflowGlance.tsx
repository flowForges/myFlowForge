import { useEffect, useRef, useState } from 'react'
import type { WsWorkflow } from '@shared/types'

// Stage key → display name fallback for built-in stages. Mirrors src/main/config/schema.ts
// STAGE_NAMES / stageName() (renderer can't import the main-only module) and the local copy already
// kept in sync in src/renderer/views/WorkspaceView.tsx. A custom stage's own `name` always wins.
const BUILTIN_STAGE_NAMES: Record<string, string> = {
  requirement: '需求评估', design: '技术方案设计', develop: '代码开发', test: '写单测', review: '代码 CR',
}

/** Read-only display name for a stage: custom `name` wins, else the built-in fallback, else the key. */
export function stageDisplayName(key: string, name?: string): string {
  return (name && name.trim()) || BUILTIN_STAGE_NAMES[key] || key
}

interface WorkflowGlanceProps {
  workflows: WsWorkflow[]
  // When provided, the section header shows an 编辑 button (opens the workspace's workflow config).
  onEdit?: () => void
  // When provided, each workflow row shows a 启动 button → launches THAT workflow (opens the launch
  // gate). This is what lets the user pick any workflow to run from the panel, instead of the old
  // hardcoded "当前工作流" (which was just workflows[0] and couldn't be switched).
  onLaunch?: (id: string) => void
  archived?: boolean
}

const EDIT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
)
const PLAY_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" /></svg>
)

// The workspace's configured workflows, unified into one right-panel section (replaces the old
// "当前工作流" card + separate list, which duplicated workflows[0] and mislabeled it as "current" —
// there is no single current workflow; the user picks which to run each time). Each row expands to its
// stages (name · provider · model); a 启动 button launches that specific workflow; the header 编辑
// button opens the config wizard.
export function WorkflowGlance({ workflows, onEdit, onLaunch, archived }: WorkflowGlanceProps) {
  const [open, setOpen] = useState<string | null>(workflows[0]?.id ?? null)
  // Auto-expand the first workflow ONCE it exists. WorkspaceView feeds `workflows` async (after the
  // getWorkspace round-trip), so the useState initializer above runs while the list is still empty —
  // without this, the first workflow would never auto-open. The ref guards it to a single auto-open so
  // the user can still collapse the first row afterwards.
  const autoOpened = useRef(open != null)
  useEffect(() => {
    if (!autoOpened.current && workflows[0]) { autoOpened.current = true; setOpen(workflows[0].id) }
  }, [workflows])
  // Keep the pure read-only usage (no actions) collapsing to nothing when empty — but once it's the
  // actionable panel (onEdit present), show the header + an empty hint so the user can add workflows.
  if (workflows.length === 0 && !onEdit) return null
  return (
    <div className="ic-card wf-glance">
      <div className="ic-card-h">
        工作流
        {onEdit && (
          <button type="button" className="wf-edit-btn" disabled={archived} onClick={onEdit} title="编辑工作流">
            {EDIT_ICON}编辑
          </button>
        )}
      </div>
      {workflows.length === 0 ? (
        <div className="wf-glance-empty">还没有配置工作流。点「编辑」添加执行阶段。</div>
      ) : workflows.map(wf => {
        const isOpen = open === wf.id
        return (
          <div className="wf-glance-item" key={wf.id}>
            <div className="wf-glance-row">
              <button
                type="button"
                className="wf-glance-head"
                aria-expanded={isOpen}
                onClick={() => setOpen(o => o === wf.id ? null : wf.id)}
              >
                <span className={'wf-glance-caret' + (isOpen ? ' open' : '')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M9 6l6 6-6 6" /></svg>
                </span>
                <span className="wf-glance-name">{wf.name}</span>
                <span className="wf-glance-count">{wf.stages.length} 阶段</span>
              </button>
              {onLaunch && (
                <button type="button" className="wf-launch-btn" disabled={archived} onClick={() => onLaunch(wf.id)} title={`启动「${wf.name}」`}>
                  {PLAY_ICON}启动
                </button>
              )}
            </div>
            {isOpen && (
              <ul className="wf-glance-stages">
                {wf.stages.map(s => (
                  <li key={s.key}>
                    <span className="wf-stage-name">{stageDisplayName(s.key, s.name)}</span>
                    <span className="wf-stage-agent">{s.provider} · {s.model}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
