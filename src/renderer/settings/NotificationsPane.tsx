import { useState } from 'react'
import type { Notifications, CloseAction } from '@shared/types'

// Split out of AppearancePane (was 外观和通知 combined) so 外观 is purely visual and 通知/窗口 behavior
// lives in its own pane. Same markup/handlers, just relocated.
interface NotificationsPaneProps {
  notifications: Notifications
  onNotificationsChange: (partial: Partial<Notifications>) => void
  closeAction: CloseAction
  onCloseActionChange: (v: CloseAction) => void
  // Fires a native notification right now, bypassing the focus gate + per-type switches. Lets the user
  // tell "the OS isn't delivering at all" (permission/signing) from "real notifications only fire when
  // the app is in the background". Returns whether the OS reports notification support.
  onTest?: () => Promise<{ supported: boolean }>
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

export function NotificationsPane({ notifications, onNotificationsChange, closeAction, onCloseActionChange, onTest }: NotificationsPaneProps) {
  const [testMsg, setTestMsg] = useState<string>('')
  const runTest = async () => {
    if (!onTest) return
    setTestMsg('已发送,请查看系统通知中心…')
    try {
      const { supported } = await onTest()
      setTestMsg(supported
        ? '已发送。若没看到弹窗,请到 系统设置 › 通知 里为 myFlowForge 开启「允许通知」(未签名版本首次可能需要手动允许)。'
        : '当前系统报告不支持通知。')
    } catch {
      setTestMsg('发送失败。')
    }
  }
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
        <div className="set-row">
          <div className="info">
            <div className="t">发送测试通知</div>
            <div className="d">{testMsg || '立即发送一条测试通知,验证系统是否放行(此按钮不受前台判断和开关限制)'}</div>
          </div>
          <button className="wf-pick" aria-label="发送测试通知" onClick={runTest}>发送</button>
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
