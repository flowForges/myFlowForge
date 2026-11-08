// events.redacted 到了:缓存里这些 seq 的文字换成 [已删除];带 session 的整会话抹除则丢掉那个会话的每一条(08 §14)
import type { KernelEvent } from '@mffai/protocol'

export const REDACTED = '[已删除]'

/** 结构字段(id、状态码),抹除后后台也留着;其余顶层字符串都当文字 */
const KEEP = new Set([
  'turnId', 'callId', 'approvalId', 'runId', 'id', 'step', 'phase', 'ref', 'executor', 'status', 'kind', 'name', 'tool',
  'channel', 'by', 'decision', 'isolation', 'reason', 'flowId', 'accountId', 'plugin', 'server', 'state', 'stagingId', 'worktreeId',
])

function scrub(e: KernelEvent): KernelEvent {
  if (!e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) return e
  const p: Record<string, unknown> = { ...(e.payload as Record<string, unknown>) }
  for (const [k, v] of Object.entries(p)) if (typeof v === 'string' && !KEEP.has(k)) p[k] = REDACTED
  return { ...e, payload: p }
}

export function applyRedaction(events: KernelEvent[], r: KernelEvent): KernelEvent[] {
  if (r.type !== 'events.redacted') return events
  const p = (r.payload ?? {}) as { seqs?: unknown; session?: unknown }
  const session = typeof p.session === 'string' ? p.session : undefined
  const seqs = new Set(Array.isArray(p.seqs) ? p.seqs.filter((s): s is number => typeof s === 'number') : [])
  if (!session && !seqs.size) return events
  return events.flatMap((e) => (session && e.sessionId === session ? [] : seqs.has(e.seq) ? [scrub(e)] : [e]))
}
