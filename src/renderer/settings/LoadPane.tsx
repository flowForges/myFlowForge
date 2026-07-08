import { useEffect, useState } from 'react'
import type { AgentContextMeta } from '@shared/types'
import { AgentContextMeta as AgentContextList } from '../components/AgentContextMeta'

const EMPTY: AgentContextMeta = { skills: [], rules: [], mcps: [] }

function count(context: AgentContextMeta): number {
  return context.skills.length + context.rules.length + (context.mcps?.length ?? 0)
}

// System-level (user-scoped) add-ons — the global skills/rules/MCP shared by every workspace,
// across all supported CLIs (Claude / Codex / Gemini / Cursor / Qoder). Project-level add-ons
// live in the workspace's own right-side panel, not here.
export function LoadPane() {
  const [context, setContext] = useState<AgentContextMeta>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scan = () => {
    setLoading(true)
    setError(null)
    window.forge.scanGlobalContext()
      .then((res: AgentContextMeta) => setContext({ ...EMPTY, ...res, mcps: res.mcps ?? [] }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => { scan() }, [])

  return (
    <div className="set-group load-pane">
      <div className="load-head">
        <div>
          <h4>系统级加载项</h4>
          <p>扫描所有支持的编码 CLI（Claude / Codex / Gemini / Cursor / Qoder）的全局 skill、rule、MCP。项目级加载项在对应工作区右侧查看。</p>
        </div>
        <button className="set-btn" onClick={scan} disabled={loading}>{loading ? '扫描中' : '重新扫描'}</button>
      </div>
      <div className="load-summary">
        <span><b>{context.skills.length}</b> Skill</span>
        <span><b>{context.rules.length}</b> Rule</span>
        <span><b>{context.mcps?.length ?? 0}</b> MCP</span>
      </div>
      {error ? <div className="load-error">{error}</div> : null}
      {count(context) > 0 ? <AgentContextList context={context} /> : <div className="proj-empty">未发现系统级加载项</div>}
    </div>
  )
}
