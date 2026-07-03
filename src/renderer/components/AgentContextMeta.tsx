import type { AgentContextMeta as AgentContextMetaType } from '@shared/types'

interface Props {
  context?: AgentContextMetaType
  mini?: boolean
}

type Item = { name: string; path: string; reason?: string; state?: 'run' | 'ok' | 'wait' | 'err'; kind: 'skill' | 'rule' | 'mcp' }

function stateLabel(state: Item['state']): string {
  if (state === 'run') return '加载中'
  if (state === 'wait') return '待加载'
  if (state === 'err') return '失败'
  return '已加载'
}

function ContextItem({ item }: { item: Item }) {
  const state = item.state ?? 'ok'
  return (
    <div className={`ctx-item ${state}`}>
      <div className="ctx-top">
        <span className={`ctx-kind ${item.kind}`}>{item.kind === 'rule' ? 'Rule' : item.kind === 'mcp' ? 'MCP' : 'Skill'}</span>
        <span className="ctx-name" title={item.name}>{item.name}</span>
        <span className="ctx-state">{stateLabel(item.state)}</span>
      </div>
      {item.reason && <div className="ctx-reason">{item.reason}</div>}
      {item.path !== item.name && <div className="ctx-source" title={item.path}>{item.path}</div>}
    </div>
  )
}

export function AgentContextMeta({ context, mini = false }: Props) {
  if (!context || (!context.skills.length && !context.rules.length && !(context.mcps?.length))) return null
  const items: Item[] = [
    ...context.skills.map(item => ({ ...item, kind: 'skill' as const })),
    ...context.rules.map(item => ({ ...item, kind: 'rule' as const })),
    ...(context.mcps ?? []).map(item => ({ ...item, kind: 'mcp' as const })),
  ]
  return (
    <div className={mini ? 'ctx-mini' : 'ctx-stack'} aria-label="Agent context">
      {items.map(item => <ContextItem item={item} key={`${item.kind}:${item.path}`} />)}
    </div>
  )
}
