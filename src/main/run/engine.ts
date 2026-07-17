import type { ArtifactRef } from '../orchestrator/types'
import type { DevelopProject } from '../orchestrator/orchestrator'
import type { RunStore } from '../orchestrator/runStore'
import type { AgentProvider } from '../agents/types'
import { initMachine, markRunning, advance, currentStage, type RunPlan, type MachineState } from './machine'
import { buildWorkOrders, runStage, type StageInput } from './fanout'
import type { WorkOrderOutcome } from './workOrder'

export interface RunHeadlessDeps {
  providers: Record<string, AgentProvider>
  store: RunStore
  env: NodeJS.ProcessEnv
  projects: DevelopProject[]
  retries?: number
  sleep?: (ms: number) => Promise<void>
}
export interface RunHeadlessResult {
  state: MachineState
  outcomes: Record<string, WorkOrderOutcome[]>
  status: 'ok' | 'failed'
}

function upstreamArtifacts(store: RunStore, plan: RunPlan, uptoIndex: number): ArtifactRef[] {
  const refs: ArtifactRef[] = []
  for (let i = 0; i < uptoIndex; i++) {
    const got = store.getContext('artifacts:' + plan.stages[i].key) as ArtifactRef[] | undefined
    if (got) refs.push(...got)
  }
  return refs
}

function buildPrompt(o: { stageKey: string; project?: string; cwd: string; upstream: ArtifactRef[] }): string {
  const up = o.upstream.length ? `\n上游产物：\n${o.upstream.map((a) => `- ${a.path} (${a.kind})`).join('\n')}` : ''
  return `【阶段】${o.stageKey}${o.project ? `（项目 ${o.project}）` : ''}\ncwd=${o.cwd}${up}\n回传结构化结果。`
}

export async function runHeadless(plan: RunPlan, deps: RunHeadlessDeps): Promise<RunHeadlessResult> {
  let state = initMachine(plan)
  const outcomes: Record<string, WorkOrderOutcome[]> = {}

  while (true) {
    const cur = currentStage(state)
    if (!cur) break
    if (cur.status === 'done') break // reached the end (all done)

    state = markRunning(state)
    const idx = state.currentIndex
    const stage = plan.stages[idx]
    const workspacePath = deps.store.runDir.replace(/\/\.forge\/runs\/[^/]+$/, '')
    const input: StageInput = {
      stage, workspacePath, projects: deps.projects,
      upstream: upstreamArtifacts(deps.store, plan, idx), buildPrompt,
    }

    const orders = buildWorkOrders(input)
    // Invariant: a root-scope stage always yields exactly 1 order; a per-project stage requires
    // >=1 project to yield any. Silently proceeding with 0 orders would make `allOk` vacuously
    // true below and the stage would "complete" having done nothing — fail loudly instead.
    if (orders.length === 0) {
      throw new Error(`runHeadless: stage "${stage.key}" produced no work orders (a per-project stage requires >=1 project)`)
    }
    const stageOutcomes = await runStage(orders, (o) => ({
      provider: deps.providers[o.provider],
      env: deps.env,
      retries: deps.retries,
      sleep: deps.sleep,
    }))
    outcomes[stage.key] = stageOutcomes

    const refs: ArtifactRef[] = []
    for (const oc of stageOutcomes) {
      if (oc.status === 'ok' && oc.result) {
        const name = `${stage.key}-${oc.order.project ?? 'root'}.md`
        const ref = deps.store.writeArtifact(name, oc.result.summary)
        refs.push(ref)
      }
    }
    deps.store.setContext('artifacts:' + stage.key, refs)

    // stageOutcomes is always non-empty here: the guard above throws before this point if
    // buildWorkOrders produced zero orders, so runStage always ran on >=1 order.
    const allOk = stageOutcomes.every((o) => o.status === 'ok')
    if (!allOk) return { state, outcomes, status: 'failed' }

    state = advance(state)
    if (state.stages.every((s) => s.status === 'done')) break
  }

  return { state, outcomes, status: 'ok' }
}
