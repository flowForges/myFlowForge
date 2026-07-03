import type { RunState, PendingAction, WorkspaceMeta } from '@shared/types'

export interface PopupWorkspace {
  name: string; path: string; sub: string
  status: 'run' | 'ok' | 'idle'
  agents: string[]
  done: boolean
}
export interface PopupActiveAgent { name: string; role: string; stage: string }
export interface PopupData {
  statusText: string
  badge: { count: number; warn: boolean } | null
  pending: PendingAction[]
  workspaces: PopupWorkspace[]
  // The agents currently executing in the live run — surfaced so the pet popup shows WHAT is running,
  // not just a workspace selector + command box.
  activeAgents: PopupActiveAgent[]
}

const ORDER: Record<'run' | 'ok' | 'idle', number> = { run: 0, ok: 1, idle: 2 }
const dot = (s: WorkspaceMeta['status']): 'run' | 'ok' | 'idle' => (s === 'run' ? 'run' : s === 'ok' ? 'ok' : 'idle')

export function derivePopupData(run: RunState | null, pending: PendingAction[], workspaces: WorkspaceMeta[], busyWs?: Set<string>): PopupData {
  const activeAgents: PopupActiveAgent[] = run
    ? run.stages.flatMap(s => s.agents.filter(a => a.state === 'run').map(a => ({ name: a.name, role: a.role, stage: s.name })))
    : []
  const runningAgents = activeAgents.map(a => a.name)
  const running = runningAgents.length
  const badge = pending.length > 0
    ? { count: pending.length, warn: true }
    : running > 0
      ? { count: running, warn: false }
      : null
  const statusText = pending.length > 0
    ? `${pending.length} 项待处理 · ${running} 个代理在执行`
    : running > 0
      ? `看守 ${workspaces.length} 个工作区 · ${running} 个代理在执行`
      : `看守 ${workspaces.length} 个工作区 · 全部空闲`
  const ws: PopupWorkspace[] = workspaces.map(w => {
    const active = !!run && run.workspacePath === w.path
    const agents = active ? [...runningAgents] : []
    // Light the dot (run) when an agent is actually executing here: the whole orchestrator run (subagents
    // included, even in the gap between stages) OR a chat turn in flight (busyWs from the per-workspace
    // chat-queue busy flag). Matches the main-window sidebar exactly; not the persisted status, which lags.
    const isRunning = active && run!.status === 'run'
    const status = isRunning || (busyWs?.has(w.path) ?? false) ? 'run' : dot(w.status)
    return { name: w.name, path: w.path, sub: `${w.projectCount} 个项目 · ${w.workflowId}`, status, agents, done: status === 'ok' && agents.length === 0 }
  }).sort((a, b) => ORDER[a.status] - ORDER[b.status])
  return { statusText, badge, pending, workspaces: ws, activeAgents }
}
