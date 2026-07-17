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
    try {
      const task: AgentTask = {
        stageKey: order.stageKey, agentId: order.id, name: order.name,
        prompt: order.prompt, cwd: order.cwd, model: order.model,
        permissionMode: order.permissionMode,
      }
      const cb: AgentCallbacks = {
        onLog() {}, onState() {}, onDone() {}, onError() {},
        async onConfirm() { return 'allow' }, async onInput() { return '' },
        onHandoff(p) { handoff = p },
      }
      const session = deps.provider.run(task, cb, deps.env)
      const result = await session.done
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
