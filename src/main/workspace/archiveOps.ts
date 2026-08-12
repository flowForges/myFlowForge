import { setWorkspaceLifecycle, readSettings, writeSettings } from '../config/store'
import { readSessions } from '../chat/sessionStore'

const DEFAULT_SESSION_TITLE = '新会话'

/**
 * 归档坞里那行描述 = 最后一个**真聊过**的会话标题(会话标题本来就是首条用户消息的前 30 字)。
 *
 * 这里刻意【不】起 agent。原先是让一个一次性 CLI 去总结工作区生成这行字 —— 代价是:归档这个「封存」
 * 动作反而在被封存的目录里凭空拉起一个 claude 进程,外部的 agent 监控插件看得见、用户还收到通知
 * (而且 20s 超时后只是丢弃结果,进程没人 cancel,继续跑)。为一行描述值不回这个代价。
 *
 * 取不到就留空:界面本来就有回落(侧栏显示「已归档 · 只读」)。
 */
function archiveDescription(path: string): string {
  try {
    const { sessions } = readSessions(path)
    for (let i = sessions.length - 1; i >= 0; i--) {
      const t = (sessions[i].title ?? '').trim()
      if (t && t !== DEFAULT_SESSION_TITLE) return t.slice(0, 60)
    }
  } catch { /* 会话读不出来就留空,归档本身不该因此失败 */ }
  return ''
}

export function archiveWorkspaceLifecycle(path: string) {
  setWorkspaceLifecycle(path, { archived: true, archivedAt: Date.now(), description: archiveDescription(path) })
  const s = readSettings()
  if (s.pinnedWorkspaces.includes(path)) {
    writeSettings({ ...s, pinnedWorkspaces: s.pinnedWorkspaces.filter(p => p !== path) })
  }
}

export function restoreWorkspaceLifecycle(path: string) {
  setWorkspaceLifecycle(path, { archived: false, archivedAt: null })
}
