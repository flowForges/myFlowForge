import { useEffect, useState } from 'react'
import type { AgentSessionInfo } from '@shared/types'

function Copy({ text, label = '复制' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={`sid-copy${done ? ' done' : ''}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1300)
      }}
    >
      {done ? '已复制' : label}
    </button>
  )
}

export function SessionIdsPanel({
  workspacePath,
  sessionId,
  archived,
}: {
  workspacePath: string
  sessionId: string
  archived: boolean
}) {
  const [rows, setRows] = useState<AgentSessionInfo[] | null>(null)

  useEffect(() => {
    let live = true
    void window.forge.agentSessionIds(workspacePath, sessionId).then((r: AgentSessionInfo[]) => {
      if (live) setRows(r)
    })
    return () => {
      live = false
    }
  }, [workspacePath, sessionId])

  if (!rows) return null

  return (
    <div className="session-id-panel on" aria-label="Agent Session IDs">
      <div className="sid-head">
        <div>
          <div className="sid-title">Agent Session IDs</div>
          <div className="sid-sub">{archived ? '已归档只读' : '用于排查外部 CLI 会话'}</div>
        </div>
        {rows.length > 0 && (
          <Copy
            text={rows.map(r => `${r.agentName} (${r.providerLabel}): ${r.sessionId}`).join('\n')}
            label="复制全部"
          />
        )}
      </div>
      {rows.length === 0 ? (
        <div className="sid-empty">当前会话还没有外部 Agent session。</div>
      ) : (
        <div className="sid-list">
          {rows.map((r, i) => (
            <div className="sid-card" key={i}>
              <div className="sid-top">
                <span className={`sid-provider ${r.provider}`} />
                <div className="sid-main">
                  <div className="sid-agent">{r.agentName}</div>
                  <div className="sid-meta">
                    {r.providerLabel}
                    {r.role ? ` · ${r.role}` : ''} · {r.lastActiveAt}
                  </div>
                </div>
                <span className={`sid-state ${archived ? 'archived' : r.status}`}>
                  {archived
                    ? '已归档'
                    : r.status === 'run'
                    ? '运行中'
                    : r.status === 'ok'
                    ? '已完成'
                    : '记录'}
                </span>
              </div>
              <div className="sid-code">
                <code title={r.sessionId}>{r.sessionId}</code>
                <Copy text={r.sessionId} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
