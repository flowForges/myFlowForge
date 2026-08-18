import { useEffect, useRef, useState, type ReactElement } from 'react'
import './workflowOverlay.css'
import type { Run2Api } from '../state/useRun2'
import type { RunControllerState } from '../../main/run/controller'
import type { GateEvent } from '../../main/run/events'
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
  // #7 fix round 1 (F3): must be declared here (with the panel's other useState calls), NOT down by
  // its point of use below — that point sits after the `if (!state) return` early-return guard, and a
  // hook can never be conditional on that (Rules of Hooks). See its point-of-use comment for why it
  // exists.
  const [handoffAckedRunId, setHandoffAckedRunId] = useState<string | null>(null)
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
  //
  // #7 fix round 1 (F1/F2, review): NOT gated on `runStatus === 'failed'` alone — `state.finalizeFailure`
  // legitimately outlives that status across a 重新收尾 retry. `resumeFromDisk` rebuilds a brand-new
  // controller that rehydrates the PREVIOUS attempt's `finalizeFailure` (see controller.ts's
  // RehydrateState) and immediately re-raises a FRESH finalize gate (status flips to 'awaiting') —
  // this card must stay visible through that window too, both to keep showing the branch/conflict
  // detail and because that fresh gate's live id is exactly what makes `resolveGate`-based handoff
  // reachable (see `pendingFinalizeGate` below). A clean retry clears both fields (F6, this task) so
  // this naturally goes away the moment the run actually finishes.
  // #7 fix round 2 (N3): `runStatus !== 'ok'` guard added back — F6 only stops NEW `{status:'ok',
  // finalizeFailure:[…]}` states from being written; it does not migrate whatever's ALREADY sitting
  // on a real user's disk from before this task. Without this guard, an old saved 'ok' run replayed
  // in 运行历史 (RunHistoryPanel → staticState) would show 无法自动合并 in place of the correct
  // 工作流已完成 message. 'awaiting' (the retry-pending window F2 needs) and 'failed' both still pass.
  const finalizeFailures = state.finalizeFailure
  const showFinalizeFailureCard = !!finalizeFailures?.length && runStatus !== 'ok'
  // #7 fix round 1 (F1/F2): the finalize gate currently sitting live in `state.inbox`, if any — this
  // is what makes `resolveGate(id, {type:'handoff'})` reachable. It's null for the FIRST failed
  // attempt (runFinalizeGate drops the gate from `state.inbox` — `this.drop(id)` — the instant its
  // decision resolves, BEFORE it even attempts merge/discard/park, so the id is already gone by the
  // time a failure and this card can exist at all) but LIVE again once 重新收尾 re-raises a fresh gate
  // (controller.ts's runFinalizeGate, re-entered via Run2Manager.resumeFromDisk). Task 7 round 0's
  // original call — always falling back to `discardResumable()` — missed this second case entirely,
  // permanently erasing the run record (see F1) even when a resolvable gate existed.
  const pendingFinalizeGate = state.inbox.find(
    (e): e is GateEvent => e.kind === 'gate' && !!e.finalize,
  )
  // #7 fix round 1 (F3): local, run-scoped "the click landed" flag (declared up with the panel's
  // other useState calls, before the `if (!state) return` guard — see there). Both routes below are
  // otherwise invisible to this card: `discardResumable()` only touches ON-DISK state (`useRun2`'s
  // `resumable` is already null in the same session the failure just happened in, so even the
  // optimistic `setResumable(null)` it does is a no-op here — see useRun2.ts), and `resolveGate`'s
  // real effect arrives asynchronously via the next `state` update. Keyed to `liveRunId` (not a plain
  // boolean) so a LATER run in the same mounted panel doesn't inherit a stale "acked" flag.
  const handoffAcked = handoffAckedRunId !== null && handoffAckedRunId === liveRunId
  // #7 fix round 1 (F1/F2) onHandoff routing: prefer resolveGate against a LIVE pending finalize gate
  // (keeps the saved run record — controller.ts's handoff branch sets `finalized/finalizeHandedOff`
  // but never touches `finalizeFailure`/history) and fall back to discardResumable (F1: this ERASES
  // the record — persist.ts's discardResumableRun deletes the whole saved context.json) only when no
  // such gate exists to resolve against.
  const handleHandoff = () => {
    if (pendingFinalizeGate) {
      run2?.resolveGate(pendingFinalizeGate.id, { type: 'handoff' })
    } else {
      void run2?.discardResumable()
    }
    setHandoffAckedRunId(liveRunId)
  }
  // #7 fix round 1 (F2): the fallback route DELETES the saved run record — say so before the click,
  // not after. Only shown when that's actually what will happen (no live gate to resolve against).
  const HANDOFF_ERASES_RECORD_WARNING = '没有可继续的收尾确认了，点击将清除这条运行记录（不会再出现在运行历史里）——上面列出的分支和改动不受影响，仍然完整保留，可以随时手工合并。'
  // #7 fix round 2 (N2): mirrors persist.ts's isUnfinalizedFailure predicate exactly — the SAME
  // shape discardResumableRun's own guard (`isTerminalStatus && !isUnfinalizedFailure` → refuse)
  // requires before it will actually delete anything. Without this, the erase-record warning could
  // fire (and threaten a deletion) for a run that's already `finalized` (e.g. re-rendered after a
  // resolveGate handoff already succeeded) — discardResumable would be a harmless no-op there, so
  // warning about a deletion is simply false in that state.
  const isDiscardableShape = runStatus === 'failed' && !state.finalized && state.machine.stages.every((s) => s.status === 'done')
  // 重新收尾: re-run the SAME finalize gate without re-running any stage (the controller's main loop
  // sees every stage already `done` and drops straight back into runFinalizeGate — see
  // Run2Manager.resumeFromDisk/isUnfinalizedFailure). No new IPC needed: this is the exact call the
  // resumable banner's own 继续 button already makes (WorkspaceView.tsx). Withheld while a finalize
  // gate is already pending (retrying AGAIN would just throw — Run2Manager.resumeFromDisk refuses a
  // workspace that already has a live controller).
  const handleRetryFinalize = () => { void run2?.resumeFromDisk() }
  // #7 fix round 1 (F1-F3): the single render for this whole block, reused across the terminal-failed
  // case (replaces the plain failedMessage text below, unchanged from round 0) AND the 重新收尾-pending
  // 'awaiting' case (F2, additive — the pause/resume/abort row it's not replacing anything wrong).
  // `null` whenever there's nothing to show, so every call site below can just splice it in.
  const finalizeFailureBlock = !showFinalizeFailureCard ? null : handoffAcked ? (
    <div className="msg-req k-gate ff-card ff-acked">
      <div className="req-head"><span className="req-kind">已记录 · 交给你自己处理</span></div>
      <div className="req-body">
        <div className="ff-line">
          改动仍完整保留在上面列出的分支上，不受影响 —— 按给出的命令手工合并即可。
        </div>
      </div>
    </div>
  ) : (
    <FinalizeFailureCard
      failures={finalizeFailures!}
      // #7 fix round 2 (N1): omit entirely with no live run2 — RunHistoryPanel.tsx renders
      // <RunExecPanel staticState readOnly> with NO run2 for a saved run whose finalizeFailure is
      // still on disk. Without this, the button's click was already a no-op (both `resolveGate` and
      // `discardResumable` no-op on `run2?.`), but round 1's F3 fix made THAT no-op swap the card to
      // "已记录 · 交给你自己处理" — a straight false claim on a page whose entire premise is not
      // lying about the state of the user's run. FinalizeFailureCard hides the button whenever
      // `onHandoff` is undefined (see its own doc).
      // #7 fix round 3: `run2 ?` alone isn't enough — it's true throughout the retry pre-gate
      // window too (between clicking 重新收尾 and the fresh finalize gate landing in state.inbox,
      // seconds to a minute wide: resumeFromDisk() re-enters the controller synchronously, but
      // runFinalizeGate() is only reached after runHooksAfter('__wf') + buildRunSummary(), a real
      // provider call). In that window neither route handleHandoff can take actually does anything:
      // resolveGate has no pending gate id yet (pendingFinalizeGate null), and discardResumable's
      // own guard (persist.ts's isUnfinalizedFailure) refuses because a live controller already
      // owns the workspace (isDiscardableShape false — status is still 'running', not 'failed').
      // Only offer the button when a click can actually land: a live gate to resolve against, OR
      // the terminal discardable-failure shape discardResumableRun's own guard requires. The card
      // itself (and 重新收尾) stays visible either way — only this button disappears.
      onHandoff={run2 && (pendingFinalizeGate || isDiscardableShape) ? handleHandoff : undefined}
      onRetry={!pendingFinalizeGate && run2 ? handleRetryFinalize : undefined}
      // Only true when a click here will ACTUALLY erase the record: run2 bound, no live gate to
      // resolve against instead (else it's a no-op in pure read-only replay — dishonest to warn
      // about a deletion that can't happen), AND the run is still in the shape discardResumableRun's
      // own guard requires before it deletes anything (#7 fix round 2, N2) — once already
      // `finalized` (e.g. re-rendered after a PRIOR resolveGate handoff already succeeded),
      // discardResumable is a harmless no-op and warning about erasure would be false.
      handoffWarning={!pendingFinalizeGate && run2 && isDiscardableShape ? HANDOFF_ERASES_RECORD_WARNING : undefined}
    />
  )
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
            {runDone && showFinalizeFailureCard ? finalizeFailureBlock : (
              <span className="rmsg">
                <span className="rd" />
                {runDone ? (runStatus === 'failed' ? failedMessage : '工作流已完成 · 所有阶段通过，变更已就绪') : '只读回看 · 此运行未在此进程结束'}
              </span>
            )}
          </div>
        ) : runDone ? (
          <div className="wfo-runctl done">
            {showFinalizeFailureCard ? finalizeFailureBlock : (
              <span className="rmsg">
                <span className="rd" />
                {runStatus === 'failed' ? failedMessage : '工作流已完成 · 所有阶段通过，变更已就绪'}
              </span>
            )}
          </div>
        ) : (
          <div className="wfo-runctl">
            {/* #7 fix round 1 (F2): additive, not a replacement — during a 重新收尾 retry the run is
                genuinely still live/awaiting a decision (the pause/abort row below is correct as-is),
                this just surfaces the still-relevant PREVIOUS failure detail + a handoff escape hatch
                alongside it. `null` (via finalizeFailureBlock) in the overwhelming majority of live
                runs, which never touch state.finalizeFailure at all. */}
            {finalizeFailureBlock}
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
