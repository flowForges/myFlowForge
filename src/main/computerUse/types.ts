// Main-side computer-use types shared by the service (Task 4) and the executor / action log (Task 5). Spec V15.
import type { ComputerUseMode, CuActionView, CuErrCode, Delivery } from '@shared/computerUse'
import { COMPUTER_TOOLS } from '@shared/computerUse'
import type { ComputerDriver, Pt } from './driver'

export interface CuSessionKey { workspacePath: string; sessionId: string }

/** One tool op = the tool name without its `computer_` prefix. */
export type CuOp = (typeof COMPUTER_TOOLS)[number] extends `computer_${infer O}` ? O : never
export const CU_OPS: readonly CuOp[] = COMPUTER_TOOLS.map((t) => t.slice('computer_'.length) as CuOp)
export const isCuOp = (s: unknown): s is CuOp => typeof s === 'string' && (CU_OPS as readonly string[]).includes(s)

/** What forgeMcp learnt from `initialize` (clientInfo), carried with every call for the log / debug log. */
export interface CallMeta {
  client?: { name: string; version: string }
  /** fires when the MCP caller abandoned the call (its request was cancelled or the connection dropped) */
  signal?: AbortSignal
}

/** `delivery` / `retry` / `label`: the semantic tools' result envelope (spec §8.3); v1 tools leave them out. */
export type CuResult =
  | { ok: true; text: string; image?: { data: string; mimeType: 'image/jpeg' }; delivery?: Delivery; label?: string }
  | { ok: false; code: CuErrCode; text: string; delivery?: Delivery; retry?: 'safe' | 'unsafe' }

export type GateDecision = 'allow' | 'deny' | 'stop' | 'timeout'
export type StopWhy = 'user' | 'hotkey' | 'lock' | 'vision' | 'limit' | 'deleted' | 'quit'

export interface CuGate {
  id: string
  key: CuSessionKey
  kind: 'action' | 'continue'
  action?: CuActionView
  crop?: string /* base64 jpeg */
  reason?: string
  ts: number
}

export interface CuLogEntry {
  ts: number; turn: number; op: CuOp; app?: string; bundleId?: string; at?: Pt
  /**
   * per-app-run id stamped by the service. `turn` is an in-memory ++seq that restarts every launch while this log
   * persists, so (run, turn) is what identifies a turn. Absent on entries written before it existed.
   */
  run?: string
  /** memory only (V11): stripped before anything reaches disk */
  textPreview?: string
  textLen?: number
  combo?: string
  /** semantic act: the element it landed on (screen text, capped) */
  element?: { role: string; name?: string }
  /** semantic act: the Chinese verb for the action (ACT_LABEL value, not model text; CuLogBlock's row, Task 10) */
  actLabel?: string
  /** semantic mutations: what forge-cu said about delivery */
  delivery?: Delivery
  result: 'allowed' | 'auto' | 'denied' | 'blocked' | 'failed'
  code?: CuErrCode
  thumb?: string /* file name */
}

export interface ActionLog {
  append(key: CuSessionKey, e: CuLogEntry, thumbJpeg?: string): Promise<CuLogEntry>
  list(key: CuSessionKey): Promise<CuLogEntry[]>
  thumb(key: CuSessionKey, file: string): Promise<string | null>
  remove(key: CuSessionKey): Promise<void>
}

export type CuEvent =
  | { type: 'state'; sessions: { workspacePath: string; sessionId: string; mode: ComputerUseMode; title: string }[] }
  | { type: 'gate'; gate: CuGate }
  | { type: 'gate-resolved'; id: string; decision: GateDecision }
  | { type: 'action'; key: CuSessionKey; entry: CuLogEntry }
  | { type: 'stopped'; key?: CuSessionKey; why: StopWhy }

export interface Executor {
  run(key: CuSessionKey, op: CuOp, args: unknown, meta: CallMeta): Promise<CuResult>
}

/**
 * What the service hands its executor. The executor only ever runs inside the service's FIFO, one call at a time.
 * `driver` is the service's guarded view of the real driver: its `post` refuses while any gate is pending or after the
 * running call was stopped, and it records the in-flight action so stop can `release` it after a kill (V6, V7g).
 */
export interface ServiceInternals {
  driver: ComputerDriver
  modeOf(key: CuSessionKey): ComputerUseMode
  /** serial of the open local turn (0 = none); per-turn counters reset when it changes */
  turnSeq(key: CuSessionKey): number
  /**
   * id of this app run, stamped on every log entry. turnSeq restarts at 1 each launch while the log persists, so the
   * renderer groups by (run, turn). Optional so test fakes can leave it out.
   */
  runId?: string
  /** serial of the current enable period (0 = off); vision code and the 2000 cap reset when it changes */
  enableSeq(key: CuSessionKey): number
  openGate(g: Omit<CuGate, 'id' | 'ts'>): Promise<GateDecision>
  hasPendingGate(): boolean
  emitAction(key: CuSessionKey, entry: CuLogEntry): void
  note(key: CuSessionKey, text: string): void
  stop(key: CuSessionKey, why: StopWhy): void
  /** the running call is still live (not settled, stopped, abandoned, or past its turn); absent → assumed live */
  callLive?(): boolean
}
