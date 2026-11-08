// 会话夹具:形状过 SessionSummarySchema,写错了在这里就失败
import type { RunRow, SessionSummary } from '@mffai/protocol'
import { RunRowSchema, SessionSummarySchema } from '@mffai/protocol/browser'

export function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return SessionSummarySchema.parse({
    id, title: id, origin: 'app', audience: 'owner', approvalMode: 'ask', createdAt: 1, updatedAt: 1, pendingApprovals: 0, ...patch,
  })
}

export function runRow(runId: string, sessionId: string, patch: Partial<RunRow> = {}): RunRow {
  return RunRowSchema.parse({
    runId, sessionId, turnId: 't1', executor: 'codex', phase: 'ended', status: 'ok', queuedAt: 1, readOnly: false, isolation: 'own', ...patch,
  })
}

/** permissions.get 的回答 */
export const perms = (level: 'full' | 'partial' | 'none', allowUnsandboxedAuto = false) => ({
  config: { rules: [], network: { allow: [] }, sandbox: { enabled: true, allowLoopback: false }, allowUnsandboxedAuto },
  defaults: [], errors: [], sandbox: { level, missing: [], autoDegraded: level === 'none' && !allowUnsandboxedAuto },
})
