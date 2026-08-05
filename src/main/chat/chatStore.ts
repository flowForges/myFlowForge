import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage } from '@shared/types'
import { wsForgeDir } from '../config/paths'

export function sessionsDir(wsPath: string) { return join(wsForgeDir(wsPath), 'sessions') }
export function sessionMessagesFile(wsPath: string, sessionId: string) { return join(sessionsDir(wsPath), `${sessionId}.jsonl`) }

// 会话「最后一次对话时间」= 该会话消息文件(<ws>/.forge/sessions/<id>.jsonl)的 mtime。appendMessage 每轮都会
// touch 它,所以是「最后活动」的廉价准确代理,无需解析消息体(与 homeStats 的 lastMessageMtime 同法)。
// 无消息文件(刚建/外部导入会话)返回 undefined,由调用方回落到 createdAt。
export function sessionLastMessageMtime(wsPath: string, sessionId: string): number | undefined {
  try { return statSync(sessionMessagesFile(wsPath, sessionId)).mtimeMs } catch { return undefined }
}
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

// Resume map is nested by session: { [sessionId]: { [agent]: entry } }.
// `entry` is normally { resumeId, watermark }, but legacy on-disk data (pre-watermark) stored a bare
// resumeId string — readResume() below upgrades both shapes to ResumeEntry so callers never see raw JSON.
interface ResumeEntry { resumeId?: string; watermark?: number }
type RawResumeEntry = string | ResumeEntry
type RawResumeMap = Record<string, Record<string, RawResumeEntry>>
type ResumeMap = Record<string, Record<string, ResumeEntry>>

function normalizeEntry(v: RawResumeEntry): ResumeEntry {
  return typeof v === 'string' ? { resumeId: v } : v
}
function readResume(wsPath: string): ResumeMap {
  const f = resumeFile(wsPath)
  if (!existsSync(f)) return {}
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as RawResumeMap
    const out: ResumeMap = {}
    for (const [sessionId, agents] of Object.entries(raw)) {
      out[sessionId] = {}
      for (const [agent, v] of Object.entries(agents)) out[sessionId][agent] = normalizeEntry(v)
    }
    return out
  } catch { return {} }
}
function writeResume(wsPath: string, map: ResumeMap): void {
  ensureDir(wsForgeDir(wsPath))
  writeFileSync(resumeFile(wsPath), JSON.stringify(map, null, 2))
}
export function readSession(wsPath: string, sessionId: string, agent: string): string | undefined {
  return readResume(wsPath)[sessionId]?.[agent]?.resumeId
}
export function writeSession(wsPath: string, sessionId: string, agent: string, resumeId: string): void {
  const map = readResume(wsPath)
  const entry = (map[sessionId] ??= {})[agent] ?? {}
  ;(map[sessionId])[agent] = { ...entry, resumeId }
  writeResume(wsPath, map)
}
export function readSessionAgents(wsPath: string, sessionId: string): Record<string, string> {
  const agents = readResume(wsPath)[sessionId] ?? {}
  const out: Record<string, string> = {}
  for (const [agent, entry] of Object.entries(agents)) if (entry.resumeId !== undefined) out[agent] = entry.resumeId
  return out
}
export function readWatermark(wsPath: string, sessionId: string, agent: string): number {
  return readResume(wsPath)[sessionId]?.[agent]?.watermark ?? 0
}
export function writeWatermark(wsPath: string, sessionId: string, agent: string, watermark: number): void {
  const map = readResume(wsPath)
  const entry = (map[sessionId] ??= {})[agent] ?? {}
  ;(map[sessionId])[agent] = { ...entry, watermark }
  writeResume(wsPath, map)
}
