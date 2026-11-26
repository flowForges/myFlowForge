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

/** 一次追加多条(一次写盘)。 */
export function appendMessages(wsPath: string, sessionId: string, msgs: ChatMessage[]): void {
  if (!msgs.length) return
  ensureDir(sessionsDir(wsPath))
  appendFileSync(sessionMessagesFile(wsPath, sessionId), msgs.map(m => JSON.stringify(m) + '\n').join(''))
}

/** 删掉一条已经落盘的消息(没发出去的那一轮撤回它的用户消息)。找不到就什么都不做。 */
export function removeMessage(wsPath: string, sessionId: string, id: string): void {
  const f = sessionMessagesFile(wsPath, sessionId)
  if (!existsSync(f)) return
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const kept = lines.filter((line) => { try { return (JSON.parse(line) as ChatMessage).id !== id } catch { return true } })
  if (kept.length !== lines.length) writeFileSync(f, kept.length ? kept.join('\n') + '\n' : '')
}

/** 改一条已经落盘的消息(后台子代理的卡片晚于消息收尾才跑完)。找不到就什么都不做。 */
export function updateMessage(wsPath: string, sessionId: string, id: string, fn: (m: ChatMessage) => ChatMessage): void {
  const f = sessionMessagesFile(wsPath, sessionId)
  if (!existsSync(f)) return
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((line) => {
    try {
      const m = JSON.parse(line) as ChatMessage
      return m.id === id ? JSON.stringify(fn(m)) : line
    } catch { return line }
  })
  writeFileSync(f, lines.join('\n') + '\n')
}

export function readMessages(wsPath: string, sessionId: string): ChatMessage[] {
  const f = sessionMessagesFile(wsPath, sessionId)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as ChatMessage] } catch { return [] }
  })
}

// Resume map is nested by session: { [sessionId]: { [agent]: entry } }.
// `entry` is normally { resumeId, watermark, ...binding fields }, but legacy on-disk data (pre-watermark) stored a
// bare resumeId string — readResume() below upgrades both shapes to ResumeEntry so callers never see raw JSON.
// The binding fields tie the session to the CLI's own transcript (session handoff with the official apps):
//   origin        'forge' = we started it (default when absent), 'imported' = taken over from the official app
//   syncedTo      how far into the external transcript we have shown (byte offset + last line fingerprint)
//   cwd           cwd taken from the external transcript (readers only report it in the range that contains it)
//   extFile       resolved path of the external transcript, cached
//   ownEnd        size + mtime of the transcript when OUR writer went quiet — unchanged since = nobody else wrote
//   ownLastWriteAt when our own writer last went quiet (legacy fallback for bindings without ownEnd)
//   ownMsgMark    id of the last Forge user message already matched to a record in the external transcript
//                 (recordOwnEnd only considers messages after it; kept across resume-id changes — it is about OUR messages)
export interface ExtSyncCursor { offset: number; lastId?: string }
export interface OwnEnd { offset: number; mtimeMs: number }
export interface BindingMeta {
  origin?: 'forge' | 'imported'
  syncedTo?: ExtSyncCursor
  cwd?: string
  extFile?: string
  ownEnd?: OwnEnd
  ownLastWriteAt?: number
  ownMsgMark?: string
}
/** Fields that describe one particular transcript: meaningless once the resume id changes. */
const PER_TRANSCRIPT = ['syncedTo', 'extFile', 'ownEnd', 'ownLastWriteAt'] as const
function forNewId(entry: ResumeEntry): ResumeEntry {
  const out = { ...entry }
  for (const k of PER_TRANSCRIPT) delete out[k]
  return out
}
interface ResumeEntry extends BindingMeta { resumeId?: string; watermark?: number }
export interface Binding extends BindingMeta { resumeId: string; origin: 'forge' | 'imported'; watermark?: number }
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
  // A different id is a different external transcript: the old position / path / own-writer marks no longer apply.
  ;(map[sessionId])[agent] = entry.resumeId !== undefined && entry.resumeId !== resumeId ? { ...forNewId(entry), resumeId } : { ...entry, resumeId }
  writeResume(wsPath, map)
}
/** The session's binding to the CLI transcript for `agent`, or undefined when there is no resume id yet. */
export function readBinding(wsPath: string, sessionId: string, agent: string): Binding | undefined {
  const e = readResume(wsPath)[sessionId]?.[agent]
  if (!e?.resumeId) return undefined
  return { ...e, resumeId: e.resumeId, origin: e.origin ?? 'forge' }
}
/** The session in this workspace whose `agent` binding has this resume id (first one), if any. */
export function findBoundSession(wsPath: string, agent: string, resumeId: string): string | undefined {
  for (const [sid, agents] of Object.entries(readResume(wsPath))) if (agents[agent]?.resumeId === resumeId) return sid
  return undefined
}
/** Merge binding fields; keys whose value is undefined keep their stored value. A new resumeId drops the per-transcript fields. */
export function writeBinding(wsPath: string, sessionId: string, agent: string, patch: BindingMeta & { resumeId?: string }): void {
  const map = readResume(wsPath)
  const stored = (map[sessionId] ??= {})[agent] ?? {}
  const idChanged = patch.resumeId !== undefined && stored.resumeId !== undefined && patch.resumeId !== stored.resumeId
  const entry = { ...(idChanged ? forNewId(stored) : stored) } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) entry[k] = v
  ;(map[sessionId])[agent] = entry as ResumeEntry
  writeResume(wsPath, map)
}
/** Record that our own turn just wrote to / finished on the external transcript (see isOccupied). */
export function markOwnWrite(wsPath: string, sessionId: string, agent: string, at: number = Date.now()): void {
  writeBinding(wsPath, sessionId, agent, { ownLastWriteAt: at })
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
