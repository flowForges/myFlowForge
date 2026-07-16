import type { RunState, PendingAction } from '@shared/types'
import type { PetAction } from '@shared/petAtlas'
import type { ChatActivity } from './derivePetState'

// Whether a running stage is a review/CR stage (built-in key 'review'; custom stages by name).
function reviewRunning(run: RunState): boolean {
  return run.stages.some(s => s.state === 'run' && (s.key === 'review' || /评审|审查|\bCR\b/i.test(s.name)))
}

// The action shown when NOT hovering — driven purely by run/chat state.
function baseAction(run: RunState | null, pending: PendingAction[], chat: ChatActivity): PetAction {
  if (pending.some(p => p.kind === 'confirm') || chat.confirmPending) return 'waiting'
  if (pending.some(p => p.kind === 'input')) return 'waiting'
  if (run?.status === 'err') return 'failed'
  if (run?.status === 'run') return reviewRunning(run) ? 'review' : 'running'
  if (chat.busy) return 'running'
  if (run?.status === 'ok' || chat.justDone) return 'jumping'
  return 'idle'
}

// Map runtime state → Codex atlas action. Hovering an otherwise-idle pet makes it JUMP — this matches
// Codex's own hover reaction (verified against the Codex app; our earlier `waving` guess was wrong).
// Hover never interrupts a gate / active run / completion. Look-at-cursor is layered on top in the
// renderer for the idle action.
export function derivePetAction(
  run: RunState | null,
  pending: PendingAction[],
  chat: ChatActivity = { busy: false, confirmPending: false },
  opts: { hovered?: boolean } = {},
): PetAction {
  const base = baseAction(run, pending, chat)
  if (base === 'idle' && opts.hovered) return 'jumping'
  return base
}
