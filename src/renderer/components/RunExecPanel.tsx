import { useEffect, useRef, useState, type ReactElement } from 'react'
import './workflowOverlay.css'
import type { Run2Api } from '../state/useRun2'
import type { RunControllerState } from '../../main/run/controller'
import type { AgentContextMeta, AgentRuntime } from '@shared/types'
import { AgentNode } from './AgentNode'
import { buildStageRuntimes, type AdaptedAgent, type LaneMemory } from './runExecAdapter'

// P2-1b: right-side run-execution display. Rebuilt to reuse the OLD 代理-tab style (inspector-
// width-native `.orch-note`/`.orch-bar`/`.pipe`/`.stage`/`AgentNode`, formerly
// WorkspaceView.tsx's `#pane-agents` block, gated on the retired orchestrator `run`) instead of
// the wide floating-overlay flowchart (`.wfo-chart`/`.wfo-node`/`.wfo-term` + connectors) the
// previous version of this file ported from WorkflowOverlay.tsx. The user rejected the flowchart
// look; `runExecAdapter.ts` now maps run2 state onto the same `AgentRuntime`/stage shape the old
// tab consumed, and `AgentNode` is reused VERBATIM (not rebuilt) for each card.
//
// DISPLAY ONLY — every per-node/per-lane DECISION action (gate/auth/failure/question resolution)
// is deliberately absent; those become chat cards in a later task (P3). Run-LEVEL controls
// (暂停/继续/终止) are kept in the `.wfo-head` progress header since they aren't per-node decisions.

const IC = {
  // width/height are load-bearing here — an un-sized inline <svg> defaults to a ~300x150px replaced
  // element, which is what made the old 终止 button render as a giant square with its label wrapping
  // underneath (see the `.wfo-btn svg` sizing rule in workflowOverlay.css for the CSS-side backstop).
  stop: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2.4"/></svg>',
}

function Icon({ svg }: { svg: string }) {
  return <span dangerouslySetInnerHTML={{ __html: svg }} />
}

// Same scanContext-backed cwd->caps cache as the old flowchart RunExecPanel's `useNodeCaps` —
// best-effort only: a scan failure or missing `window.forge.scanContext` just means the card
// renders with no Skill/Rule/MCP chips, never a crash.
const nodeCapsCache = new Map<string, AgentContextMeta>()

function useNodeCaps(cwd: string | undefined): AgentContextMeta | null {
  const [meta, setMeta] = useState<AgentContextMeta | null>(() => (cwd ? nodeCapsCache.get(cwd) ?? null : null))
  useEffect(() => {
    if (!cwd) {
      setMeta(null)
      return
    }
    const cached = nodeCapsCache.get(cwd)
    if (cached) {
      setMeta(cached)
      return
    }
    const scan = (window as any).forge?.scanContext
    if (!scan) return
    let alive = true
    scan(cwd)
      .then((m: AgentContextMeta) => {
        if (!m) return
        nodeCapsCache.set(cwd, m)
        if (alive) setMeta(m)
      })
      .catch(() => { /* best-effort — see cache comment above */ })
    return () => {
      alive = false
    }
  }, [cwd])
  return meta
}

// Thin wrapper around the reused `AgentNode` — loads Skill/Rule/MCP chips for this agent's `cwd`
// (via `useNodeCaps`, a stable per-component-instance hook call) and merges them onto the runtime
// object AgentNode actually renders, so AgentNode itself needs no awareness of run2/scanContext.
function AgentNodeWithCaps({ agent, open, onToggle, live, onViewLog }: { agent: AdaptedAgent; open: boolean; onToggle: () => void; live: boolean; onViewLog?: (agentId: string, agentName: string) => void }) {
  const caps = useNodeCaps(agent.cwd)
  const hasCaps = !!caps && (caps.skills.length > 0 || caps.rules.length > 0 || (caps.mcps?.length ?? 0) > 0)
  const runtime: AgentRuntime = hasCaps
    ? { ...agent, context: { skills: caps!.skills, rules: caps!.rules, mcps: caps!.mcps } }
    : agent
  return (
    <AgentNode
      agent={runtime}
      open={open}
      onToggle={onToggle}
      live={live}
      onViewLog={onViewLog ? () => onViewLog(agent.id, agent.name) : undefined}
    />
  )
}

// `.stage` card state class — only 'run'/'ok'/'err' are styled distinctly in workspace.css
// (mirrors the old WorkspaceView's STATE_IDX_MAP); 'wait'/'awaiting'/'stalled' get no extra class.
const STAGE_STATE_CLS: Record<string, string> = { run: 'run', ok: 'ok', err: 'err' }

// Spec §12.7 (run-history): `staticState`/`readOnly` let a caller show a HISTORICAL run's saved
// state (loaded via run2:load-run, adapted by runHistoryAdapter.ts) through the exact same card/
// stage rendering as a live run, without needing a live `Run2Api` — `run2` becomes optional and is
// only consulted for state/logs/abort when `staticState` is absent. `readOnly` independently hides
// the run-level 暂停/继续/终止 controls (a historical run has no live process to control) — kept as a
// separate flag rather than always-derived-from-staticState in case a future caller wants read-only
// display of a still-LIVE run without also faking its state.
export function RunExecPanel({ run2, onAbort, staticState, readOnly, onViewLog }: { run2?: Run2Api; onAbort?: () => void; staticState?: RunControllerState; readOnly?: boolean; onViewLog?: (agentId: string, agentName: string) => void }): ReactElement {
  // Per-stage `project -> last-known LaneMemory` so a fan-out lane never disappears once observed
  // (see runExecAdapter's LaneMemory doc). Reset whenever the run identity changes.
  const memoryRef = useRef<Map<string, Map<string, LaneMemory>>>(new Map())
  const lastRunIdRef = useRef<string | null>(null)
  const state = staticState ?? run2?.state ?? null
  // Minor guard: a `staticState` (historical/loaded run) has no live `run2` process behind it even
  // if a future caller forgets to also pass `readOnly` — treat it as read-only for every decision
  // that assumes a live process (run-level controls below, and the per-lane elapsed pill in
  // AgentNode, which must not tick a crashed/never-finished lane against `Date.now()`).
  const isReadOnly = readOnly || !!staticState
  const liveRunId = state?.machine.plan.runId ?? null
  if (liveRunId !== lastRunIdRef.current) {
    lastRunIdRef.current = liveRunId
    memoryRef.current = new Map()
  }

  // A historical run has no live lane-log stream — an empty laneLogs just means each agent card
  // shows its final output only, no scrolling "recent activity" lines, which is correct for replay.
  const laneLogs = staticState ? {} : (run2?.laneLogs ?? {})
  const stages = state ? buildStageRuntimes(state, laneLogs, memoryRef.current) : []
  const allAgentIds = stages.flatMap((s) => s.agents.map((a) => a.id))
  const runningIds = stages.flatMap((s) => s.agents.filter((a) => a.state === 'run').map((a) => a.id))

  // Open/close state mirrors WorkspaceView's old openIds/closedIds/effectiveOpenIds/handleToggle:
  // user-toggled state is remembered in two sets, and any currently-running agent is force-open
  // unless the user explicitly closed it.
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set(runningIds))
  const [closedIds, setClosedIds] = useState<Set<string>>(new Set())

  const effectiveOpenIds = new Set(openIds)
  runningIds.forEach((id) => { if (!closedIds.has(id)) effectiveOpenIds.add(id) })
  const allOpen = allAgentIds.length > 0 && allAgentIds.every((id) => effectiveOpenIds.has(id))

  const handleExpandAll = () => {
    if (allOpen) {
      setOpenIds(new Set())
      setClosedIds(new Set(allAgentIds))
    } else {
      setOpenIds(new Set(allAgentIds))
      setClosedIds(new Set())
    }
  }
  const handleToggle = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev)
      allAgentIds.forEach((aid) => { if (effectiveOpenIds.has(aid)) next.add(aid) })
      if (next.has(id)) {
        next.delete(id)
        setClosedIds((c) => new Set(c).add(id))
      } else {
        next.add(id)
        setClosedIds((c) => { const n = new Set(c); n.delete(id); return n })
      }
      return next
    })
  }

  if (!state) {
    return (
      <div className="wfo-run-panel">
        <div className="wfo-head">
          <div className="wfo-prog">
            <span className="lbl">无正在运行的工作流</span>
          </div>
        </div>
      </div>
    )
  }

  const doneN = state.machine.stages.filter((s) => s.status === 'done').length
  const totalStages = state.machine.stages.length
  const pct = totalStages ? Math.round((doneN / totalStages) * 100) : 0
  const runStatus = state.status
  const runDone = runStatus === 'ok' || runStatus === 'failed'
  const runPaused = !!state.paused
  // Finding 1: a failed run can mean very different things — a finalize-gate merge/discard
  // conflict (state.error, no stage actually failed: every stage is done/100%), a genuine
  // per-lane stage failure (a WorkOrderOutcome with status 'failed' somewhere in outcomes), or a
  // plain user abort (neither). Never let the hardcoded "存在失败阶段" text fire for the first or
  // third case — it actively lies about what happened.
  const hasRealStageFailure = Object.values(state.outcomes).some((outs) => outs.some((o) => o.status === 'failed'))
  const failedMessage = state.error
    ? state.error
    : hasRealStageFailure
      ? '工作流已结束 · 存在失败阶段，请检查后处理'
      : '工作流已结束'
  // P4-2: machine.plan.tempBranch is now populated by planFromStages (forge/run-<runId>) for every run
  // start path; '—' only ever shows for a plan literal that predates this field (e.g. an older test).
  const tempBranch = state.machine.plan.tempBranch ?? '—'
  const totalAgents = allAgentIds.length

  return (
    <div className="wfo-run-panel">
      <div className="wfo-head">
        <div className="wfo-title">
          <span className="tt">{isReadOnly ? '历史运行回看' : '工作流执行中'}</span>
          <span className="wfo-branch">分支：{tempBranch}</span>
        </div>
        <div className="wfo-prog">
          <span className="lbl">已完成 {doneN} / {totalStages}</span>
          <span className="bar"><i style={{ width: `${pct}%` }} /></span>
          <span className="pct">{pct}%</span>
        </div>
        {isReadOnly ? (
          <div className="wfo-runctl done">
            <span className="rmsg">
              <span className="rd" />
              {runDone ? (runStatus === 'failed' ? failedMessage : '工作流已完成 · 所有阶段通过，变更已就绪') : '只读回看 · 此运行未在此进程结束'}
            </span>
          </div>
        ) : runDone ? (
          <div className="wfo-runctl done">
            <span className="rmsg">
              <span className="rd" />
              {runStatus === 'failed' ? failedMessage : '工作流已完成 · 所有阶段通过，变更已就绪'}
            </span>
          </div>
        ) : (
          <div className="wfo-runctl">
            <span className="rmsg">
              <span className="rd" />
              <span>正在执行…</span>
            </span>
            <span className="wfo-runctl-btns">
              {runPaused ? (
                <button className="wfo-btn ghost sm" onClick={() => run2?.resume()}>继续</button>
              ) : runStatus === 'running' ? (
                <button className="wfo-btn ghost sm" onClick={() => run2?.pause()}>暂停</button>
              ) : null}
              {/* P4-3: prefer the caller's onAbort (WorkspaceView wires one that records a "运行已终止"
                  timeline marker before aborting — see its doc) so a pending gate/auth/question/
                  doubt/failure card doesn't just silently vanish; falls back to a bare run2.abort()
                  for callers that don't need that (e.g. this component's own unit tests). */}
              <button className="wfo-btn danger sm" onClick={() => (onAbort ?? run2?.abort)?.()}>
                <Icon svg={IC.stop} /> 终止
              </button>
            </span>
          </div>
        )}
      </div>

      <div className="wfo-flow">
        <div className="orch-note">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
          <span>
            <b>主代理</b> 已编排 <b>{totalAgents}</b> 个子代理 · 点击任意节点查看执行过程
          </span>
        </div>
        <div className="orch-bar">
          <span className="orch-legend">
            <i className="run">执行中</i>
            <i className="ok">完成</i>
            <i className="wait">等待</i>
          </span>
          <span className="grow" />
          <button className="txt-btn" onClick={handleExpandAll}>
            {allOpen ? '收起全部' : '展开全部'}
          </button>
        </div>

        <div className="pipe">
          {stages.map((stage, idx) => {
            const n = stage.agents.length
            const isParallel = n > 1
            const stageMode = isParallel ? `并行 · ${n} 代理` : '单代理'
            const stCls = STAGE_STATE_CLS[stage.state] ?? ''
            return (
              <div key={stage.key} className={`stage${stCls ? ' ' + stCls : ''}${isParallel ? ' parallel' : ''}`}>
                <div className="stage-head">
                  <span className="stage-idx">{idx + 1}</span>
                  <span className="stage-name">{stage.name}</span>
                  {stage.stale && (
                    <span className="stage-stale" title="回退到更早阶段后，此阶段的产出已失效，流程推进到此处时会重新执行">
                      已失效
                    </span>
                  )}
                  <span className="stage-mode">{stageMode}</span>
                </div>
                <div className={`stage-agents${isParallel ? ' parallel' : ''}`}>
                  {isParallel && (
                    <div className="conc-tag"><span className="conc-pulse" />{n} 个代理同时执行</div>
                  )}
                  {stage.agents.length === 0 ? (
                    <div style={{ padding: '4px 0', fontSize: 12, color: 'var(--muted)' }}>暂无代码项目在此阶段运行。</div>
                  ) : (
                    stage.agents.map((agent) => (
                      <AgentNodeWithCaps
                        key={agent.id}
                        agent={agent}
                        open={effectiveOpenIds.has(agent.id)}
                        onToggle={() => handleToggle(agent.id)}
                        live={!isReadOnly}
                        // A historical/read-only run has no live lane-log stream (see the `laneLogs`
                        // comment above) — the bottom 实时日志 drawer has nothing to show for it, so
                        // omit the 日志台 button entirely rather than open an empty drawer.
                        onViewLog={isReadOnly ? undefined : onViewLog}
                      />
                    ))
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
