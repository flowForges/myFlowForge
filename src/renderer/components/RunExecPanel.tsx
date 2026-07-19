import { Fragment, useEffect, useRef, useState, type ReactElement } from 'react'
import './workflowOverlay.css'
import type { Run2Api } from '../state/useRun2'
import type { LiveLane, RunControllerState, RunLogLine } from '../../main/run/controller'
import type { WorkOrderOutcome } from '../../main/run/workOrder'
import type { AgentContextMeta } from '@shared/types'

// P2-1: right-side run-execution display, ported from WorkflowOverlay.tsx's RUN-mode subtree
// (progress header, stage flow nodes, code-stage fan-out lanes). DISPLAY ONLY — every per-node/
// per-lane DECISION action (RunNodeGate / the confirm/auth/input/failure `.wfo-act` blocks) was
// deliberately dropped; those become chat cards in a later task (P3). Run-LEVEL controls
// (暂停/继续/终止) are kept here since they aren't per-node decisions.

// Verbatim subset of WorkflowOverlay's IC object — only the glyphs this panel actually renders
// (play/start terminal, flag/check end terminal, chev/expand, stop/abort button, spin/check/x
// status markers). See WorkflowOverlay.tsx's IC for the full set / provenance.
const IC = {
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 22V4M4 4h13l-2.2 3.5L17 11H4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>',
  spin: '<svg class="wfo-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2.4"/></svg>',
}

function Icon({ svg }: { svg: string }) {
  return <span dangerouslySetInnerHTML={{ __html: svg }} />
}

// Verbatim port of WorkflowOverlay's MODELS table + modelColor/modelShort (WorkflowOverlay.tsx:84-101)
// — colors the per-lane model chip's `.dot` and strips the "<Provider> · " prefix for its label.
const MODELS: { label: string; color: string }[] = [
  { label: 'Claude Code · opus-4.8', color: 'oklch(70% .15 35)' },
  { label: 'Claude Code · sonnet-4.6', color: 'oklch(72% .13 235)' },
  { label: 'Claude Code · haiku-4.5', color: 'oklch(74% .12 200)' },
  { label: 'Codex · gpt-5-codex', color: 'oklch(78% .03 250)' },
  { label: 'Gemini · gemini-2.5-pro', color: 'oklch(72% .15 275)' },
]

function modelColor(label: string): string {
  const found = MODELS.find((m) => m.label === label)
  return found ? found.color : 'var(--muted)'
}

function modelShort(label: string): string {
  return label.replace(/^.*· /, '')
}

// Verbatim port of WorkflowOverlay's RunNodeState vocabulary + helpers (statLabel/fmtTime/
// connClass/nodeClass/StMark/stageRunState/laneRunState) — see WorkflowOverlay.tsx for the
// original provenance comments; unchanged here since this is a pure display port.
type RunNodeState = 'wait' | 'run' | 'ok' | 'confirm' | 'input' | 'fail'

const STAT_LABELS: Record<RunNodeState, string> = {
  wait: '待执行',
  run: '执行中',
  ok: '完成',
  confirm: '待确认',
  input: '待输入',
  fail: '失败',
}
function statLabel(s: RunNodeState): string {
  return STAT_LABELS[s] ?? '待执行'
}

function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return ''
  if (ms < 1000) return ms + 'ms'
  const s = ms / 1000
  return s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + ':' + ('0' + Math.round(s % 60)).slice(-2)
}

function connClass(state: RunNodeState | undefined): string {
  if (!state) return ''
  if (state === 'ok') return 'done'
  if (state === 'run' || state === 'confirm' || state === 'input') return 'run'
  return ''
}

function nodeClass(state: RunNodeState): string {
  return state === 'ok' ? 'done' : state
}

function StMark({ state }: { state: RunNodeState }) {
  if (state === 'run') return <span className="wfo-spin"><Icon svg={IC.spin} /></span>
  if (state === 'ok') return <Icon svg={IC.check} />
  if (state === 'fail') return <Icon svg={IC.x} />
  return <span className="hd" />
}

function stageRunState(stageKey: string, state: RunControllerState): RunNodeState {
  const outcomes = state.outcomes[stageKey]
  const hasFailedOutcome = outcomes?.some((o) => o.status === 'failed') ?? false
  const hasFailureEvent = state.inbox.some((e) => e.kind === 'failure' && e.stageKey === stageKey)
  if (hasFailedOutcome || hasFailureEvent) return 'fail'
  if (state.inbox.some((e) => e.kind === 'auth' && e.stageKey === stageKey)) return 'confirm'
  if (state.inbox.some((e) => e.kind === 'gate' && e.stageKey === stageKey)) return 'confirm'
  if (state.inbox.some((e) => e.kind === 'question' && e.stageKey === stageKey)) return 'input'
  const machineStatus = state.machine.stages.find((s) => s.key === stageKey)?.status
  const hasOkOutcome = outcomes?.some((o) => o.status === 'ok') ?? false
  if (machineStatus === 'done' || hasOkOutcome) return 'ok'
  if (machineStatus === 'running') return 'run'
  return 'wait'
}

function laneRunState(liveLane: LiveLane | undefined, outcome: WorkOrderOutcome | undefined): RunNodeState {
  if (outcome) return outcome.status === 'ok' ? 'ok' : 'fail'
  if (liveLane?.state === 'run') return 'run'
  return 'wait'
}

interface CodeLane {
  project: string
  laneId: string
  state: RunNodeState
  cwd: string | undefined
  model: string
  providerLabel: string
}

// Fan-out lane set for a running code stage = union of liveLanes (still running), outcomes[stageKey]
// (settled), AND `memory` (every project ever seen for this stage this run) — same data-combining
// rule as WorkflowOverlay's buildCodeLanes (see its provenance comment), simplified here since this
// panel has no `launchInfo`/project list to source ordering or provider/model fallbacks from: a
// lane's provider/model comes from its own settled WorkOrder.order (when present) else the stage
// plan's provider/model. Ordered by first-encounter (memory keys first, then outcome, then live).
function buildCodeLanes(
  stageKey: string,
  stagePlan: { provider: string; model: string } | undefined,
  state: RunControllerState,
  memory: Map<string, CodeLane>
): CodeLane[] {
  const outcomeByProject = new Map<string, WorkOrderOutcome>()
  for (const o of state.outcomes[stageKey] ?? []) {
    if (o.order.project) outcomeByProject.set(o.order.project, o)
  }
  const liveByProject = new Map<string, LiveLane>()
  for (const laneId of Object.keys(state.liveLanes)) {
    const l = state.liveLanes[laneId]
    if (l.stageKey === stageKey && l.project) liveByProject.set(l.project, l)
  }
  const present = [...memory.keys(), ...outcomeByProject.keys(), ...liveByProject.keys()]
  const ordered: string[] = []
  for (const n of present) if (!ordered.includes(n)) ordered.push(n)

  return ordered.map((name) => {
    const outcome = outcomeByProject.get(name)
    const live = liveByProject.get(name)
    const prior = memory.get(name)
    const provider = outcome?.order.provider ?? stagePlan?.provider ?? ''
    const model = outcome?.order.model ?? stagePlan?.model ?? ''
    const laneState = outcome || live ? laneRunState(live, outcome) : prior?.state ?? 'run'
    const lane: CodeLane = {
      project: name,
      laneId: `${stageKey}:${name}`,
      state: laneState,
      cwd: live?.cwd ?? outcome?.order.cwd ?? prior?.cwd,
      model: model ? `${provider} · ${model}` : provider,
      providerLabel: provider,
    }
    memory.set(name, lane)
    return lane
  })
}

// Same scanContext-backed cwd->caps cache as WorkflowOverlay's useNodeCaps (own tiny cache rather
// than sharing WorkflowOverlay's private module-level one).
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
      .catch(() => { /* best-effort — a scan failure just means no chips, not a crash */ })
    return () => {
      alive = false
    }
  }, [cwd])
  return meta
}

// Display-only port of WorkflowOverlay's RunNodeBody (LLM 输入/已加载 Skill·Rule·MCP/LLM 输出).
// Unchanged from the original — it never rendered any decision action itself (RunNodeGate was
// always a SIBLING, not a child, of this component in WorkflowOverlay).
function RunNodeBody({
  stageKey,
  prompt,
  cwd,
  state,
  laneLogs,
  outputId,
}: {
  stageKey: string
  prompt: string
  cwd: string | undefined
  state: RunNodeState
  laneLogs: RunLogLine[]
  outputId?: string
}) {
  const caps = useNodeCaps(cwd)
  const hasCaps = !!caps && (caps.skills.length > 0 || caps.rules.length > 0 || (caps.mcps?.length ?? 0) > 0)
  const outputText = laneLogs.map((l) => l.line.text).join('')
  return (
    <>
      <div className="wfo-sec">
        <div className="wfo-sec-h">LLM 输入</div>
        <div className="wfo-io in">{prompt}</div>
      </div>
      {hasCaps && (
        <div className="wfo-sec">
          <div className="wfo-sec-h">已加载 Skill · Rule · MCP</div>
          <div className="wfo-caps">
            {caps!.skills.map((s) => (
              <span key={`s-${s.name}`} className="wfo-cap s">
                <span className="tg">S</span>{s.name}
              </span>
            ))}
            {caps!.rules.map((r) => (
              <span key={`r-${r.name}`} className="wfo-cap r">
                <span className="tg">R</span>{r.name}
              </span>
            ))}
            {(caps!.mcps ?? []).map((m) => (
              <span key={`m-${m.name}`} className="wfo-cap m">
                <span className="tg">M</span>{m.name}
              </span>
            ))}
          </div>
        </div>
      )}
      {state !== 'wait' && (
        <div className="wfo-sec">
          <div className="wfo-sec-h">LLM 输出</div>
          <div className="wfo-io" id={outputId ?? `wfout-${stageKey}`}>
            {outputText}
            {state === 'run' && <span className="cur" />}
          </div>
        </div>
      )}
    </>
  )
}

export function RunExecPanel({ run2 }: { run2: Run2Api }): ReactElement {
  // Per-repo lane expansion, keyed `${stageKey}::${project}` (mirrors WorkflowOverlay's openRepo).
  const [openRepo, setOpenRepo] = useState<Record<string, boolean>>({})
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({})
  const toggleRepo = (key: string) => setOpenRepo((prev) => ({ ...prev, [key]: !prev[key] }))
  const toggleNode = (key: string) => setOpenNodes((prev) => ({ ...prev, [key]: !prev[key] }))

  // Per-stage `project -> last-known CodeLane` memory so a fan-out lane never disappears once
  // observed (see buildCodeLanes' comment). Reset whenever the run identity changes.
  const codeLaneMemoryRef = useRef<Map<string, Map<string, CodeLane>>>(new Map())
  const lastRunIdRef = useRef<string | null>(null)
  const liveRunId = run2.state?.machine.plan.runId ?? null
  if (liveRunId !== lastRunIdRef.current) {
    lastRunIdRef.current = liveRunId
    codeLaneMemoryRef.current = new Map()
  }
  const getCodeLaneMemory = (stageKey: string): Map<string, CodeLane> => {
    let m = codeLaneMemoryRef.current.get(stageKey)
    if (!m) {
      m = new Map()
      codeLaneMemoryRef.current.set(stageKey, m)
    }
    return m
  }

  const state = run2.state
  const running = state != null
  const runStatus = running ? state.status : null
  const runDone = running && (runStatus === 'ok' || runStatus === 'failed')

  // `now` ticks every second while running so the currently-running stage's elapsed time stays
  // live — same FIX6 gating as WorkflowOverlay (stop re-arming once the run has settled).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running || runDone) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running, runDone])

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

  const runStages = state.machine.plan.stages.map((sp) => ({
    key: sp.key,
    name: sp.name,
    prompt: sp.prompt ?? '',
    code: sp.scope === 'per-project',
    provider: sp.provider,
    model: sp.model,
  }))
  const runStageStates: Record<string, RunNodeState> = {}
  for (const rs of runStages) runStageStates[rs.key] = stageRunState(rs.key, state)
  const doneN = state.machine.stages.filter((s) => s.status === 'done').length
  const totalStages = state.machine.stages.length
  const pct = totalStages ? Math.round((doneN / totalStages) * 100) : 0
  const runAllDone = state.status === 'ok' && totalStages > 0
  const runPaused = !!state.paused
  // P4 will populate machine.plan.tempBranch; render '—' until then.
  const tempBranch = (state.machine.plan as { tempBranch?: string }).tempBranch ?? '—'

  return (
    <div className="wfo-run-panel">
      <div className="wfo-head">
        <div className="wfo-title">
          <span className="tt">工作流执行中</span>
          <span className="wfo-branch">分支：{tempBranch}</span>
        </div>
        <div className="wfo-prog">
          <span className="lbl">已完成 {doneN} / {totalStages}</span>
          <span className="bar"><i style={{ width: `${pct}%` }} /></span>
          <span className="pct">{pct}%</span>
        </div>
        {runDone ? (
          <div className="wfo-runctl done">
            <span className="rmsg">
              <span className="rd" />
              {runStatus === 'failed' ? '工作流已结束 · 存在失败阶段，请检查后处理' : '工作流已完成 · 所有阶段通过，变更已就绪'}
            </span>
          </div>
        ) : (
          <div className="wfo-runctl">
            <span className="rmsg">
              <span className="rd" />
              <span>正在执行…</span>
            </span>
            {runPaused ? (
              <button className="wfo-btn ghost" onClick={() => run2.resume()}>继续</button>
            ) : runStatus === 'running' ? (
              <button className="wfo-btn ghost" onClick={() => run2.pause()}>暂停</button>
            ) : null}
            <button className="wfo-btn ghost" onClick={() => run2.abort()}>
              <Icon svg={IC.stop} /> 终止
            </button>
          </div>
        )}
      </div>

      <div className="wfo-flow">
        <div className="wfo-chart">
          <div className="wfo-term start">
            <Icon svg={IC.play} />开始
          </div>
          <div className={`wfo-conn${runStages.length ? ' ' + (connClass(runStageStates[runStages[0].key]) || 'done') : ''}`}>
            <span className="ln" />
            <span className="ar" />
          </div>
          {runStages.map((rs) => {
            const st = runStageStates[rs.key] ?? 'wait'
            const timing = state.stageTimings[rs.key]
            const timeText =
              st === 'run'
                ? fmtTime(now - (timing?.startedAt ?? now))
                : timing?.startedAt != null && timing?.endedAt != null
                  ? fmtTime(timing.endedAt - timing.startedAt)
                  : ''
            const cc = connClass(st)
            const laneId = `${rs.key}:root`
            const laneCwd = state.liveLanes[laneId]?.cwd ?? state.outcomes[rs.key]?.[0]?.order.cwd
            const laneLines = run2.laneLogs[laneId] ?? []
            const codeLanes = rs.code
              ? buildCodeLanes(rs.key, { provider: rs.provider, model: rs.model }, state, getCodeLaneMemory(rs.key))
              : []
            const glanesCls =
              st === 'ok' ? ' done' : st === 'run' || st === 'confirm' || st === 'input' ? ' run' : ''
            return (
              <Fragment key={rs.key}>
                {rs.code ? (
                  <div className="wfo-node" data-stage={rs.key}>
                    <div className={`wfo-group ${nodeClass(st)}`}>
                      <div className="wfo-ghead">
                        <span className="wfo-ic"><StMark state={st} /></span>
                        <span className="wfo-cn">
                          <b>{rs.name}</b>
                        </span>
                        <span className="wfo-gpar">{codeLanes.length} 仓库并行</span>
                        <span className={`wfo-stat ${st}`}>
                          <span className="d" />
                          {statLabel(st)}
                        </span>
                        <span className="wfo-time">{timeText}</span>
                      </div>
                      <div className={`wfo-glanes${glanesCls}`}>
                        {codeLanes.length === 0 ? (
                          <div className="wfo-proj-hint" style={{ padding: '2px 0' }}>暂无代码项目在此阶段运行。</div>
                        ) : (
                          codeLanes.map((lane) => {
                            const repoKey = `${rs.key}::${lane.project}`
                            const open = !!openRepo[repoKey]
                            const laneOutLines = run2.laneLogs[lane.laneId] ?? []
                            return (
                              <div key={lane.project} className={`wfo-lane ${lane.state}${open ? ' open' : ''}`}>
                                <div className="wfo-lbox">
                                  <div className="wfo-lhead" data-lane={repoKey} onClick={() => toggleRepo(repoKey)}>
                                    <span className="wfo-ic sm"><StMark state={lane.state} /></span>
                                    <span className="wfo-lname">
                                      <b>{lane.project}</b>
                                      <span>{lane.providerLabel}</span>
                                    </span>
                                    <span className="wfo-lmodel">
                                      <span className="dot" style={{ background: modelColor(lane.model) }} />
                                      <span className="mv">{modelShort(lane.model)}</span>
                                    </span>
                                    <span className={`wfo-stat ${lane.state}`}>
                                      <span className="d" />
                                      {statLabel(lane.state)}
                                    </span>
                                    <span className="wfo-chev">
                                      <Icon svg={IC.chev} />
                                    </span>
                                  </div>
                                  <div className="wfo-lbody">
                                    <RunNodeBody
                                      stageKey={rs.key}
                                      prompt={rs.prompt}
                                      cwd={lane.cwd}
                                      state={lane.state}
                                      laneLogs={laneOutLines}
                                      outputId={`wfout-${rs.key}-${lane.project}`}
                                    />
                                  </div>
                                </div>
                              </div>
                            )
                          })
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className={`wfo-node${openNodes[rs.key] ? ' open' : ''} ${nodeClass(st)}`} data-stage={rs.key}>
                    <div className="wfo-box">
                      <div className="wfo-cardhead" data-node={rs.key} onClick={() => toggleNode(rs.key)}>
                        <span className="wfo-ic"><StMark state={st} /></span>
                        <span className="wfo-cn">
                          <b>{rs.name}</b>
                        </span>
                        <span className={`wfo-stat ${st}`}>
                          <span className="d" />
                          {statLabel(st)}
                        </span>
                        <span className="wfo-time">{timeText}</span>
                        <span className="wfo-chev">
                          <Icon svg={IC.chev} />
                        </span>
                      </div>
                      <div className="wfo-cardbody">
                        <RunNodeBody
                          stageKey={rs.key}
                          prompt={rs.prompt}
                          cwd={laneCwd}
                          state={st}
                          laneLogs={laneLines}
                        />
                      </div>
                    </div>
                  </div>
                )}
                <div className={`wfo-conn${cc ? ' ' + cc : ''}`}>
                  <span className="ln" />
                  <span className="ar" />
                </div>
              </Fragment>
            )
          })}
          <div className={`wfo-term end${runAllDone ? ' done' : ''}`}>
            <Icon svg={runAllDone ? IC.check : IC.flag} />
            {runAllDone ? '完成' : '结束'}
          </div>
        </div>
      </div>
    </div>
  )
}
