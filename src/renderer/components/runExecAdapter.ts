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
  // Spec §5.2: a jump-back (`machine.ts`'s `jumpBack`) marks every downstream 'done' stage
  // 'stale' in the machine — its prior output isn't deleted, just invalidated until the flow
  // moves forward again and re-runs it. Kept as a separate flag rather than folding into
  // `AgentState` (which has no 'stale' member and is shared with AgentNode's per-agent
  // rendering, which doesn't need this concept) — see this task's note on preferring an
  // explicit flag over overloading the state enum.
  stale?: boolean
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
// is 'err'/'awaiting' if ANY of its lanes/events say so, 'ok' only once the machine says the whole
// stage is done OR every known lane (root's single agent, or every fan-out project lane already
// enumerated into `agents`) has itself settled 'ok'. A single fan-out lane settling while a sibling
// is still 'run' is the typical mid-run state for a parallel stage, not completion — see this
// task's finding: a naive "any outcome is ok" check flipped the `.stage` header to done styling
// while an `AgentNode` right below it still showed 执行中.
function stageAgentState(stageKey: string, state: RunControllerState, agents: AdaptedAgent[]): AgentState {
  const outcomes = state.outcomes[stageKey]
  const hasFailedOutcome = outcomes?.some((o) => o.status === 'failed') ?? false
  const hasFailureEvent = state.inbox.some((e) => e.kind === 'failure' && e.stageKey === stageKey)
  if (hasFailedOutcome || hasFailureEvent) return 'err'
  const hasDecisionEvent = state.inbox.some(
    (e) => (e.kind === 'auth' || e.kind === 'gate' || e.kind === 'question' || e.kind === 'doubt') && e.stageKey === stageKey
  )
  if (hasDecisionEvent) return 'awaiting'
  const machineStatus = state.machine.stages.find((s) => s.key === stageKey)?.status
  if (machineStatus === 'done') return 'ok'
  const allLanesOk = agents.length > 0 && agents.every((a) => a.state === 'ok')
  if (allLanesOk) return 'ok'
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

  const timing = state.laneTimings?.[laneId]

  return {
    id: laneId,
    name: sp.name,
    role: sp.name,
    // `||` (not `??`): a resumed `done` stage's outcome is a placeholder (see controller.ts's
    // placeholderOutcome, P-C2/T1 review Finding 2) whose provider/model/cwd are '' — not absent —
    // so `??` would never fall back to the stage plan and the resumed card would show blank fields.
    // A real (non-placeholder) outcome's order always carries non-empty values (see fanout.ts), so
    // this never changes behavior on the normal path.
    provider: outcome?.order.provider || sp.provider,
    model: outcome?.order.model || sp.model,
    state: agentState,
    logs: (laneLogs[laneId] ?? []).map((r) => r.line),
    cwd: live?.cwd || outcome?.order.cwd,
    laneStartedAt: timing?.startedAt,
    laneEndedAt: timing?.endedAt,
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
  // UX2 Fix 4: `state.projects` is the run's selected DevelopProject[] subset (P-C2/⑤) — seed the
  // lane list with it FIRST so a per-project stage that hasn't started yet (PENDING, nothing in
  // outcomes/liveLanes/memory) still shows a card per selected project instead of the panel's
  // "暂无代码项目在此阶段运行" empty state (which should now only fire when no project was selected
  // at all — see the dedup loop below, which just unions everything by first-seen order).
  const selectedProjects = (state.projects ?? []).map((p) => p.name)
  const present = [...selectedProjects, ...memory.keys(), ...outcomeByProject.keys(), ...liveByProject.keys()]
  const ordered: string[] = []
  for (const n of present) if (!ordered.includes(n)) ordered.push(n)

  // Stage-level machine status — distinguishes a genuinely-running fan-out (a not-yet-started lane
  // is assumed to be starting up, i.e. 'run') from a PENDING/stale stage (a seeded-but-unstarted
  // project must show 'wait', not 'run' — see stageAgentState's same machineStatus lookup).
  const machineStatus = state.machine.stages.find((s) => s.key === sp.key)?.status

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
    // Fall back to the last-known state through a momentary gap (see LaneMemory doc); a genuinely
    // new lane (never seen before) is 'run' only while its stage is actually running (still assumed
    // starting up) — a project seeded from `state.projects` before the stage has even started
    // (pending/stale) must show 'wait' instead (Fix 4), matching the 等待 root-stage cards.
    else agentState = prior?.state ?? (machineStatus === 'running' ? 'run' : 'wait')

    // `||` (not `??`) for the same reason as buildRootAgent above — a resumed `done` stage's
    // placeholder outcome carries '' for provider/model/cwd, not absent (P-C2/T1 review Finding 2).
    const provider = outcome?.order.provider || sp.provider
    const model = outcome?.order.model || sp.model
    const cwd = live?.cwd || outcome?.order.cwd || prior?.cwd
    const timing = state.laneTimings?.[laneId]

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
      laneStartedAt: timing?.startedAt,
      laneEndedAt: timing?.endedAt,
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
    const machineStatus = state.machine.stages.find((s) => s.key === sp.key)?.status
    return {
      key: sp.key,
      name: sp.name,
      state: stageAgentState(sp.key, state, agents),
      agents,
      stale: machineStatus === 'stale',
    }
  })
}
