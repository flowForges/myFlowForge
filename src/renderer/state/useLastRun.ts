import { useEffect, useState } from 'react'
import type { RunState } from '@shared/types'

// The run to display for the selected workspace: the live run when it belongs
// to that workspace, else the last persisted snapshot fetched from disk.
export function useLastRun(wsPath: string | undefined, liveRun: RunState | null): RunState | null {
  const [snapshot, setSnapshot] = useState<RunState | null>(null)
  const liveMatches = !!liveRun && liveRun.workspacePath === wsPath
  useEffect(() => {
    if (!wsPath || liveMatches) { setSnapshot(null); return }
    let stale = false
    void window.forge.lastRun(wsPath).then((r: RunState | null) => { if (!stale) setSnapshot(r) })
    return () => { stale = true }
  }, [wsPath, liveMatches])
  return liveMatches ? liveRun : snapshot
}
