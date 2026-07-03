import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { readWorkspace, unregisterWorkspace, readSettings, writeSettings } from '../config/store'
import { mirrorPath } from '../config/paths'
import { removeWorktree } from '../git/worktree'
import { removeImportedCwd } from '../sessionImport/importStore'

// List-only removal: drop the workspace from the app's list (registry + imported index + pins) but
// NEVER touch files on disk — no rmSync, no worktree removal. The folder, .forge state, and any
// worktrees stay exactly where they are; re-adding the directory restores it.
export function removeWorkspaceFromList(path: string): void {
  unregisterWorkspace(path)
  removeImportedCwd(path)
  const s = readSettings()
  if (s.pinnedWorkspaces.includes(path)) writeSettings({ ...s, pinnedWorkspaces: s.pinnedWorkspaces.filter(pp => pp !== path) })
}

export async function deleteWorkspace(path: string): Promise<{ purged: boolean }> {
  const ws = readWorkspace(path)
  let purged = false
  if (ws) {
    for (const p of ws.projects) {
      try { await removeWorktree({ mirror: mirrorPath(p.repoId), worktreePath: join(path, p.name) }) } catch { /* best-effort */ }
    }
    try { rmSync(path, { recursive: true, force: true }); purged = true } catch { /* leave registry cleanup to run */ }
  }
  unregisterWorkspace(path)
  removeImportedCwd(path)
  const s = readSettings()
  if (s.pinnedWorkspaces.includes(path)) writeSettings({ ...s, pinnedWorkspaces: s.pinnedWorkspaces.filter(pp => pp !== path) })
  return { purged }
}
