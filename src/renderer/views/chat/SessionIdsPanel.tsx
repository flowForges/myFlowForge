import { useCallback, useEffect, useState } from 'react'
import type { AgentSessionInfo, ChatQueueEvent } from '@shared/types'

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
  const [refreshing, setRefreshing] = useState(false)

  // Manual refresh: the panel otherwise fetches ONLY on open / session switch (the mount effect below),
  // so a session id captured after opening wouldn't appear. The 刷新 button re-pulls on demand without
  // nulling `rows` first, so the list updates in place instead of flickering to empty.
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      // agentSessionIds is a near-instant local read, so the spin would flash for a few ms and be
      // invisible. Race it against a 600ms floor so the icon visibly completes a turn (matches the
      // file-tree 刷新 feel) — the user needs to see the refresh was acknowledged.
      const [r] = await Promise.all([
        window.forge.agentSessionIds(workspacePath, sessionId),
        new Promise<void>(res => setTimeout(res, 600)),
      ])
      setRows(r)
    } finally {
      setRefreshing(false)
    }
  }, [workspacePath, sessionId])

  useEffect(() => {
    let live = true
    void window.forge.agentSessionIds(workspacePath, sessionId).then((r: AgentSessionInfo[]) => {
      if (live) setRows(r)
    })
    return () => {
      live = false
    }
  }, [workspacePath, sessionId])

  // Live status: the snapshot above can't tell 运行中 from 已完成 on its own (the main-Agent row's
  // liveness is only known to the ChatQueue in the main process). Re-pull whenever this workspace's
  // queue changes — a turn starting flips the active provider's row to 运行中, ending flips it back —
  // so the panel reflects real liveness without the user hitting 刷新.
  useEffect(() => {
    let live = true
    const off = window.forge.onChatQueueEvent?.((e: ChatQueueEvent) => {
      if (!live || e.workspacePath !== workspacePath) return
      void window.forge.agentSessionIds(workspacePath, sessionId).then((r: AgentSessionInfo[]) => {
        if (live) setRows(r)
      })
    })
    return () => {
      live = false
      off?.()
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
        <div className="sid-head-actions">
          <button
            className="sid-refresh"
            onClick={() => void refresh()}
            disabled={refreshing}
            title="刷新"
            aria-label="刷新"
          >
            <svg className={refreshing ? 'spin' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
          {rows.length > 0 && (
            <Copy
              text={rows.map(r => `${r.agentName} (${r.providerLabel}): ${r.sessionId}`).join('\n')}
              label="复制全部"
            />
          )}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="sid-empty">当前会话还没有外部 Agent session。</div>
      ) : (
        <div className="sid-list">
          {rows.map((r, i) => (
            <div className={`sid-card${r.depth ? ' sid-card-child' : ''}${r.depth === 2 ? ' sid-card-grand' : ''}${!archived && r.status === 'run' ? ' sid-card-run' : ''}`} key={i}>
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
