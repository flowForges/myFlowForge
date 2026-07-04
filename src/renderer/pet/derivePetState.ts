import type { RunState, PendingAction, PetState } from '@shared/types'

// justDone: a chat turn just finished (transient, set by useChatActivity for a few seconds) — lets
// the pet flash a done reaction for plain chat replies, not just orchestrated run→ok completions.
export interface ChatActivity { busy: boolean; confirmPending: boolean; justDone?: boolean }

export function derivePetState(run: RunState | null, pending: PendingAction[], chat: ChatActivity = { busy: false, confirmPending: false }): PetState {
  if (pending.some(p => p.kind === 'confirm') || chat.confirmPending) return 'confirm'
  if (pending.some(p => p.kind === 'input')) return 'input'
  if (run?.status === 'run' || chat.busy) return 'working'
  if (run?.status === 'ok' || chat.justDone) return 'done'
  return 'idle'
}
