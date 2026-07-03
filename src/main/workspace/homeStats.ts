import { statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readWorkspaceRegistry, readWorkspace } from '../config/store'
import { wsConfigFile } from '../config/paths'
import { sessionsDir } from '../chat/chatStore'
import { readChanges } from '../git/changes'
import type { HomeStats } from '@shared/types'

// Last-conversation timestamp = newest mtime among the workspace's session message files
// (<wsPath>/.forge/sessions/*.jsonl). appendMessage touches the file on every turn, so its mtime is a
// cheap, accurate proxy for "last activity" without parsing message bodies. 0 when there are no sessions.
function lastMessageMtime(wsPath: string): number {
  let latest = 0
  try {
    for (const f of readdirSync(sessionsDir(wsPath))) {
      if (!f.endsWith('.jsonl')) continue
      try { const m = statSync(join(sessionsDir(wsPath), f)).mtimeMs; if (m > latest) latest = m } catch { /* skip */ }
    }
  } catch { /* no sessions dir */ }
  return latest
}

// Enrich each registered workspace with the data the home view's focus card + list need but that
// listWorkspaces doesn't carry: the git branch, uncommitted change counts by kind (added / modified
// / deleted FILES, aggregated across the workspace's worktrees), and a last-activity timestamp
// (workspace.json mtime). Runs `git status` per worktree, so it's deliberately a separate async IPC
// fetched once when the home view mounts rather than baked into the cheap workspace list.
export async function readHomeStats(proxy = ''): Promise<HomeStats> {
  const out: HomeStats = {}
  await Promise.all(readWorkspaceRegistry().map(async ({ path }) => {
    const ws = readWorkspace(path)
    if (!ws) return
    // Worktree dir = <wsPath>/<project name || repoId> (same convention as workspaceToStartRunOpts).
    const cwds = ws.projects.map(p => join(path, p.name || p.repoId))
    const items = (await Promise.all(cwds.map(c => readChanges(c, proxy).catch(() => [])))).flat()
    const changes = {
      a: items.filter(i => i.type === 'A').length,
      e: items.filter(i => i.type === 'M').length,
      d: items.filter(i => i.type === 'D').length,
    }
    let updatedAt = 0
    try { updatedAt = statSync(wsConfigFile(path)).mtimeMs } catch { /* missing workspace.json */ }
    const branch = ws.projects.find(p => p.branch)?.branch || 'main'
    out[path] = { branch, changes, updatedAt, lastMessageAt: lastMessageMtime(path) }
  }))
  return out
}
