import type { PetState } from '@shared/types'

// What the simple-mode bubble should show, derived from the already-computed pet state. Same precedence
// as derivePetState (confirm > input > working > done > idle); we just rename 'working' → 'running' for
// the panel and treat everything else 1:1. 'idle' → no panel (click the pet to focus the app).
export type SimpleKind = 'idle' | 'running' | 'confirm' | 'input' | 'done'

export function deriveSimpleKind(petState: PetState): SimpleKind {
  return petState === 'working' ? 'running' : petState
}
