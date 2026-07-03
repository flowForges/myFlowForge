import type { RunState, PendingAction, PetState } from '@shared/types'

export interface ChatActivity { busy: boolean; confirmPending: boolean }

export function derivePetState(run: RunState | null, pending: PendingAction[], chat: ChatActivity = { busy: false, confirmPending: false }): PetState {
  if (pending.some(p => p.kind === 'confirm') || chat.confirmPending) return 'confirm'
  if (pending.some(p => p.kind === 'input')) return 'input'
  if (run?.status === 'run' || chat.busy) return 'working'
  if (run?.status === 'ok') return 'done'
  return 'idle'
}
