import { useState } from 'react'
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
}

// Read-only right-panel "at a glance" list of a workspace's configured workflows: each expandable to
// its stages, each stage line showing name · provider · model — the one place all three are visible
// together without opening the run view or the edit wizard.
export function WorkflowGlance({ workflows }: WorkflowGlanceProps) {
  const [open, setOpen] = useState<string | null>(workflows[0]?.id ?? null)
  if (workflows.length === 0) return null
  return (
    <div className="ic-card wf-glance">
      <div className="ic-card-h">工作流</div>
      {workflows.map(wf => {
        const isOpen = open === wf.id
        return (
          <div className="wf-glance-item" key={wf.id}>
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
