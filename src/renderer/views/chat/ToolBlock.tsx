import { useState } from 'react'
import type { ToolActivity } from '@shared/types'

// The main agent's OWN tool calls this turn — the "执行" block. Shows each tool as a titled row (live
// while running, ✓/✗ on completion); the raw output is collapsed by default (click a row to expand) so
// the user can watch what the current CLI is executing and see the output without the log flooding the
// conversation. Not every provider streams tool output — rows without output just show the title/status.

function statusMark(s: ToolActivity['status']): string {
  return s === 'run' ? '' : s === 'error' ? '✗' : '✓'
}

function Row({ tool }: { tool: ToolActivity }) {
  const [open, setOpen] = useState(false)
  const hasOutput = !!tool.output
  return (
    <div className={`tool-row st-${tool.status}`}>
      <button className="tool-head" onClick={() => hasOutput && setOpen(o => !o)} aria-expanded={open} disabled={!hasOutput}>
        <span className={`tool-dot d-${tool.status}`} aria-hidden="true" />
        <span className="tool-title" title={tool.title}>{tool.title}</span>
        {tool.status !== 'run' && <span className={`tool-mark m-${tool.status}`} aria-hidden="true">{statusMark(tool.status)}</span>}
        {hasOutput && <span className={`tool-caret${open ? ' open' : ''}`} aria-hidden="true">▸</span>}
      </button>
      {open && hasOutput ? <pre className="tool-output">{tool.output}</pre> : null}
    </div>
  )
}

export function ToolBlock({ tools }: { tools: ToolActivity[] }) {
  if (!tools.length) return null
  const running = tools.filter(t => t.status === 'run').length
  return (
    <details className="tool-block" open>
      <summary className="tool-lead" title="当前代理这一轮自己执行的工具/命令(读文件、跑命令、改代码…)。标题实时显示,原始输出点开可展开。">
        <span className={`tool-lead-dot${running ? ' live' : ''}`} aria-hidden="true" />
        执行 · {running ? `${running} 进行中 / 共 ${tools.length} 步` : `${tools.length} 步`}
      </summary>
      <div className="tool-rows">
        {tools.map(t => <Row key={t.id} tool={t} />)}
      </div>
    </details>
  )
}
