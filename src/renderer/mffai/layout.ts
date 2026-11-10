// 对话页布局的两条宽度线和「活动」面板的偏好(08b §4.4、R5)。不 import 任何东西:route.ts 冻结,偏好单独放这里。
// 偏好是全局的(不按会话),只有用户点「活动」或 › 时写;读不到、读到别的值、存储抛错都按展开。

export const ACTIVITY_KEY = 'mffai.activityPanel'
/** 主区宽于等于它,活动面板才可能停靠 */
export const PANEL_MIN_MAIN = 1280
/** 主区窄于它,会话列变窄 */
export const LIST_NARROW_BELOW = 1200

export type PanelPref = 'open' | 'closed'

const subs = new Set<(v: PanelPref) => void>()

function read(): PanelPref | undefined {
  try {
    const v = globalThis.localStorage?.getItem(ACTIVITY_KEY)
    return v === 'open' || v === 'closed' ? v : undefined
  } catch {
    return undefined
  }
}

export const activityPref = {
  get(): PanelPref {
    return read() ?? 'open'
  },
  set(v: PanelPref): void {
    // 存储不可写:订阅者照样收到,当前界面按用户的选择走
    try { globalThis.localStorage?.setItem(ACTIVITY_KEY, v) } catch { /* 忽略 */ }
    for (const cb of [...subs]) cb(v)
  },
  subscribe(cb: (v: PanelPref) => void): () => void {
    subs.add(cb)
    return () => { subs.delete(cb) }
  },
}
