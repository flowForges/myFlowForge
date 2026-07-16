import { Notification } from 'electron'
import type { BuiltNotification } from './notifier'

// Retain live Notification instances until they close. On macOS a Notification that goes out of scope
// can be garbage-collected before the OS finishes presenting it, so the banner silently never appears
// (and its click never routes). Holding a reference until 'close'/'click' fires keeps it alive.
const live = new Set<Notification>()

// Thin glue: turn a BuiltNotification into a native OS notification and wire its click. All the
// decision logic (gating, content) lives in the pure notifier/notifyBridge modules.
export function showOsNotification(n: BuiltNotification, onClick: () => void): void {
  if (!Notification.isSupported()) return
  const notif = new Notification({ title: n.title, body: n.body })
  live.add(notif)
  const release = () => live.delete(notif)
  notif.on('click', () => { onClick(); release() })
  notif.on('close', release)
  notif.on('failed', release)
  notif.show()
}

// Whether the current OS/build can present native notifications at all. Surfaced to the settings pane's
// "发送测试通知" button so the user can tell a system-permission problem (unsigned build never granted
// notification permission → nothing shows) apart from the focus-gating (real notifications only fire
// when the app is in the background).
export function osNotificationsSupported(): boolean {
  return Notification.isSupported()
}
