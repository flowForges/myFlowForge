import { useEffect, useState } from 'react'
import type { AgentContextMeta } from '@shared/types'
import { AgentContextMeta as AgentContextList } from '../components/AgentContextMeta'

interface LoadPaneProps {
  workspacePath?: string
}

const EMPTY: AgentContextMeta = { skills: [], rules: [], mcps: [] }

function count(context: AgentContextMeta): number {
  return context.skills.length + context.rules.length + (context.mcps?.length ?? 0)
}

export function LoadPane({ workspacePath }: LoadPaneProps) {
  const [context, setContext] = useState<AgentContextMeta>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scan = () => {
    setLoading(true)
    setError(null)
    window.forge.scanContext(workspacePath)
      .then((res: AgentContextMeta) => setContext({ ...EMPTY, ...res, mcps: res.mcps ?? [] }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => { scan() }, [workspacePath])

  return (
    <div className="set-group load-pane">
      <div className="load-head">
        <div>
          <h4>加载项扫描</h4>
          <p>{workspacePath ? '仅扫描当前工作区目录下的项目级加载项。' : '未选中工作区,展示可用运行加载项。'}</p>
        </div>
        <button className="set-btn" onClick={scan} disabled={loading}>{loading ? '扫描中' : '重新扫描'}</button>
      </div>
      <div className="load-summary">
        <span><b>{context.skills.length}</b> Skill</span>
        <span><b>{context.rules.length}</b> Rule</span>
        <span><b>{context.mcps?.length ?? 0}</b> MCP</span>
      </div>
      {error ? <div className="load-error">{error}</div> : null}
      {count(context) > 0 ? <AgentContextList context={context} /> : <div className="proj-empty">未发现 workspace 级加载项</div>}
    </div>
  )
}
