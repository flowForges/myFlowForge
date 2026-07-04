import type { EngineEvent } from '@shared/types'
import { shouldNotify, buildNotification, type NotifyCfg, type NotifyType, type BuiltNotification } from './notifier'

export interface NotifyBridgeDeps {
  getCfg: () => NotifyCfg
  isFocused: () => boolean
  notify: (n: BuiltNotification) => void
}

// Bridges the orchestrator event bus to OS notifications for confirm/input. `pending:add` carries
// the content but no workspacePath; `run:update` carries workspacePath + name, so we learn each
// workspace's path (by name) to route a pending notification on click, and dedupe pending ids.
// `done` notifications are NOT fired here — completion (chat reply OR workflow narration) surfaces as
// a chat `done` event, wired separately, so both paths use one signal without double-notifying.
export function createNotifyBridge(deps: NotifyBridgeDeps): (e: EngineEvent) => void {
  const wsPath = new Map<string, string>() // workspaceName → workspacePath
  const seen = new Set<string>()           // pending ids already notified

  function fire(type: NotifyType, workspaceName: string, workspacePath: string, text: string, sessionId?: string) {
    if (!shouldNotify(type, deps.getCfg(), deps.isFocused())) return
    deps.notify(buildNotification({ type, workspaceName, workspacePath, text, sessionId }))
  }

  return function onEvent(e: EngineEvent) {
    if (e.type === 'run:update') {
      if (e.run.workspaceName) wsPath.set(e.run.workspaceName, e.run.workspacePath)
    } else if (e.type === 'pending:add') {
      const a = e.action
      if (a.kind !== 'confirm' && a.kind !== 'input') return
      if (seen.has(a.id)) return
      seen.add(a.id)
      const text = a.sub ? `${a.title} — ${a.sub}` : a.title
      fire(a.kind, a.wsName, wsPath.get(a.wsName) ?? '', text)
    } else if (e.type === 'pending:resolve') {
      seen.delete(e.id)
    }
  }
}
