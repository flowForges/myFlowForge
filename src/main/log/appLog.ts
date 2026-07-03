import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Centralized app-level diagnostic log (main process). Unlike the per-run LogConsole (renderer,
// in-memory, lost on reload), this keeps a bounded ring buffer AND optionally persists to disk so
// failures survive crashes/reloads and can be exported for debugging. Logging must NEVER throw.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface AppLogEntry { ts: string; level: LogLevel; scope: string; msg: string; detail?: string }

const RING_MAX = 3000
const DETAIL_MAX = 8000
const ROTATE_BYTES = 5 * 1024 * 1024

const ring: AppLogEntry[] = []
let fileSink: ((line: string) => void) | null = null
let eventSink: ((e: AppLogEntry) => void) | null = null
let logFile: string | null = null

export function formatLine(e: AppLogEntry): string {
  const base = `${e.ts} [${e.level}] [${e.scope}] ${e.msg}`
  return e.detail ? `${base}\n    ${e.detail.replace(/\n/g, '\n    ')}` : base
}

export function appLog(level: LogLevel, scope: string, msg: string, detail?: string): AppLogEntry {
  const e: AppLogEntry = { ts: new Date().toISOString(), level, scope, msg: String(msg ?? '') }
  if (detail != null && String(detail) !== '') e.detail = String(detail).slice(0, DETAIL_MAX)
  ring.push(e)
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
  try { fileSink?.(formatLine(e)) } catch { /* never let logging throw */ }
  try { eventSink?.(e) } catch { /* never let logging throw */ }
  return e
}

export const logDebug = (scope: string, msg: string, detail?: string) => appLog('debug', scope, msg, detail)
export const logInfo = (scope: string, msg: string, detail?: string) => appLog('info', scope, msg, detail)
export const logWarn = (scope: string, msg: string, detail?: string) => appLog('warn', scope, msg, detail)
export const logError = (scope: string, msg: string, detail?: string) => appLog('error', scope, msg, detail)

export function getAppLog(): AppLogEntry[] { return ring.slice() }
export function clearAppLog(): void { ring.length = 0 }
export function formatAppLog(entries: AppLogEntry[] = ring): string { return entries.map(formatLine).join('\n') }
export function appLogFilePath(): string | null { return logFile }

// --- test/wiring seams ---
export function setAppLogFileSink(fn: ((line: string) => void) | null): void { fileSink = fn }
export function setAppLogEventSink(fn: ((e: AppLogEntry) => void) | null): void { eventSink = fn }

/** Persist subsequent log lines to <dir>/app.log (rotating once when it grows past 5 MB). */
export function initAppLogFile(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'app.log')
  try { if (existsSync(file) && statSync(file).size > ROTATE_BYTES) renameSync(file, join(dir, 'app.log.1')) } catch { /* rotation best-effort */ }
  logFile = file
  fileSink = (line: string) => { try { appendFileSync(file, line + '\n') } catch { /* disk full / perms — ring still holds it */ } }
  return file
}
