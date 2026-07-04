import { Notification } from 'electron'
import type { BuiltNotification } from './notifier'

// Thin glue: turn a BuiltNotification into a native OS notification and wire its click. All the
// decision logic (gating, content) lives in the pure notifier/notifyBridge modules.
export function showOsNotification(n: BuiltNotification, onClick: () => void): void {
  if (!Notification.isSupported()) return
  const notif = new Notification({ title: n.title, body: n.body })
  notif.on('click', onClick)
  notif.show()
}
