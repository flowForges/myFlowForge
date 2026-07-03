import { Fragment } from 'react'
import type { Plugin } from '@shared/plugin'

// Read-only render of a workspace's configured workflow: stage chips with the user's plugin
// hooks interleaved at the positions they run. Mirrors the create/edit wizard's flow strip so a
// custom workflow + its plugins are visibly accounted for ("did my plugin take effect?").

export interface WorkflowStripStage { key: string; name: string }

// Non-stage hook positions. The rest of a plugin's `after` is a stage key.
const POS_LABEL: Record<string, string> = {
  __start: '流程开始前',
  __basic: '基本信息后',
  __proj: '项目设置后',
  __wf: '流程结束后',
}
const PRE_POSITIONS = ['__start', '__basic', '__proj']

const PUZZLE = (
  <svg className="pz" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
    <path d="M10 3h4a1 1 0 0 1 1 1v2a2 2 0 1 0 4 0V4M21 10v4a1 1 0 0 1-1 1h-2a2 2 0 1 0 0 4M14 21h-4a1 1 0 0 1-1-1v-2a2 2 0 1 0-4 0v2M3 14v-4a1 1 0 0 1 1-1h2a2 2 0 1 0 0-4V4" />
  </svg>
)

function pluginTitle(p: Plugin, stageName: string | undefined): string {
  const pos = POS_LABEL[p.after] ?? (stageName ? `${stageName} 之后` : `${p.after} 之后`)
  const parts = [`${p.name} · 在「${pos}」运行`]
  if (p.skills.length) parts.push(`Skill: ${p.skills.join(', ')}`)
  if (p.tools.length) parts.push(`工具: ${p.tools.join(', ')}`)
  return parts.join(' · ')
}

function PlugChip({ p, stageName }: { p: Plugin; stageName?: string }) {
  return (
    <span className="ic-plug" title={pluginTitle(p, stageName)}>
      {PUZZLE}
      {p.name}
    </span>
  )
}

interface WorkflowStripProps {
  stages: WorkflowStripStage[]
  /** Combined workspace plugins + stepPlugins; positioned by each plugin's `after`. */
  plugins: Plugin[]
}

export function WorkflowStrip({ stages, plugins }: WorkflowStripProps) {
  const pre = plugins.filter(p => PRE_POSITIONS.includes(p.after))
  const post = plugins.filter(p => p.after === '__wf')
  const afterStage = (key: string) => plugins.filter(p => p.after === key)

  return (
    <div className="ic-stages">
      {pre.map(p => <PlugChip key={p.id} p={p} />)}
      {stages.map((s, i) => (
        <Fragment key={s.key}>
          <span className="ic-stage">{i > 0 ? <span className="ar">→</span> : null}{s.name}</span>
          {afterStage(s.key).map(p => <PlugChip key={p.id} p={p} stageName={s.name} />)}
        </Fragment>
      ))}
      {post.map(p => <PlugChip key={p.id} p={p} />)}
    </div>
  )
}
