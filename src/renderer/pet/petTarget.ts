import type { SessionsFile, ChatSession } from '@shared/types'

export interface PetTarget { wsPath: string; sessId: string }

/**
 * Resolve which workspace+session the pet should target.
 *
 * Priority:
 *   1. Explicit user selection (target) — if that ws+sess still exists.
 *   2. currentWsPath's active session.
 *   3. currentWsPath's first session.
 *   4. null ws/sess when the workspace has no data yet.
 */
export function petTgt(
  target: PetTarget | null,
  sessionsByWs: Record<string, SessionsFile>,
  currentWsPath: string
): { wsPath: string; ws: SessionsFile | null; sess: ChatSession | null } {
  // 1. Try explicit target
  if (target) {
    const ws = sessionsByWs[target.wsPath] ?? null
    if (ws) {
      const sess = ws.sessions.find(s => s.id === target.sessId) ?? null
      if (sess) return { wsPath: target.wsPath, ws, sess }
    }
  }

  // 2/3/4. Fall back to current workspace
  const ws = sessionsByWs[currentWsPath] ?? null
  if (!ws) return { wsPath: currentWsPath, ws: null, sess: null }

  const sess =
    ws.sessions.find(s => s.id === ws.activeSessionId) ??
    ws.sessions[0] ??
    null
  return { wsPath: currentWsPath, ws, sess }
}

/**
 * Return a display label for a session, appending " #k" when multiple sessions
 * share the same title (ported 1:1 from prototype sessLabel, line 6919-6926).
 */
export function sessLabel(sessions: ChatSession[], s: ChatSession): string {
  const same = sessions.filter(x => x.title === s.title)
  if (same.length < 2) return s.title
  let k = 0
  for (let i = 0; i < sessions.length; i++) {
    if (sessions[i].title === s.title) {
      k++
      if (sessions[i].id === s.id) break
    }
  }
  return `${s.title} #${k}`
}
