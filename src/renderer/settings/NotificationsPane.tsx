import { useState } from 'react'
import type { Notifications, CloseAction, NotifyEvents } from '@shared/types'

// Split out of AppearancePane (was 外观和通知 combined) so 外观 is purely visual and 通知/窗口 behavior
// lives in its own pane. Same markup/handlers, just relocated.
interface NotificationsPaneProps {
  notifications: Notifications
  onNotificationsChange: (partial: Partial<Notifications>) => void
  /**
   * ★Q1:通知原本是一个对象塞了两件事,拆成两半。
   * `notifications` = 「**这台设备**收哪些」;`notifyEvents` = 「**那台机器**上哪些事件值得产生通知」。
   * 手机可能只想收「要我答门」的,电脑什么都想收 —— 那是设备偏好;
   * 而「这台机器上一轮跑完了算不算一件值得通知的事」只有那台机器知道。
   */
  notifyEvents: NotifyEvents
  onNotifyEventsChange: (partial: Partial<NotifyEvents>) => void
  /** 当前连着的主机名(本机时为 null),用来在标题里说清「哪台机器」。 */
  hostLabel?: string | null
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

// 「收起来」在两个平台是两件事:macOS 收进 Dock(图标永远在),Windows 收进托盘 —— 而托盘图标是关得掉的,
// 关着的时候只会最小化到任务栏(否则窗口就再也呼不出来了,见 closeBehavior.parkWindowInDock)。
const closeActions = (isWindows: boolean): { key: CloseAction; label: string }[] => [
  { key: 'ask', label: '询问' },
  { key: 'hide', label: isWindows ? '最小化到托盘' : '缩小到 Dock' },
  { key: 'quit', label: '退出应用' },
]

export function NotificationsPane({ notifications, onNotificationsChange, notifyEvents, onNotifyEventsChange, hostLabel, closeAction, onCloseActionChange, onTest }: NotificationsPaneProps) {
  const isWindows = (window.forge?.platform ?? 'darwin') === 'win32'
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
        <h4>这台设备收哪些 · 跟设备走</h4>
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
        <h4>哪些事件值得通知 · 跟机器走{hostLabel ? ` · ${hostLabel}` : ''}</h4>
        <p className="set-desc">
          上面那组管的是「**这台设备**要不要弹」;这一组管的是「**{hostLabel ?? '这台机器'}**上哪类事件
          值得产生一条通知」。关掉之后,连着这台机器的所有设备(包括以后的手机)都不会再收到该类通知。
        </p>
        {NOTIFY_TYPES.map(({ key, t, d }) => (
          <div className="set-row" key={`ev-${key}`}>
            <div className="info">
              <div className="t">{t}</div>
              <div className="d">{d}</div>
            </div>
            <button
              className={`toggle${notifyEvents[key] ? ' on' : ''}`}
              aria-label={`${t}(事件)`}
              onClick={() => onNotifyEventsChange({ [key]: !notifyEvents[key] })}
            />
          </div>
        ))}
      </div>
      <div className="set-group">
        <h4>窗口</h4>
        <div className="set-row">
          <div className="info">
            <div className="t">关闭窗口时</div>
            <div className="d">{isWindows
              ? '收起后应用继续在后台运行,点托盘图标回来;没开托盘图标时只会最小化到任务栏'
              : '缩小到 Dock 后应用继续在后台运行,可随时从 Dock 图标回来'}</div>
          </div>
          <div className="seg" id="closeAction">
            {closeActions(isWindows).map(({ key, label }) => (
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
