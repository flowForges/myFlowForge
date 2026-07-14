import { readSystemMemory, writeSystemMemory, readWorkspaceMemory, writeWorkspaceMemory } from '../chat/memory/memoryStore'
import { getSession, setSessionSummary } from '../chat/sessionStore'

// The three memory tiers, addressed uniformly. `system` is global; `workspace` needs a wsPath;
// `session` needs wsPath + sessionId. Missing scope is a no-op (returns ''), never a throw — the
// renderer pane shows a hint instead of an editor when a scope isn't active.
export type MemoryLevel = 'system' | 'workspace' | 'session'
export interface MemoryArg { level: MemoryLevel; wsPath?: string; sessionId?: string; content?: string }

export function memoryRead(a: MemoryArg): string {
  if (a.level === 'system') return readSystemMemory()
  if (a.level === 'workspace') return a.wsPath ? readWorkspaceMemory(a.wsPath) : ''
  return (a.wsPath && a.sessionId) ? (getSession(a.wsPath, a.sessionId)?.summary ?? '') : ''
}

export function memoryWrite(a: MemoryArg): void {
  const c = a.content ?? ''
  if (a.level === 'system') writeSystemMemory(c)
  else if (a.level === 'workspace') { if (a.wsPath) writeWorkspaceMemory(a.wsPath, c) }
  else if (a.wsPath && a.sessionId) setSessionSummary(a.wsPath, a.sessionId, c)
}

export function memoryClear(a: MemoryArg): void {
  memoryWrite({ ...a, content: '' })
}
