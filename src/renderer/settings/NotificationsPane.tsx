import { useEffect, useState } from 'react'
import type { Notifications, CloseAction, NotifyEvents, Settings } from '@shared/types'
import type { PushDevice } from '../../main/push/pushStore'

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
  /** 已经登记要收推送的手机。★这张表存在**当前连着的那台机器**上 —— 发推送的是它。 */
  const [devices, setDevices] = useState<PushDevice[] | null>(null)
  const [pushCfg, setPushCfg] = useState<Settings['push'] | null>(null)
  const [pushMsg, setPushMsg] = useState('')

  // 推送:设备表 + 那台机器上的开关。★两样都可能不存在(老 daemon / 老 preload),
  //  少一个 API 不该把整屏设置炸成白板 —— 安静地不显示就好。
  const loadPush = () => {
    if (typeof window.forge?.pushDevices !== 'function') return
    void window.forge.pushDevices().then(setDevices).catch(() => setDevices([]))
    void window.forge.getSettings().then((raw) => {
      const p = (raw as Settings | null)?.push
      if (p) setPushCfg(p)
    }).catch(() => {})
  }
  useEffect(loadPush, [])

  const savePush = async (next: Settings['push']) => {
    setPushCfg(next)
    const cur = (await window.forge.getSettings()) as Settings
    await window.forge.setSettings({ ...cur, push: next })
  }

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
      {/* ── 手机推送 ──────────────────────────────────────────────────────
          ★★2026-09-02 从**主机页**搬过来的。用户问「通知的设置,一定要放到那儿么?」——不该。
           这一页本来就是按「弹给谁」分的两组(跟设备走 / 跟机器走),而上面那组的说明
           **原文写着**「连着这台机器的所有设备(**包括以后的手机**)都不会再收到该类通知」——
           它早就把手机算进去了,而那三个开关却待在主机页。同一件事拆在两页,
           其中一页还在替另一页做承诺。这一组正好补上那条轴上缺的第三格。
          ★「已登记的手机」那张表跟着一起过来:它回答的是「推给谁」,和开关是同一件事。
           配对与否是另一回事(手机可以配对了但没开推送),那部分留在「手机」页。 */}
      {/* ── 推送 ────────────────────────────────────────────────────────────
          ★★手机端存在的意义有一半在这儿:**你不在电脑前,一道门升起来卡在那儿**。
           「能答门」早就做完了,「你怎么知道有门」一直是空的。
          ★★这块**不放在 `st.running` 里面**:推送和局域网网关开没开完全无关 ——
           走中转连进来的手机同样要收推送,而那种人的局域网网关多半是关着的。
          ★决策 7:这台机器直接 POST 给 Expo,不经中转、不用自建后端。
           代价是正文明文过 Expo/APNs,所以推送里**只有工作区名和一句固定的话**,
           一个字的对话内容都没有。 */}
      {pushCfg && (
        <div className="set-group">
          {/* ★这一组的标题补的是那条轴上缺的第三格:上面两组是「跟设备走」「跟机器走」,
              这一组是「**跟那台手机走**」。没有它的话,这几个开关会读成上一组的一部分
              (dump 出来就是这样发现的:一堆开关浮在两个标题之间,没人知道它们归谁)。 */}
          <h4>手机收哪些 · 跟那台手机走</h4>
          <div className="set-row">
            <div className="info">
              <div className="t">手机不在跟前时推送给它</div>
              <div className="d">
                门升起来 / 跑完时推到你手机上。<b>app 开着时不推</b>(那时它自己会弹)。
              </div>
            </div>
            <button
              className={`toggle${pushCfg.enabled ? ' on' : ''}`}
              aria-label="推送到手机"
              onClick={() => void savePush({ ...pushCfg, enabled: !pushCfg.enabled })}
            />
          </div>

          <div className="set-row" style={{ opacity: pushCfg.enabled ? 1 : 0.45 }}>
            <div className="info">
              <div className="t">需要你答的门</div>
              <div className="d">权限门、代理提问、工作流卡住 —— 没你就一直停在那儿的那些</div>
            </div>
            <button
              className={`toggle${pushCfg.gate ? ' on' : ''}`}
              aria-label="推送门"
              disabled={!pushCfg.enabled}
              onClick={() => void savePush({ ...pushCfg, gate: !pushCfg.gate })}
            />
          </div>

          <div className="set-row" style={{ opacity: pushCfg.enabled ? 1 : 0.45 }}>
            <div className="info">
              <div className="t">跑完了</div>
              <div className="d">默认关 —— 半夜被吵醒一次,这个功能就会被整个关掉</div>
            </div>
            <button
              className={`toggle${pushCfg.done ? ' on' : ''}`}
              aria-label="推送完成"
              disabled={!pushCfg.enabled}
              onClick={() => void savePush({ ...pushCfg, done: !pushCfg.done })}
            />
          </div>

          {/* ★设备表 = 「到底有没有手机真的登记上」的唯一证据。空表和「推送开着」并存
              是最容易被误读成"已经在用了"的状态,所以空态要**说下一步该做什么**。 */}
          <div className="hosts-conn">
            {devices && devices.length > 0 ? (
              <>
                <p className="set-desc">已经登记的手机:</p>
                {devices.map((d) => (
                  <div className="set-row" key={d.token}>
                    <div className="info">
                      <div className="t">{d.label || (d.platform === 'android' ? 'Android 手机' : 'iPhone')}</div>
                      <div className="d">
                        最近一次连上:{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '还没有'}
                      </div>
                    </div>
                    <button
                      className="set-btn danger"
                      onClick={() => void window.forge.pushUnregister(d.token).then(setDevices)}
                    >
                      不再推送
                    </button>
                  </div>
                ))}
              </>
            ) : (
              <p className="set-desc">
                还没有手机登记过推送。在手机上打开 <b>设置 → 提醒 → 有事就提醒我</b>,
                它会把自己登记到这台机器上。
              </p>
            )}

            <div className="hosts-conn-foot">
              <button
                className="set-btn"
                onClick={() => {
                  setPushMsg('发送中…')
                  void window.forge.pushTest()
                    .then((r) => setPushMsg(
                      r.sent > 0
                        ? `发出去 ${r.sent} 条。手机上没看到的话,多半是通知权限没给。`
                        : `一条都没发出去:${r.errors[0] ?? '不知道为什么'}`))
                    .catch((e: unknown) => setPushMsg(`发不出去:${e instanceof Error ? e.message : String(e)}`))
                    .finally(loadPush)
                }}
              >
                发一条测试推送
              </button>
              <button className="set-btn" onClick={loadPush}>刷新</button>
              {pushMsg && <span className="set-desc">{pushMsg}</span>}
            </div>

            {/* ★★远程推送到底能不能用,要看**你自己的** Expo/Apple 账号配没配 —— 我配不了。
                但这几段是「怎么配」而不是「现在什么状况」:状况在上面那条 hosts-live 里,
                这里收进折叠。★一个字都没删:没配通的时候,这三段就是唯一能照着做的东西。 */}
            <p className="set-desc">
              app <b>开着</b>时提醒照常有;<b>切走之后</b>要收到,得配一次 Expo 推送凭据。
            </p>
            <details className="hosts-adv">
              <summary>怎么配后台推送(要你自己的 Expo / Apple 账号)</summary>
              <p className="set-desc">
                ★先 <code>npx eas-cli init</code> 建一个 Expo 项目,再
                <code>npx eas-cli credentials</code> 传一次凭据。
                <b>安卓只要这两步</b>(传 FCM),和苹果账号无关。
              </p>
              <p className="set-desc">
                ★★<b>iOS 还要一个付费的 Apple Developer Program($99/年)</b> ——
                Push Notifications 是付费会员才有的能力,免费 Apple ID(描述文件 7 天过期的那种)
                开不了。齐了之后在 <code>mobile/app.json</code> 的 <code>extra</code> 里加
                <code>"iosPush": true</code>。
                ★<b>在这之前不要手动去动 entitlements</b>:没有那个能力却带着
                <code>aps-environment</code>,Release 包会直接签名失败。
              </p>
            </details>
          </div>
        </div>
      )}

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
