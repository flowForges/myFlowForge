import type { AgentProvider, AgentTask, AgentCallbacks, HandoffPayload } from '../agents/types'
import type { PermissionMode } from '@shared/permissions'
import { parseHandoffResult, type HandoffResult } from './handoffResult'

export interface WorkOrder {
  id: string
  stageKey: string
  name: string
  project?: string
  provider: string
  model: string
  cwd: string
  prompt: string
  permissionMode?: PermissionMode
  // ②多镜头CR: set only on a multi-lens review reviewer (id `${stageKey}:workspace:${lens}`) — the
  // review视角 this reviewer审. Used to (a) name a unique per-lens artifact file (avoid the
  // review-root.md collision when every lens reviewer has no `project`) and (b) let the exec panel /
  // consolidated report group by lens. Absent for every other order (root, per-project, single).
  lens?: import('@shared/types').ReviewLens
}

export interface WorkOrderOutcome {
  order: WorkOrder
  status: 'ok' | 'failed'
  result?: HandoffResult
  error?: string
  attempts: number
}

export interface RunWorkOrderDeps {
  provider: AgentProvider
  env: NodeJS.ProcessEnv
  retries?: number
  backoffMs?: number[]
  sleep?: (ms: number) => Promise<void>
  isTransient?: (err: Error) => boolean
  onConfirm?: (req: import('../agents/types').ConfirmReq, laneId: string) => Promise<'allow' | 'deny'>
  onInput?: (req: import('../agents/types').InputReq, laneId: string) => Promise<string>
  onProgress?: (ev: { laneId: string; state?: import('../agents/types').AgentState; activity?: string; log?: import('../agents/types').LogLine }) => void
  // Surfaces the CLI-native session id a provider's `run()` emits via `cb.onSession(id)` (same
  // mechanism the legacy orchestrator captures via its own onSession callback — orchestrator.ts's
  // `store.setAgentSession`) — without this, run2 never captured a stage agent's session id at all,
  // so it could never show up in the "Agent Session IDs" panel (composeAgentSessions only knew about
  // the OLD orchestrator's run store). Optional/best-effort: a provider that never calls onSession
  // (or a test double that doesn't implement it) simply never fires this — no behavior change.
  onSession?: (laneId: string, provider: string, sessionId: string) => void
}

const TRANSIENT_RE = /timeout|network|econn|etimedout|socket hang|cancel/i
export function isTransientError(err: Error): boolean {
  return TRANSIENT_RE.test(err.message || '')
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function runWorkOrder(order: WorkOrder, deps: RunWorkOrderDeps): Promise<WorkOrderOutcome> {
  const retries = deps.retries ?? 2
  const backoff = deps.backoffMs ?? [5000, 20000]
  const sleep = deps.sleep ?? defaultSleep
  const isTransient = deps.isTransient ?? isTransientError

  let attempts = 0
  let lastErr: Error | null = null

  while (attempts <= retries) {
    attempts++
    let handoff: HandoffPayload | null = null
    // Reset per-attempt: a captured error from a prior attempt must never leak into this one.
    let capturedErr: Error | null = null
    try {
      const task: AgentTask = {
        stageKey: order.stageKey, agentId: order.id, name: order.name,
        prompt: order.prompt, cwd: order.cwd, model: order.model,
        permissionMode: order.permissionMode,
      }
      const cb: AgentCallbacks = {
        onLog(line) { deps.onProgress?.({ laneId: order.id, activity: line.text, log: line }) },
        onState(s) { deps.onProgress?.({ laneId: order.id, state: s }) },
        onActivity() { deps.onProgress?.({ laneId: order.id }) },
        onDone() {},
        onError(e) { capturedErr = e instanceof Error ? e : new Error(String(e)) },
        onSession(id) { deps.onSession?.(order.id, order.provider, id) },
        onConfirm: (req) => (deps.onConfirm ? deps.onConfirm(req, order.id) : Promise.resolve('allow')),
        onInput: (req) => (deps.onInput ? deps.onInput(req, order.id) : Promise.resolve('')),
        onHandoff(p) { handoff = p },
      }
      const session = deps.provider.run(task, cb, deps.env)
      const result = await session.done
      // Real providers signal failure by RESOLVING `done` with { ok: false } (they call
      // onState('err') + onError(err) but never reject). Route that into the same
      // catch/retry/classify path below instead of returning a false 'ok'.
      if (!result?.ok) throw capturedErr ?? new Error('agent reported failure')
      const payload: HandoffPayload = handoff ?? { summary: result.summary ?? '' }
      return { order, status: 'ok', result: parseHandoffResult(payload), attempts }
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      if (!isTransient(lastErr) || attempts > retries) break
      await sleep(backoff[Math.min(attempts - 1, backoff.length - 1)])
    }
  }
  return { order, status: 'failed', error: lastErr?.message ?? 'unknown error', attempts }
}
