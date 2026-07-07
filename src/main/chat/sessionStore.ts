import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatSession, SessionsFile, ChatMessage, SourceId } from '@shared/types'
import { wsForgeDir } from '../config/paths'
import { sessionsDir, sessionMessagesFile } from './chatStore'
import { deriveImportedSessions } from './importedSessions'

function sessionsFile(wsPath: string) { return join(wsForgeDir(wsPath), 'sessions.json') }
function ensureDir(d: string) { if (!existsSync(d)) mkdirSync(d, { recursive: true }) }

let seq = 0
function mkId() { return `s-${Date.now()}-${++seq}` }
function mkSession(title = '新会话'): ChatSession { return { id: mkId(), title, mode: 'chat', createdAt: Date.now() } }
function titleFrom(text: string) { const t = text.replace(/\s+/g, ' ').trim(); return t.length > 16 ? t.slice(0, 16) + '…' : (t || '历史会话') }

function write(wsPath: string, data: SessionsFile): SessionsFile {
  ensureDir(wsForgeDir(wsPath))
  const persisted = { ...data, sessions: data.sessions.filter(s => !s.readonly) }
  writeFileSync(sessionsFile(wsPath), JSON.stringify(persisted, null, 2))
  return data
}

// Lazily migrates a pre-multi-session workspace: legacy .forge/chat.jsonl becomes a single
// default session (title from its first user message), chat-session.json is nested under it.
function migrate(wsPath: string): SessionsFile {
  const legacy = join(wsForgeDir(wsPath), 'chat.jsonl')
  if (existsSync(legacy)) {
    let firstUser = ''
    for (const line of readFileSync(legacy, 'utf8').split('\n').filter(Boolean)) {
      try { const m = JSON.parse(line) as ChatMessage; if (m.who === 'user') { firstUser = m.text; break } } catch { /* skip */ }
    }
    const s = mkSession(titleFrom(firstUser))
    ensureDir(sessionsDir(wsPath))
    renameSync(legacy, sessionMessagesFile(wsPath, s.id))
    const resumeF = join(wsForgeDir(wsPath), 'chat-session.json')
    if (existsSync(resumeF)) {
      try {
        const old = JSON.parse(readFileSync(resumeF, 'utf8')) as Record<string, string>
        writeFileSync(resumeF, JSON.stringify({ [s.id]: old }, null, 2))
      } catch { /* leave as-is */ }
    }
    return write(wsPath, { sessions: [s], activeSessionId: s.id })
  }
  const s = mkSession()
  return write(wsPath, { sessions: [s], activeSessionId: s.id })
}

export function readSessions(wsPath: string, deps: { derive?: (cwd: string) => ChatSession[] } = {}): SessionsFile {
  const derive = deps.derive ?? deriveImportedSessions
  const f = sessionsFile(wsPath)
  let persisted: SessionsFile | null = null
  if (existsSync(f)) {
    try { persisted = JSON.parse(readFileSync(f, 'utf8')) as SessionsFile } catch { /* fall through */ }
  }
  // Imported (read-only) sessions are derived, not persisted. A dismissed (closed) one is remembered
  // via dismissedImported so it doesn't keep re-appearing in the tab bar.
  const dismissed = new Set(persisted?.dismissedImported ?? [])
  const imported = derive(wsPath).filter(s => !dismissed.has(s.id))
  if (persisted?.sessions?.length) {
    const ids = new Set(persisted.sessions.map(s => s.id))
    const extras = imported.filter(s => !ids.has(s.id))
    return { ...persisted, sessions: [...persisted.sessions, ...extras] }
  }
  if (imported.length) return { sessions: imported, activeSessionId: imported[0].id, dismissedImported: [...dismissed] }
  return migrate(wsPath)
}

export function newSession(wsPath: string, title?: string): SessionsFile {
  const data = readSessions(wsPath)
  const s = mkSession(title)
  data.sessions.push(s)
  data.activeSessionId = s.id
  return write(wsPath, data)
}

export function switchSession(wsPath: string, sessionId: string): SessionsFile {
  const data = readSessions(wsPath)
  if (data.sessions.some(s => s.id === sessionId)) data.activeSessionId = sessionId
  return write(wsPath, data)
}

export function closeSession(wsPath: string, sessionId: string): SessionsFile {
  const data = readSessions(wsPath)
  const target = data.sessions.find(s => s.id === sessionId)
  if (!target) return data
  // Read-only (imported) sessions aren't persisted — remember the dismissal so it stays closed.
  if (target.readonly) {
    const dismissed = [...new Set([...(data.dismissedImported ?? []), sessionId])]
    const remaining = data.sessions.filter(s => s.id !== sessionId)
    const activeSessionId = data.activeSessionId === sessionId
      ? (remaining[0]?.id ?? '')
      : data.activeSessionId
    return write(wsPath, { ...data, sessions: remaining, activeSessionId, dismissedImported: dismissed })
  }
  const writable = data.sessions.filter(s => !s.readonly)
  if (writable.length <= 1) return data
  const idx = data.sessions.findIndex(s => s.id === sessionId)
  if (idx < 0) return data
  data.sessions.splice(idx, 1)
  if (data.activeSessionId === sessionId) data.activeSessionId = data.sessions[Math.max(0, idx - 1)].id
  return write(wsPath, data)
}

export function renameSession(wsPath: string, sessionId: string, title: string): SessionsFile {
  const data = readSessions(wsPath)
  const s = data.sessions.find(x => x.id === sessionId)
  if (s) s.title = title
  return write(wsPath, data)
}

export function setSessionMode(wsPath: string, sessionId: string, mode: 'chat' | 'workflow', runId?: string): SessionsFile {
  const data = readSessions(wsPath)
  const s = data.sessions.find(x => x.id === sessionId)
  if (s) { s.mode = mode; if (runId !== undefined) s.runId = runId }
  return write(wsPath, data)
}

// Persist a session's agent permission (sandbox) scope so it's restored when the user returns to it.
export function setSessionPermission(wsPath: string, sessionId: string, mode: import('@shared/types').ChatSession['permissionMode']): SessionsFile {
  const data = readSessions(wsPath)
  const s = data.sessions.find(x => x.id === sessionId)
  if (s) { s.permissionMode = mode; write(wsPath, data) }
  return data
}

// Auto-name a still-default session from its first user instruction (called by chatService).
export function autoNameIfDefault(wsPath: string, sessionId: string, text: string): void {
  const data = readSessions(wsPath)
  const s = data.sessions.find(x => x.id === sessionId)
  if (s && s.title === '新会话') { s.title = titleFrom(text); write(wsPath, data) }
}

// Persist a rolling, distilled summary onto a session (conversation-level memory).
// No-op for an unknown session id. Used by the async distiller after a turn.
export function setSessionSummary(wsPath: string, sessionId: string, summary: string): SessionsFile {
  const data = readSessions(wsPath)
  const s = data.sessions.find(x => x.id === sessionId)
  if (s) { s.summary = summary; write(wsPath, data) }
  return data
}

// 读取单个会话的元数据（chatService 判定原生 resume 时用 continuedFrom）。
export function getSession(wsPath: string, sessionId: string): ChatSession | undefined {
  return readSessions(wsPath).sessions.find(s => s.id === sessionId)
}

// Create a new writable session that continues from an imported (read-only) external session.
// The new session records continuedFrom so chatService can inject a history preamble on the first turn.
// write() already filters readonly sessions before persisting — no manual filter needed here.
export function continueFrom(wsPath: string, args: { source: SourceId; externalId: string; title: string; filePaths: string[] }): SessionsFile {
  const data = readSessions(wsPath)
  const s = mkSession(`续 · ${args.title}`)
  s.continuedFrom = { source: args.source, externalId: args.externalId }
  s.external = { source: args.source, externalId: args.externalId, filePaths: args.filePaths }
  data.sessions.push(s); data.activeSessionId = s.id
  return write(wsPath, data)
}
