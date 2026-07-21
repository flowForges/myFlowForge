import type { RunState } from '@shared/types'

// The run to display for the selected workspace. The legacy orchestrator's on-disk last-run snapshot
// (window.forge.lastRun) is gone with the orchestrator, so there is no disk fallback anymore — the only
// run this can surface is a matching live run passed in (always null now that the legacy engine is
// removed; run2 drives its own 执行/运行历史 panels separately).
export function useLastRun(wsPath: string | undefined, liveRun: RunState | null): RunState | null {
  return liveRun && liveRun.workspacePath === wsPath ? liveRun : null
}
