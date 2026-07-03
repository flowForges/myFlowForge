import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage } from '@shared/types'
import { wsForgeDir } from '../config/paths'

export function sessionsDir(wsPath: string) { return join(wsForgeDir(wsPath), 'sessions') }
export function sessionMessagesFile(wsPath: string, sessionId: string) { return join(sessionsDir(wsPath), `${sessionId}.jsonl`) }
function resumeFile(wsPath: string) { return join(wsForgeDir(wsPath), 'chat-session.json') }
function ensureDir(d: string) { if (!existsSync(d)) mkdirSync(d, { recursive: true }) }

export function appendMessage(wsPath: string, sessionId: string, msg: ChatMessage): void {
  ensureDir(sessionsDir(wsPath))
  appendFileSync(sessionMessagesFile(wsPath, sessionId), JSON.stringify(msg) + '\n')
}

export function readMessages(wsPath: string, sessionId: string): ChatMessage[] {
  const f = sessionMessagesFile(wsPath, sessionId)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as ChatMessage] } catch { return [] }
  })
}

// Resume map is nested by session: { [sessionId]: { [agent]: resumeId } }
type ResumeMap = Record<string, Record<string, string>>
function readResume(wsPath: string): ResumeMap {
  const f = resumeFile(wsPath)
  if (!existsSync(f)) return {}
  try { return JSON.parse(readFileSync(f, 'utf8')) as ResumeMap } catch { return {} }
}
export function readSession(wsPath: string, sessionId: string, agent: string): string | undefined {
  return readResume(wsPath)[sessionId]?.[agent]
}
export function writeSession(wsPath: string, sessionId: string, agent: string, resumeId: string): void {
  ensureDir(wsForgeDir(wsPath))
  const map = readResume(wsPath)
  ;(map[sessionId] ??= {})[agent] = resumeId
  writeFileSync(resumeFile(wsPath), JSON.stringify(map, null, 2))
}
export function readSessionAgents(wsPath: string, sessionId: string): Record<string, string> {
  return readResume(wsPath)[sessionId] ?? {}
}
