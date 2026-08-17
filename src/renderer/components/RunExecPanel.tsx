import { useEffect, useRef, useState, type ReactElement } from 'react'
import './workflowOverlay.css'
import type { Run2Api } from '../state/useRun2'
import type { RunControllerState } from '../../main/run/controller'
import type { AgentContextMeta, AgentRuntime } from '@shared/types'
import { AgentNode } from './AgentNode'
import { HookNode } from './HookNode'
import { FinalizeFailureCard } from './FinalizeFailureCard'
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
  // Filled (not outlined) rounded square — an empty outline reads as a broken/unloaded icon; a
  // solid glyph reads instantly as "stop", matching the universal stop-button convention.
  stop: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="none"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
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
// `titleOverride`/`statusOverride`: the conversational-workflow mirror (workflowProgressAdapter →
// staticState) reuses this whole panel verbatim, but its `.wfo-head` semantics differ from a real
// run — there's no temp branch and no live process to 暂停/终止 during a chat stage. When
// `statusOverride` is set, the header shows `titleOverride` as its title, hides the branch chip, and
// renders a single read-only status line (statusOverride) with no run-control buttons. Everything
// below the head (`.wfo-flow` staged pipe + AgentNode cards) is byte-for-byte the same beta.16 style.
// `logsOverride`: staticState-only lane-log injection. A conversational-workflow stage has no run2
// lane-log stream, but the user wants the right card to mirror the LEFT chat's live AI output as the
// stage's 执行过程 (same as img20). WorkspaceView builds `{ '<stageKey>:root': RunLogLine[] }` from the
// current AI message and passes it here; it replaces the empty `{}` the staticState path otherwise
// uses. Ignored for a live run2 (which has its own real laneLogs).
// `leadingDoneStages`: conversational-workflow stages that already completed BEFORE this run's
// fan-out tail (e.g. 技术方案设计). The execution tail is ONE run2 run over only [代码开发,写单测,代码CR],
// so the run's own plan doesn't know about the earlier design step — the panel would show 0/3 and
// drop 技术方案设计. Passing the earlier stages here renders them as leading 已完成 stage cards and folds
// them into the 已完成 N/M count + numbering, so the panel reads as the FULL workflow (1/4, design shown).
export function RunExecPanel({ run2, onAbort, staticState, readOnly, onViewLog, titleOverride, statusOverride, logsOverride, leadingDoneStages }: { run2?: Run2Api; onAbort?: () => void; staticState?: RunControllerState; readOnly?: boolean; onViewLog?: (agentId: string, agentName: string) => void; titleOverride?: string; statusOverride?: string; logsOverride?: Record<string, import('../../main/run/controller').RunLogLine[]>; leadingDoneStages?: { key: string; name: string; provider: string; model: string }[] }): ReactElement {
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
  // User feedback (2026-07-20): the temp-branch line is truncated with an ellipsis — let the user
  // click it to copy the FULL branch name, with a brief "已复制" confirmation.
  const [branchCopied, setBranchCopied] = useState(false)
  const liveRunId = state?.machine.plan.runId ?? null
  if (liveRunId !== lastRunIdRef.current) {
    lastRunIdRef.current = liveRunId
    memoryRef.current = new Map()
  }

  // A historical run has no live lane-log stream — an empty laneLogs just means each agent card
  // shows its final output only, no scrolling "recent activity" lines, which is correct for replay.
  const laneLogs = staticState ? (logsOverride ?? {}) : (run2?.laneLogs ?? {})
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

  const leadN = leadingDoneStages?.length ?? 0
  const doneN = leadN + state.machine.stages.filter((s) => s.status === 'done').length
  const totalStages = leadN + state.machine.stages.length
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
  // #7: a merge/discard/park failure at the finalize gate carries the STRUCTURED per-project detail
  // (branch names + conflict files — see FinalizeFailure's doc, controller.ts) the failure card needs;
  // `failedMessage` above stays as the plain-string fallback for every other failed-run shape (a real
  // stage failure, or a plain abort) that has no such detail to show.
  const finalizeFailures = state.finalizeFailure
  const showFinalizeFailureCard = runStatus === 'failed' && !!finalizeFailures?.length
  // #7 onHandoff judgment call (see this task's brief): the natural mechanism — resolveGate(gateId,
  // {type:'handoff'}) — needs the finalize gate's OWN event id, but that id is unreachable here. The
  // controller drops the finalize gate from `state.inbox` the instant its decision resolves
  // (controller.ts's runFinalizeGate: `this.drop(id)` runs right after `await p`, BEFORE it even
  // attempts merge/discard/park) — so by the time `state.finalizeFailure` is populated and this card
  // can render at all, the gate that failed is already gone from `state.inbox`; there is no live id
  // left for RunExecPanel to resolve against. `run2.discardResumable()` is what's actually reachable
  // through this component's own props (no gate id required — it operates on the on-disk resumable
  // record for this workspace, already bound via useRun2). It's a weaker guarantee than resolveGate's
  // handoff (it clears the SAVED resume record rather than marking the live run finalized through the
  // controller — see this task's brief for the distinction), but it achieves the same user-facing
  // effect here: the "上次收尾没完成，重新收尾？" banner stops re-offering this failure. (Task 7 also
  // fixed a latent gap in discardResumableRun/persist.ts that made this call a silent no-op for
  // exactly this terminal-but-unfinalized shape — see its own doc.)
  const handleHandoff = () => { void run2?.discardResumable() }
  // 重新收尾: re-run the SAME finalize gate without re-running any stage (the controller's main loop
  // sees every stage already `done` and drops straight back into runFinalizeGate — see
  // Run2Manager.resumeFromDisk/isUnfinalizedFailure). No new IPC needed: this is the exact call the
  // resumable banner's own 继续 button already makes (WorkspaceView.tsx).
  const handleRetryFinalize = () => { void run2?.resumeFromDisk() }
  // P4-2: machine.plan.tempBranch is now populated by planFromStages (forge/run-<runId>) for every run
  // start path; '—' only ever shows for a plan literal that predates this field (e.g. an older test).
  const tempBranch = state.machine.plan.tempBranch ?? '—'
  const totalAgents = allAgentIds.length

  // Progress redesign (user feedback): show the CURRENT position, not a "已完成 N/M" count. The bar
  // fills solid through the done stages; the stage in flight gets an animated flowing segment; when the
  // run is parked between stages (just advanced / paused / at a gate, next stage not yet started) a
  // text-caret blinks at the frontier to mark "we're here". leadStages are always already done, so the
  // current step in full-workflow numbering is doneN+1 while running.
  const curPlanStage = state.machine.plan.stages[state.machine.currentIndex]
  const curStageRunning = state.machine.stages[state.machine.currentIndex]?.status === 'running'
  const curStepNum = runDone ? totalStages : Math.min(doneN + 1, totalStages)
  const curStepName = runDone ? '全部阶段完成' : (curPlanStage?.name ?? '')
  const basePct = totalStages ? (doneN / totalStages) * 100 : 0
  const segPct = totalStages ? (1 / totalStages) * 100 : 0

  return (
    <div className="wfo-run-panel">
      <div className="wfo-head">
        <div className="wfo-title">
          <span className="tt">{titleOverride ?? (isReadOnly ? '历史运行回看' : '工作流执行中')}</span>
          {!statusOverride && (
            <button
              className={`wfo-branch${branchCopied ? ' copied' : ''}`}
              title={branchCopied ? '已复制' : '点击复制完整分支名'}
              onClick={() => {
                void navigator.clipboard?.writeText(tempBranch)
                setBranchCopied(true)
                setTimeout(() => setBranchCopied(false), 1500)
              }}
            >分支：{tempBranch}{branchCopied ? ' ✓ 已复制' : ''}</button>
          )}
        </div>
        <div className="wfo-prog">
          <span className="lbl">
            {runDone
              ? `已完成 ${doneN} / ${totalStages} 阶段`
              : <>第 <b>{curStepNum}</b> / {totalStages} 步{curStepName ? ` · ${curStepName}` : ''}</>}
          </span>
          <span className={`bar${curStageRunning && !runDone ? ' running' : ''}`}>
            <i className="fill" style={{ width: `${basePct}%` }} />
            {!runDone && curStageRunning && <i className="seg" style={{ left: `${basePct}%`, width: `${segPct}%` }} />}
            {!runDone && !curStageRunning && <span className="pcursor" style={{ left: `${basePct}%` }} />}
          </span>
        </div>
        {statusOverride ? (
          <div className="wfo-runctl done">
            <span className="rmsg">
              <span className="rd" />
              {statusOverride}
            </span>
          </div>
        ) : isReadOnly ? (
          <div className="wfo-runctl done">
            {runDone && showFinalizeFailureCard ? (
              <FinalizeFailureCard failures={finalizeFailures!} onHandoff={handleHandoff} onRetry={run2 ? handleRetryFinalize : undefined} />
            ) : (
              <span className="rmsg">
                <span className="rd" />
                {runDone ? (runStatus === 'failed' ? failedMessage : '工作流已完成 · 所有阶段通过，变更已就绪') : '只读回看 · 此运行未在此进程结束'}
              </span>
            )}
          </div>
        ) : runDone ? (
          <div className="wfo-runctl done">
            {showFinalizeFailureCard ? (
              <FinalizeFailureCard failures={finalizeFailures!} onHandoff={handleHandoff} onRetry={run2 ? handleRetryFinalize : undefined} />
            ) : (
              <span className="rmsg">
                <span className="rd" />
                {runStatus === 'failed' ? failedMessage : '工作流已完成 · 所有阶段通过，变更已就绪'}
              </span>
            )}
          </div>
        ) : (
          <div className="wfo-runctl">
            <span className="rmsg">
              <span className="rd" />
              {/* Fix 1 (honest pause): pause() only takes effect at the next STAGE BOUNDARY — an
                  in-flight stage's lanes keep running to completion (see controller.ts's start()
                  loop, which checks `this.paused` only at the top, before starting the next stage).
                  Swapping straight to "已暂停" while a lane is still visibly working would make the
                  user think pause silently failed. `runningIds` (computed above from the same
                  stage/lane state AgentNode renders) tells us whether anything is actually still
                  running right now, so the message always matches what the user sees on screen. */}
              <span>
                {runPaused
                  ? (runningIds.length > 0 ? '暂停中 · 本阶段完成后停下' : '已暂停')
                  : '正在执行…'}
              </span>
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
          {leadingDoneStages?.map((s, i) => (
            <div key={`lead-${s.key}`} className="stage ok">
              <div className="stage-head">
                <span className="stage-idx">{i + 1}</span>
                <span className="stage-name">{s.name}</span>
                <span className="stage-mode">单代理</span>
              </div>
              <div className="stage-agents">
                <AgentNode agent={{ id: `${s.key}:root`, name: '工作区', role: s.name, provider: s.provider, model: s.model, state: 'ok', logs: [] }} />
              </div>
            </div>
          ))}
          {(() => { let stageNo = leadN; return stages.map((stage) => {
            // ③stage hooks: a woven hook renders as a HookNode inline in the pipe (not a numbered
            // stage) — same as the legacy orchestrator's flow. Its single agent carries hook:true +
            // capability chips (see runExecAdapter.buildHookStage).
            if (stage.hook) {
              const agent = stage.agents[0]
              return (
                <div key={stage.key} className="stage hook-stage">
                  {agent && (
                    <HookNode
                      agent={agent}
                      open={effectiveOpenIds.has(agent.id)}
                      onToggle={() => handleToggle(agent.id)}
                    />
                  )}
                </div>
              )
            }
            const idx = stageNo++
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
                        // 日志台 button: a live run (not readOnly) filters the bottom drawer to this lane;
                        // the conversational-workflow mirror (isReadOnly via staticState, but marked by
                        // statusOverride) opens the drawer at current-session scope (its output is 主代理
                        // chat, not a run2 lane). A genuine historical replay is isReadOnly WITHOUT
                        // statusOverride — it has no live stream, so the button stays omitted even if a
                        // caller wired onViewLog.
                        onViewLog={(!isReadOnly || statusOverride) ? onViewLog : undefined}
                      />
                    ))
                  )}
                </div>
              </div>
            )
          }) })()}
        </div>
      </div>
    </div>
  )
}
