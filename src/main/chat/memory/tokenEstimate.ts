import type { ChatMessage } from '@shared/types'

// Cheap, dependency-free token estimate: ~3 chars per token is a reasonable average for
// mixed CJK/Latin prose. We only need a rough trigger threshold, not an exact count.
export function estimateTokens(text: string | undefined): number {
  if (!text) return 0
  return Math.floor(text.length / 3)
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.text), 0)
}

// When a session's estimated tokens exceed this, schedule a background distill of the oldest N
// messages into the rolling session summary. Generous so we summarize rarely, never mid-flow.
export const SESSION_DISTILL_THRESHOLD = 6000
export const DISTILL_OLDEST_N = 12

// Promote durable facts into workspace.md every K user turns (in addition to on session close).
export const WORKSPACE_PROMOTE_EVERY_K = 6

// Promote cross-project user habits into system.md every K messages. App/system distillation is
// expensive, so it runs at this low cadence off the chat provider — closeSession has no provider to
// run the LLM oneShot on, so the message-count cadence inside scheduleDistill is the wiring point.
export const SYSTEM_PROMOTE_EVERY_K = 20
