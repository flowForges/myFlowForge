import type { AgentRuntime, AgentState } from '@shared/types'
import type { StagePlan } from '../../main/run/machine'
import type { LiveLane, RunControllerState, RunLogLine } from '../../main/run/controller'
import type { WorkOrderOutcome } from '../../main/run/workOrder'

// P2-1b: maps run2's live `RunControllerState` (+ per-lane log buffers) onto the SAME
// `StageRuntime`/`AgentRuntime` shape the old orchestrator's 代理 tab rendered via `AgentNode`
// (see WorkspaceView.tsx's `#pane-agents` block, now retired). RunExecPanel.tsx drives the
// old tab's `.orch-note`/`.pipe`/`.stage`/`AgentNode` markup from this adapter's output instead
// of rebuilding a card.
//
// `AdaptedAgent` extends `AgentRuntime` with an internal `cwd` — AgentNode never reads it, but
// RunExecPanel needs it to best-effort load Skill/Rule/MCP chips via `scanContext(cwd)` (the
// same source the old flowchart RunExecPanel used through its `useNodeCaps` hook). Kept out of
// `@shared/types` since it's a render-time-only concern, not part of the AgentRuntime contract.
export interface AdaptedAgent extends AgentRuntime {
  cwd?: string
}
export interface AdaptedStage {
  key: string
  name: string
  state: AgentState
  agents: AdaptedAgent[]
}

// Per-project fan-out memory, one entry per project ever seen in a stage THIS run — so a lane
// that has already settled/gone quiet (no fresh liveLanes/outcomes entry this tick, a real gap
// that can happen between the previous order settling and the next progress event) doesn't
// disappear from the panel. Mirrors the old RunExecPanel's `CodeLane` memory (`buildCodeLanes`).
export interface LaneMemory {
  state: AgentState
  cwd?: string
  provider: string
  model: string
}

function decisionAgentState(laneId: string, stageKey: string, state: RunControllerState): AgentState | null {
  const hasFailure = state.inbox.some((e) => e.kind === 'failure' && e.laneId === laneId)
  if (hasFailure) return 'err'
  const hasAwaiting = state.inbox.some(
    (e) =>
      (e.kind === 'gate' && e.stageKey === stageKey) ||
      ((e.kind === 'auth' || e.kind === 'question' || e.kind === 'doubt') && e.laneId === laneId)
  )
  if (hasAwaiting) return 'awaiting'
  return null
}

// Stage-level aggregate (drives StageRuntime.state / the `.stage` card's state class) — a stage
// is 'err'/'awaiting' if ANY of its lanes/events say so, 'ok' only once the machine (or every
// outcome) says the whole stage is done. Verbatim logic port of the old RunExecPanel's
// `stageRunState`, just re-targeted at the `AgentState` vocabulary AgentNode expects.
function stageAgentState(stageKey: string, state: RunControllerState): AgentState {
  const outcomes = state.outcomes[stageKey]
  const hasFailedOutcome = outcomes?.some((o) => o.status === 'failed') ?? false
  const hasFailureEvent = state.inbox.some((e) => e.kind === 'failure' && e.stageKey === stageKey)
  if (hasFailedOutcome || hasFailureEvent) return 'err'
  const hasDecisionEvent = state.inbox.some(
    (e) => (e.kind === 'auth' || e.kind === 'gate' || e.kind === 'question' || e.kind === 'doubt') && e.stageKey === stageKey
  )
  if (hasDecisionEvent) return 'awaiting'
  const machineStatus = state.machine.stages.find((s) => s.key === stageKey)?.status
  const hasOkOutcome = outcomes?.some((o) => o.status === 'ok') ?? false
  if (machineStatus === 'done' || hasOkOutcome) return 'ok'
  if (machineStatus === 'running') return 'run'
  return 'wait'
}

// Root-scope stage (sp.scope === 'root') = a single agent card representing the whole stage.
// laneId is `${stageKey}:root` (matches fanout.ts's buildWorkOrders id for root orders, and thus
// every RunEvent.laneId / liveLanes key / RunLogLine.laneId for this stage). No `project` to
// name it after, so it takes the stage's own name (see task note: "single-order stage has no
// project — use the stage name").
function buildRootAgent(sp: StagePlan, state: RunControllerState, laneLogs: Record<string, RunLogLine[]>): AdaptedAgent {
  const laneId = `${sp.key}:root`
  const outcome = (state.outcomes[sp.key] ?? [])[0]
  const live = state.liveLanes[laneId] as LiveLane | undefined
  const decision = decisionAgentState(laneId, sp.key, state)
  const machineStatus = state.machine.stages.find((s) => s.key === sp.key)?.status

  let agentState: AgentState
  if (outcome) agentState = outcome.status === 'ok' ? 'ok' : 'err'
  else if (decision) agentState = decision
  else if (live) agentState = 'run'
  else if (machineStatus === 'done') agentState = 'ok'
  else if (machineStatus === 'running') agentState = 'run'
  else agentState = 'wait'

  return {
    id: laneId,
    name: sp.name,
    role: sp.name,
    provider: outcome?.order.provider ?? sp.provider,
    model: outcome?.order.model ?? sp.model,
    state: agentState,
    logs: (laneLogs[laneId] ?? []).map((r) => r.line),
    cwd: live?.cwd ?? outcome?.order.cwd,
  }
}

// Per-project fan-out (sp.scope === 'per-project') — one agent card per project lane. Union of
// memory (every project seen so far this run) ∪ settled outcomes ∪ still-live lanes, ordered by
// first encounter, same combining rule as the old RunExecPanel's `buildCodeLanes`.
function buildFanoutAgents(
  sp: StagePlan,
  state: RunControllerState,
  laneLogs: Record<string, RunLogLine[]>,
  memory: Map<string, LaneMemory>
): AdaptedAgent[] {
  const outcomeByProject = new Map<string, WorkOrderOutcome>()
  for (const o of state.outcomes[sp.key] ?? []) {
    if (o.order.project) outcomeByProject.set(o.order.project, o)
  }
  const liveByProject = new Map<string, LiveLane>()
  for (const laneId of Object.keys(state.liveLanes)) {
    const l = state.liveLanes[laneId]
    if (l.stageKey === sp.key && l.project) liveByProject.set(l.project, l)
  }
  const present = [...memory.keys(), ...outcomeByProject.keys(), ...liveByProject.keys()]
  const ordered: string[] = []
  for (const n of present) if (!ordered.includes(n)) ordered.push(n)

  return ordered.map((project) => {
    const laneId = `${sp.key}:${project}`
    const outcome = outcomeByProject.get(project)
    const live = liveByProject.get(project)
    const prior = memory.get(project)
    const decision = decisionAgentState(laneId, sp.key, state)

    let agentState: AgentState
    if (outcome) agentState = outcome.status === 'ok' ? 'ok' : 'err'
    else if (decision) agentState = decision
    else if (live) agentState = 'run'
    // Genuinely new (never in memory, no outcome/live this tick) → assume still starting up;
    // otherwise fall back to the last-known state through the momentary gap (see LaneMemory doc).
    else agentState = prior?.state ?? 'run'

    const provider = outcome?.order.provider ?? sp.provider
    const model = outcome?.order.model ?? sp.model
    const cwd = live?.cwd ?? outcome?.order.cwd ?? prior?.cwd

    memory.set(project, { state: agentState, cwd, provider, model })

    return {
      id: laneId,
      name: project,
      role: sp.name,
      provider,
      model,
      state: agentState,
      logs: (laneLogs[laneId] ?? []).map((r) => r.line),
      cwd,
    }
  })
}

function getStageMemory(memoryByStage: Map<string, Map<string, LaneMemory>>, stageKey: string): Map<string, LaneMemory> {
  let m = memoryByStage.get(stageKey)
  if (!m) {
    m = new Map()
    memoryByStage.set(stageKey, m)
  }
  return m
}

/**
 * Build the `AdaptedStage[]` RunExecPanel renders as `.pipe > .stage > .stage-agents > AgentNode`,
 * from run2's `RunControllerState` + per-lane log buffers.
 *
 * `memoryByStage` is caller-owned (RunExecPanel keeps one in a ref, reset when `runId` changes) so
 * fan-out lanes persist across the momentary gaps described in `LaneMemory`'s doc comment; omit it
 * (as adapter unit tests do) for a stateless one-shot mapping.
 */
export function buildStageRuntimes(
  state: RunControllerState,
  laneLogs: Record<string, RunLogLine[]>,
  memoryByStage: Map<string, Map<string, LaneMemory>> = new Map()
): AdaptedStage[] {
  return state.machine.plan.stages.map((sp) => {
    const agents =
      sp.scope === 'per-project'
        ? buildFanoutAgents(sp, state, laneLogs, getStageMemory(memoryByStage, sp.key))
        : [buildRootAgent(sp, state, laneLogs)]
    return { key: sp.key, name: sp.name, state: stageAgentState(sp.key, state), agents }
  })
}
