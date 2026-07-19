import type { RunEvent } from '../../../main/run/events'
import type { ArtifactRef } from '../../../main/orchestrator/types'

// P3-1: maps a run2 controller's live inbox (unresolved human-intervention events) plus a caller-owned
// list of already-resolved/frozen decisions into entries the chat timeline (buildTimeline) can merge
// and render as cards. This module is a PURE mapping layer — no state, no side effects — mirroring how
// timeline.ts itself stays a pure ts-merge utility (see its P1-3 comment). The actual card component
// is P3-2; wiring this into WorkspaceView (owning the resolved list + first-seen map below) is P3-4.

// A resolved run2 decision, frozen for display once the live RunEvent is gone from `inbox` (removeEvent
// drops it — see src/main/run/events.ts). Carries just enough to render the frozen record without the
// original event object:
//  · `title` — a snapshot of the original event's headline text, captured by the freezer (P3-4) at
//    resolution time from whichever field the event kind carried (auth/question.title, doubt.note,
//    failure.error, or gate.body) — since the live RunEvent is gone, the frozen record must carry its
//    own copy.
//  · `body` — optional longer snapshot (e.g. a gate's full body) when `title` alone isn't enough.
//  · `at` — epoch ms when the decision was actually made (for "decided 2m ago" style display).
//  · `ts` — the ordering timestamp used for timeline merge. Deliberately the event's ORIGINAL
//    first-seen time, not `at` — so a card doesn't jump to a new timeline position the moment it's
//    resolved. This mirrors LaunchGateState/LaunchGateFrozen (src/renderer/views/WorkspaceView.tsx):
//    the outer wrapper's `ts` is fixed at creation, `decidedAt` lives on the frozen record separately.
export interface FrozenRunCard {
  id: string
  // Deferred fix (P4-3): 'aborted' is a synthetic marker kind — never a real controller-emitted
  // RunEvent, only ever CONSTRUCTED directly as a FrozenRunCard (WorkspaceView's recordRunAbort) the
  // moment the user hits 终止 in RunExecPanel, since that force-settles/drops any pending inbox event
  // without ever routing through resolveGate/resolveLane (i.e. without a normal freeze). It records
  // that the run ended by user abort instead of letting a pending gate/auth/question/doubt/failure
  // card just vanish from the timeline with no trace.
  kind: RunEvent['kind'] | 'aborted'
  stageKey: string
  title: string
  body?: string
  decision: string
  at: number
  ts: number
  // P4-3: mirrors GateEvent.finalize (events.ts) — set when this frozen record is the run-completion
  // "收尾确认" gate rather than an ordinary per-stage gate, so RunEventCard's frozen branch can still
  // label it "收尾确认" instead of "阶段评审" after the live event is gone.
  finalize?: boolean
  // Improvement ①: mirrors GateEvent.docs (events.ts) — preserved into the frozen record so a
  // resolved gate card can still open its full design doc(s) after the live event is gone from
  // `inbox` and reload/session-switch has round-tripped it through chat:append-run-card.
  docs?: ArtifactRef[]
}

export interface RunCardEntry {
  kind: 'run-card'
  event?: RunEvent
  frozen?: FrozenRunCard
  ts: number
  id: string
}

// Ordering-key decision (see task brief "Before You Begin"): RunEvent (src/main/run/events.ts) carries
// no `ts` field at all. However `addEvent` always appends (`[...inbox, e]`), so `inbox`'s array order
// IS arrival order already. We prefer a caller-supplied `firstSeenAt` map (event id → epoch ms of first
// observation) when available — the expected P3-4 wiring pattern mirrors LaunchGateState, which assigns
// `ts = Date.now()` once when a card is first created and keeps it stable thereafter. When no map entry
// exists (e.g. a plain unit test, or the map not yet populated for a brand-new event this tick), we fall
// back to the event's index within `inbox` — still deterministic, and consistent with arrival order.
export function toRunCardEntries(
  inbox: RunEvent[],
  resolved: FrozenRunCard[],
  firstSeenAt: Record<string, number> = {},
): RunCardEntry[] {
  const resolvedIds = new Set(resolved.map((r) => r.id))
  const active: RunCardEntry[] = inbox
    .filter((e) => !resolvedIds.has(e.id))
    .map((e, i) => ({ kind: 'run-card', event: e, id: e.id, ts: firstSeenAt[e.id] ?? i }))
  const frozen: RunCardEntry[] = resolved.map((f) => ({ kind: 'run-card', frozen: f, id: f.id, ts: f.ts }))
  return [...active, ...frozen].sort((a, b) => a.ts - b.ts)
}
