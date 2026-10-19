import { useEffect, useSyncExternalStore } from 'react'
import type { ChatEvent, ChangesEvent } from '@shared/types'
import type { RunLogLine } from '../../main/run/controller'
import { changeItemToLine, run2LogToLine } from './logReducer'
import type { LogSnapshot, LogStore } from './logStore'

/** Read a slice of the live log. Only the component calling this re-renders, and only when the
 *  selected value changes (select primitives / stable references, e.g. `s => s.logs`, `s => s.busy`). */
export function useLogSelector<T>(store: LogStore, select: (s: LogSnapshot) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getSnapshot()))
}

/** Wire the window.forge event streams into the log store. Renders nothing and never triggers a
 *  re-render of its host — the host (App) only owns the subscription lifetime. */
export function useLogFeed(store: LogStore): void {
  useEffect(() => {
    const offChat = window.forge.onChatEvent((e: ChatEvent) => store.handleChat(e))
    return () => { offChat(); store.dispose() }
  }, [store])

  // The legacy orchestrator engine-event log stream (pending:add / agent:log / agent:stalled /
  // run:update per-agent state lines) is gone with the orchestrator. run2 feeds this console via its
  // own RunLogLine stream (below); nothing subscribes to the removed engine bus here anymore.

  // run2 (P0 Task 4): the new headless run controller doesn't emit EngineEvents — it broadcasts
  // its own RunLogLine stream (see Tasks 1-3). Feed those into the same console so the bottom log
  // panel isn't empty during a run2 workflow run.
  useEffect(() => {
    const r = window.forge?.run2
    if (!r?.onLog) return
    const off = r.onLog((p: { workspacePath: string; log: unknown }) => {
      store.push([run2LogToLine({ workspacePath: p.workspacePath, log: p.log as RunLogLine }, new Date())])
    })
    return () => { off() }
  }, [store])

  useEffect(() => {
    if (!window.forge.onChangesEvent) return
    const offChanges = window.forge.onChangesEvent((e: ChangesEvent) => {
      const now = new Date()
      const lines = e.changes.map(c => changeItemToLine(c, e.cwd, now))
      if (lines.length) store.push(lines)
    })
    return () => { offChanges() }
  }, [store])
}
