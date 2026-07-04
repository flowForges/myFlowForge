// Pure core for native OS notifications: gating (when to fire) + content assembly. The Electron
// Notification call, window-focus read, and click routing are thin glue around these functions.

export type NotifyType = 'confirm' | 'input' | 'done'

export interface NotifyCfg {
  enabled: boolean // master switch
  confirm: boolean
  input: boolean
  done: boolean
}

// Fire only when the user is NOT already looking at the app, the master switch is on, and the
// per-type switch is on.
export function shouldNotify(type: NotifyType, cfg: NotifyCfg, focused: boolean): boolean {
  if (focused) return false
  if (!cfg.enabled) return false
  return cfg[type]
}

export interface NotifyEvent {
  type: NotifyType
  workspaceName: string
  workspacePath: string
  sessionId?: string
  text: string // the pending question / input prompt / run summary
}

export interface NotifyRoute {
  workspacePath: string
  sessionId?: string
}

export interface BuiltNotification {
  title: string
  body: string
  route: NotifyRoute
}

const LABEL: Record<NotifyType, string> = { confirm: '需要确认', input: '需要输入', done: '执行完成' }
const FALLBACK: Record<NotifyType, string> = { confirm: '有一项待确认', input: '有一项待输入', done: '任务已执行完成' }
const MAX_BODY = 180

function cleanBody(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > MAX_BODY ? t.slice(0, MAX_BODY) + '…' : t
}

export function buildNotification(e: NotifyEvent): BuiltNotification {
  const label = LABEL[e.type]
  const title = e.workspaceName ? `${e.workspaceName} · ${label}` : label
  const body = cleanBody(e.text) || FALLBACK[e.type]
  return { title, body, route: { workspacePath: e.workspacePath, sessionId: e.sessionId } }
}
