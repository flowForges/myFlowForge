import type { RunState, PendingAction, ResolvePayload } from '@shared/types'

export interface EngineApi {
  run: RunState | null
  pending: PendingAction[]
  resolve: (p: ResolvePayload) => void
  cancel: () => void
}

// The legacy orchestrator (and its engine:* IPC channels) has been removed entirely — run2 is the sole
// workflow-run path. This hook is now an inert, permanently-idle stub: it exists only to keep the
// `EngineApi` shape that WorkspaceView still accepts as a prop. It never subscribes to any channel and
// never carries a live run, so `run` is always null and resolve/cancel are no-ops.
export function useEngine(): EngineApi {
  return { run: null, pending: [], resolve: () => {}, cancel: () => {} }
}
