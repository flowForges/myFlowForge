import type { CloseAction } from '../config/schema'

type DockableWindow = {
  hide: () => void
  minimize: () => void
  isMinimizable?: () => boolean
}

export type DockActivationAction = 'create' | 'minimize' | 'restore' | 'show'

export interface DockActivationState {
  platform: NodeJS.Platform
  hasWindow: boolean
  destroyed: boolean
  minimized: boolean
  visible: boolean
  focused: boolean
}

// 关闭主窗口时该做什么(纯函数,便于单测):
//  - 'pass' → 放行默认 close(既有 closed→app.quit 收尾)
//  - 'hide' → preventDefault + win.hide()(缩小到 Dock,应用后台运行)
//  - 'ask'  → preventDefault + 弹询问对话框
// quitting(before-quit 已触发,例如 Cmd+Q / 菜单退出 / 对话框选「退出应用」后的 app.quit())
// 时恒放行,否则 hide 设置会把真正的退出也拦下来导致永远退不掉。
// 垃圾/缺省设置值保守回落 'ask'(schema .catch 已兜,双保险)。
export function resolveCloseAction(setting: CloseAction | string | undefined, quitting: boolean): 'pass' | 'hide' | 'ask' {
  if (quitting) return 'pass'
  if (setting === 'hide') return 'hide'
  if (setting === 'quit') return 'pass'
  return 'ask'
}

/**
 * 「关闭窗口 = 收起来继续后台跑」时,窗口该往哪儿收。
 *
 * macOS:收进 Dock(minimize),Dock 图标永远在,随时点回来。
 * Windows:收进托盘(hide)—— 但 hide 会让窗口从任务栏也消失,**托盘图标是唯一的回来的路**。
 *   所以托盘关着的时候只许 minimize:再 hide 就等于把 app 弄丢了,用户只能去任务管理器杀进程。
 */
export function parkWindowInDock(
  win: DockableWindow,
  platform: NodeJS.Platform = process.platform,
  hasTray = false,
): void {
  const canMinimize = win.isMinimizable?.() ?? true
  if (platform === 'darwin') {
    if (canMinimize) { win.minimize(); return }
    win.hide()
    return
  }
  if (platform === 'win32' && !hasTray && canMinimize) { win.minimize(); return }
  win.hide()
}

export function resolveDockActivationAction(s: DockActivationState): DockActivationAction {
  if (!s.hasWindow || s.destroyed) return 'create'
  if (s.platform === 'darwin' && s.visible && s.focused && !s.minimized) return 'minimize'
  if (s.minimized) return 'restore'
  return 'show'
}
