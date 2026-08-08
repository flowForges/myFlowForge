import type { RunState, PendingAction, PetState } from '@shared/types'

// justDone: a chat turn just finished (transient, set by useChatActivity for a few seconds) — lets
// the pet flash a done reaction for plain chat replies, not just orchestrated run→ok completions.
// confirmAt: WHERE the outstanding confirm lives. 光有 confirmPending 这个布尔量,宠物知道「有东西要确认」
// 却不知道在哪 —— 点「去 app 处理」只能回落到当前工作区,于是跳到一个跟这次确认无关的会话。
export interface ChatActivity {
  busy: boolean
  confirmPending: boolean
  justDone?: boolean
  confirmAt?: { wsPath: string; sessionId: string } | null
}

export function derivePetState(run: RunState | null, pending: PendingAction[], chat: ChatActivity = { busy: false, confirmPending: false }): PetState {
  if (pending.some(p => p.kind === 'confirm') || chat.confirmPending) return 'confirm'
  if (pending.some(p => p.kind === 'input')) return 'input'
  if (run?.status === 'run' || chat.busy) return 'working'
  if (run?.status === 'ok' || chat.justDone) return 'done'
  return 'idle'
}
