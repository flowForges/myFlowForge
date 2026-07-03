import { setWorkspaceLifecycle, readSettings, writeSettings } from '../config/store'

export function archiveWorkspaceLifecycle(path: string) {
  setWorkspaceLifecycle(path, { archived: true, archivedAt: Date.now(), description: '总结中…' })
  const s = readSettings()
  if (s.pinnedWorkspaces.includes(path)) {
    writeSettings({ ...s, pinnedWorkspaces: s.pinnedWorkspaces.filter(p => p !== path) })
  }
}

export function restoreWorkspaceLifecycle(path: string) {
  setWorkspaceLifecycle(path, { archived: false, archivedAt: null })
}
