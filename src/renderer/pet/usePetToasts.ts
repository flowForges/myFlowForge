import type { Pet } from '@shared/types'

export type ToastKind = 'confirm' | 'input' | 'done'
export interface Toast { id: string; kind: ToastKind; wsName: string; title: string; leaving?: boolean }

// The legacy orchestrator engine bus that drove these toasts (pending:add / run:update) has been
// removed entirely. Pet activity indicators now derive from chat activity elsewhere (useChatActivity),
// so this hook is an inert stub kept only for the PetToasts render surface — it never produces a toast.
export function usePetToasts(_notify: Pet['notify']): { toasts: Toast[]; dismiss: (id: string) => void } {
  return { toasts: [], dismiss: () => {} }
}
