// Pure reducer for the live log console.
// No side-effects, no Date() calls inside — pass Date externally for testability.

export interface LogLine {
  id: string
  t: string           // "HH:MM:SS"
  level: 'think' | 'exec' | 'file' | 'out' | 'user'
  src: string
  color: string
  text: string
  streaming: boolean
}

export const MAX_LOGS = 400

/** Zero-padded "HH:MM:SS" string from a Date. */
export function logStamp(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

/** Append lines and cap at MAX_LOGS (drop oldest). */
export function appendLines(existing: LogLine[], incoming: LogLine[]): LogLine[] {
  const next = [...existing, ...incoming]
  return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next
}

// ── Per-level labels ────────────────────────────────────────────────────────

export const LEVEL_LABELS: Record<LogLine['level'], string> = {
  think: '思考',
  exec:  '执行',
  file:  '文件',
  out:   '输出',
  user:  '指令',
}

// ── Event → line mappers (pure) ─────────────────────────────────────────────

import type { ChatEvent, EngineEvent, ChangeItem } from '@shared/types'
import type { RunLogLine } from '../../main/run/controller'

/** Map a ChatEvent to zero-or-more LogLines. */
export function chatEventToLines(e: ChatEvent, now: Date): LogLine[] {
  const t = logStamp(now)
  if (e.type === 'user') {
    return [{
      id: `${t}-user-${e.message.id}`,
      t, level: 'user', src: '你', color: 'var(--accent)',
      text: e.message.text, streaming: false,
    }]
  }
  if (e.type === 'error') {
    return [{
      id: `${t}-err-${e.id}`,
      t, level: 'out', src: '主代理', color: 'var(--accent)',
      text: `错误: ${e.error}`, streaming: false,
    }]
  }
  return []
}

const PENDING_KIND_LABELS: Record<string, string> = {
  confirm: '请求确认',
  input:   '请求输入',
  select:  '请求选择',
}

/** Map a pending:add EngineEvent to a LogLine. */
export function pendingAddToLine(e: Extract<EngineEvent, { type: 'pending:add' }>, now: Date): LogLine {
  const t = logStamp(now)
  const kindLabel = PENDING_KIND_LABELS[e.action.kind] ?? e.action.kind
  const src = e.action.agentName || '主代理'
  return {
    id: `${t}-pending-${e.action.id}`,
    t, level: 'exec', src, color: 'var(--accent)',
    text: `${kindLabel}：${e.action.title}`, streaming: false,
  }
}

// kind (when set) is lossless → maps 1:1 to console level so the 思考/执行/文件/输出
// filters work for workflow logs; fall back to the legacy level mapping when absent.
// Module-level so both agentLogToLine (old EngineEvent bus) and run2LogToLine (run2 bus) share it.
const KIND_TO_LEVEL = { think: 'think', tool: 'exec', file: 'file', output: 'out' } as const

// Monotonic suffix so repeated agent:log lines (same timestamp + agent) get unique React keys
// without Math.random() (keeps this module deterministic / side-effect-free per the header).
let aglogSeq = 0

/** Map an agent:log EngineEvent to a LogLine. */
export function agentLogToLine(e: Extract<EngineEvent, { type: 'agent:log' }>, now: Date): LogLine {
  const t = logStamp(now)
  const level: LogLine['level'] = e.line.kind
    ? KIND_TO_LEVEL[e.line.kind]
    : (e.line.level === 'ok') ? 'out'
    : (e.line.level === 'accent') ? 'out'
    : 'exec'
  return {
    id: `${t}-aglog-${e.agentId}-${++aglogSeq}`,
    t, level, src: e.agentId, color: 'var(--accent)',
    text: e.line.text, streaming: false,
  }
}

// Monotonic suffix so run2 log lines get unique React keys even when they share the same
// provider `ts` (real providers stamp `ts` at second granularity → many lines/sec collide).
// Appended unconditionally, exactly like aglogSeq above.
let run2LogSeq = 0

/** Map a run2:log payload (RunLogLine, from Task 3's controller-level log bus) to a console LogLine. */
export function run2LogToLine(p: { workspacePath: string; log: RunLogLine }, now: Date): LogLine {
  const t = logStamp(now)
  const { log } = p
  const kind = log.line.kind ?? 'output'
  const level: LogLine['level'] = KIND_TO_LEVEL[kind] ?? 'out'
  return {
    id: `${t}-run2-${log.laneId}-${log.line.ts}-${++run2LogSeq}`,
    t, level, src: log.agentName, color: 'var(--accent)',
    text: log.line.text, streaming: false,
  }
}

/** Helper to build an agent-state LogLine (called from the hook after diffing). */
export function agentStateLine(
  agentId: string, agentName: string, state: 'run' | 'stalled' | 'awaiting' | 'ok' | 'err', now: Date
): LogLine {
  const t = logStamp(now)
  const color = state === 'ok' ? 'var(--ok)'
    : state === 'err' ? 'var(--err)'
    : state === 'stalled' ? 'var(--warn)'
    : 'var(--accent)'
  const text = state === 'run' ? '执行中'
    : state === 'stalled' ? '疑似卡住'
    : state === 'awaiting' ? '等待确认'
    : state === 'ok' ? '完成'
    : '失败'
  return {
    id: `${t}-state-${agentId}-${state}`,
    t, level: 'exec', src: agentName, color,
    text, streaming: false,
  }
}

/** Map a file change item to a LogLine. */
export function changeItemToLine(item: ChangeItem, cwd: string, now: Date): LogLine {
  const t = logStamp(now)
  const verb = item.type === 'A' ? '新增' : item.type === 'D' ? '删除' : '修改'
  return {
    id: `${t}-file-${item.path}`,
    t, level: 'file', src: cwd, color: 'var(--warn)',
    text: `${verb} ${item.path}`, streaming: false,
  }
}
