import type { Notifications, CloseAction } from '@shared/types'

// Split out of AppearancePane (was 外观和通知 combined) so 外观 is purely visual and 通知/窗口 behavior
// lives in its own pane. Same markup/handlers, just relocated.
interface NotificationsPaneProps {
  notifications: Notifications
  onNotificationsChange: (partial: Partial<Notifications>) => void
  closeAction: CloseAction
  onCloseActionChange: (v: CloseAction) => void
}

const NOTIFY_TYPES: { key: 'confirm' | 'input' | 'done'; t: string; d: string }[] = [
  { key: 'confirm', t: '需要确认时', d: '子代理请求确认操作(如写文件、门控方案)' },
  { key: 'input', t: '需要输入时', d: '子代理请求补充输入' },
  { key: 'done', t: '执行完成时', d: '工作流整体执行完成' },
]

const CLOSE_ACTIONS: { key: CloseAction; label: string }[] = [
  { key: 'ask', label: '询问' },
  { key: 'hide', label: '缩小到 Dock' },
  { key: 'quit', label: '退出应用' },
]

export function NotificationsPane({ notifications, onNotificationsChange, closeAction, onCloseActionChange }: NotificationsPaneProps) {
  return (
    <>
      <div className="set-group">
        <h4>通知</h4>
        <div className="set-row">
          <div className="info">
            <div className="t">系统通知</div>
            <div className="d">需要确认/输入或执行完成时,若 App 不在前台则发送系统通知,点击可跳回对应会话</div>
          </div>
          <button
            className={`toggle${notifications.enabled ? ' on' : ''}`}
            aria-label="系统通知"
            onClick={() => onNotificationsChange({ enabled: !notifications.enabled })}
          />
        </div>
        {NOTIFY_TYPES.map(({ key, t, d }) => (
          <div className="set-row" key={key} style={{ opacity: notifications.enabled ? 1 : 0.45 }}>
            <div className="info">
              <div className="t">{t}</div>
              <div className="d">{d}</div>
            </div>
            <button
              className={`toggle${notifications[key] ? ' on' : ''}`}
              aria-label={t}
              disabled={!notifications.enabled}
              onClick={() => onNotificationsChange({ [key]: !notifications[key] })}
            />
          </div>
        ))}
      </div>
      <div className="set-group">
        <h4>窗口</h4>
        <div className="set-row">
          <div className="info">
            <div className="t">关闭窗口时</div>
            <div className="d">缩小到 Dock 后应用继续在后台运行,可随时从 Dock 图标回来</div>
          </div>
          <div className="seg" id="closeAction">
            {CLOSE_ACTIONS.map(({ key, label }) => (
              <button
                key={key}
                className={`wf-pick${closeAction === key ? ' on' : ''}`}
                onClick={() => onCloseActionChange(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
