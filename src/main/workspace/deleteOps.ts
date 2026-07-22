import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { readWorkspace, unregisterWorkspace, readSettings, writeSettings } from '../config/store'
import { mirrorPath, wsForgeDir } from '../config/paths'
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

// Discard a partial/abandoned creation (user picked 清除重来): tear down the provisioned worktrees and
// the .forge state (workspace.json etc.) + drop the registry entry, but LEAVE the parent folder itself
// (the user's chosen directory may hold their own files). After this, re-creating at the same path is a
// clean slate. Distinct from deleteWorkspace, which rmSync's the whole workspace folder.
export async function discardPartialCreation(path: string): Promise<void> {
  const ws = readWorkspace(path)
  if (ws) {
    for (const p of ws.projects) {
      // NEVER touch an in-place project's dir — it is the user's pre-existing repo, not a Forge mirror/worktree.
      if (p.inPlace) continue
      try { await removeWorktree({ mirror: mirrorPath(p.repoId), worktreePath: join(path, p.name) }) } catch { /* best-effort */ }
      try { rmSync(join(path, p.name), { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  }
  try { rmSync(wsForgeDir(path), { recursive: true, force: true }) } catch { /* best-effort */ }
  unregisterWorkspace(path)
  removeImportedCwd(path)
  const s = readSettings()
  if (s.pinnedWorkspaces.includes(path)) writeSettings({ ...s, pinnedWorkspaces: s.pinnedWorkspaces.filter(pp => pp !== path) })
}

export async function deleteWorkspace(path: string): Promise<{ purged: boolean }> {
  const ws = readWorkspace(path)
  let purged = false
  if (ws) {
    // If ANY project is in-place, `path` is the user's own folder-of-repos — we must never rmSync it.
    const hasInPlace = ws.projects.some(p => p.inPlace)
    for (const p of ws.projects) {
      // In-place projects have no Forge mirror/worktree to remove — skip them.
      if (p.inPlace) continue
      try { await removeWorktree({ mirror: mirrorPath(p.repoId), worktreePath: join(path, p.name) }) } catch { /* best-effort */ }
    }
    if (hasInPlace) {
      // Tear down only Forge's own footprint: cloned project dirs + .forge state. Leave the folder and
      // every in-place repo exactly where they are. `purged` stays false — the folder is not fully removed.
      for (const p of ws.projects) {
        if (p.inPlace) continue
        try { rmSync(join(path, p.name), { recursive: true, force: true }) } catch { /* best-effort */ }
      }
      try { rmSync(wsForgeDir(path), { recursive: true, force: true }) } catch { /* best-effort */ }
    } else {
      try { rmSync(path, { recursive: true, force: true }); purged = true } catch { /* leave registry cleanup to run */ }
    }
  }
  unregisterWorkspace(path)
  removeImportedCwd(path)
  const s = readSettings()
  if (s.pinnedWorkspaces.includes(path)) writeSettings({ ...s, pinnedWorkspaces: s.pinnedWorkspaces.filter(pp => pp !== path) })
  return { purged }
}
