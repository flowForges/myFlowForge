import { statSync } from 'node:fs'
import { readWorkspaceRegistry, readWorkspace } from '../config/store'
import { readIndex } from '../sessionImport/importStore'
import { wsConfigFile } from '../config/paths'
import type { WorkspaceMeta } from '@shared/types'
import type { WorkspaceRegistryEntry } from '../config/schema'

function createdAtOf(entry: WorkspaceRegistryEntry, wsPath: string): number {
  if (entry.createdAt) return entry.createdAt
  try { return Math.round(statSync(wsConfigFile(wsPath)).mtimeMs) } catch { return 0 }
}

export function listWorkspaces(liveRunPath?: string, pinnedPaths: string[] = [], orderPaths: string[] = []): WorkspaceMeta[] {
  const pinnedRank = new Map(pinnedPaths.map((p, i) => [p, i]))
  const orderRank = new Map(orderPaths.map((p, i) => [p, i]))
  const importedPaths = new Set(readIndex().sessions.map(s => s.cwd))
  const out: WorkspaceMeta[] = []
  for (const entry of readWorkspaceRegistry()) {
    const ws = readWorkspace(entry.path)
    if (!ws) {
      // Registered but no workspace.json: a lightweight imported workspace IFF it appears in the
      // imported-sessions index. A genuinely deleted workspace (not imported) is still skipped.
      if (importedPaths.has(entry.path)) {
        out.push({ name: entry.name, path: entry.path, projectCount: 0, workflowId: '', status: 'idle', pinned: pinnedRank.has(entry.path), imported: true,
          archived: entry.archived, archivedAt: entry.archivedAt, createdAt: createdAtOf(entry, entry.path), description: entry.description })
      }
      continue
    }
    const status: WorkspaceMeta['status'] =
      ws.status === 'run' && ws.path !== liveRunPath ? 'err' : ws.status
    out.push({ name: ws.name, path: ws.path, projectCount: ws.projects.length, workflowId: ws.workflowId, status, pinned: pinnedRank.has(ws.path),
      archived: entry.archived, archivedAt: entry.archivedAt, createdAt: createdAtOf(entry, ws.path), description: entry.description })
  }
  // Pinned workspaces first, in pin order. Non-pinned follow the user's manual drag order
  // (workspaceOrder); any not in that list keep registry order after the ordered ones.
  return out.sort((a, b) => {
    const ra = pinnedRank.has(a.path) ? pinnedRank.get(a.path)! : Infinity
    const rb = pinnedRank.has(b.path) ? pinnedRank.get(b.path)! : Infinity
    if (ra !== rb) return ra - rb
    const oa = orderRank.has(a.path) ? orderRank.get(a.path)! : Infinity
    const ob = orderRank.has(b.path) ? orderRank.get(b.path)! : Infinity
    return oa - ob
  })
}
