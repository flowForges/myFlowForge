import { Fragment, useEffect, useState } from 'react'
import './workflowOverlay.css'
import type { Run2Api } from '../state/useRun2'
import type { RunControllerState, RunLogLine } from '../../main/run/controller'
import type { AgentContextMeta } from '@shared/types'

// Task 2 (WF-A): 1:1 port of the prototype's `.wfo` overlay CONFIG state — head (title/tabs/legend) +
// flow placeholder (Task 3 fills it) + foot (goal textarea/start button/hint). SOURCE:
// docs/superpowers/refs/wfo-prototype-reference.txt renderOverlay() head (~9311-9330) + foot config
// branch (~9346-9366) + HTML container (~3374) + IC icons object (~826-843).
// No run state yet — that's a later task; this only renders the "not running" config branch
// (st.running === false in the prototype).

export interface WorkflowOverlayProps {
  workspacePath: string
  initialSeed?: string
  onClose: () => void
  onStarted?: () => void
  // B1 (WF-B): live run2 state. `run2.state != null` switches the overlay from CONFIG mode (WF-A,
  // unchanged below) to RUN mode — progress bar, per-node status/time, animated connectors.
  run2: Run2Api
}

// Mirrors src/main/run/launch.ts LaunchStage (T1 added code/desc/prompt on top of the P4-A fields).
interface LaunchStage {
  key: string
  name: string
  provider: string
  model: string
  gate: boolean
  code: boolean
  desc: string
  prompt: string
}

interface LaunchWorkflow {
  id: string
  name: string
  stages: LaunchStage[]
}

interface LaunchProject {
  name: string
  cwd: string
  provider?: string
  model?: string
}

interface LaunchInfo {
  workflows: LaunchWorkflow[]
  projects: LaunchProject[]
}

const EMPTY_INFO: LaunchInfo = { workflows: [], projects: [] }

// Verbatim SVG markup copied from the prototype's `IC` object (reference lines 826-843) — rendered via
// dangerouslySetInnerHTML per-icon so the markup stays byte-identical rather than hand-translated to JSX.
const IC = {
  flow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="3" width="7" height="5" rx="1.4"/><rect x="14" y="9.5" width="7" height="5" rx="1.4"/><rect x="3" y="16" width="7" height="5" rx="1.4"/><path d="M10 5.5h2a2 2 0 0 1 2 2v.5M10 18.5h2a2 2 0 0 0 2-2v-.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
  // Task 3 additions — verbatim from the prototype's IC object (reference lines 826-843).
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 22V4M4 4h13l-2.2 3.5L17 11H4"/></svg>',
  // Task 4 additions — check + git glyphs for the project-select rows, verbatim from the prototype IC.
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>',
  git: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="6" r="2.3"/><circle cx="6" cy="18" r="2.3"/><circle cx="18" cy="18" r="2.3"/><path d="M12 8.3v2a3.4 3.4 0 0 1-3.4 3.4H8M12 10.3a3.4 3.4 0 0 0 3.4 3.4H16"/></svg>',
  // B1 additions — spin/x glyphs for run-state markers, verbatim from the prototype IC (reference lines
  // 826-843; `spin` keeps its own `class="wfo-spin"` on the <svg>, matching the prototype's stMark()
  // which wraps it in a SECOND `.wfo-spin` span — see StMark below).
  spin: '<svg class="wfo-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
}

// Task 4: 1:1 port of the prototype's MODELS table (reference lines 368-374) — the small model catalog
// the config-state chips cycle through and color-code. Labels are "<Provider> · <model>"; modelColor()
// maps a label to its oklch dot color (prototype line 376), falling back to --muted for unknowns.
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

// The label shown inside a model chip drops any "<Provider> · " prefix (prototype uses
// pmdl.replace(/^.*· /, "")), so the per-project chips stay compact.
function modelShort(label: string): string {
  return label.replace(/^.*· /, '')
}

// Cycle to the next label in the MODELS table (MVP for the model picker — the full popover is WF-C).
function cycleModel(current: string): string {
  const idx = MODELS.findIndex((m) => m.label === current)
  return MODELS[(idx + 1) % MODELS.length].label
}

function Icon({ svg }: { svg: string }) {
  return <span dangerouslySetInnerHTML={{ __html: svg }} />
}

// B1 (WF-B): run-state vocabulary for a single stage — 1:1 with the prototype's r.state values
// (reference lines 527, 602-611, 890-973). Node/group container classes translate 'ok' -> 'done'
// (matching the CSS, which styles `.wfo-node.done` / `.wfo-group.done` but `.wfo-stat.ok` /
// `.wfo-lane.ok` — see nodeClass below); the stat badge and StMark keep the raw value.
type RunNodeState = 'wait' | 'run' | 'ok' | 'confirm' | 'input' | 'fail'

// Verbatim port of the prototype's statLabel() (reference line 527).
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

// Verbatim port of the prototype's fmtTime() (reference line 528).
function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return ''
  if (ms < 1000) return ms + 'ms'
  const s = ms / 1000
  return s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + ':' + ('0' + Math.round(s % 60)).slice(-2)
}

// Verbatim port of the prototype's connClass() (reference lines 599-605), taking a resolved
// RunNodeState directly (the caller already looked up st.run[k]).
function connClass(state: RunNodeState | undefined): string {
  if (!state) return ''
  if (state === 'ok') return 'done'
  if (state === 'run' || state === 'confirm' || state === 'input') return 'run'
  return ''
}

// Node/group container classes use 'done' where the CSS expects it (`.wfo-node.done`), unlike the
// stat badge / lane classes which keep 'ok' literally — see the RunNodeState comment above.
function nodeClass(state: RunNodeState): string {
  return state === 'ok' ? 'done' : state
}

// Status marker (dot / spin / check / x) — node, group-head, and (later, B4) per-repo lane all share
// this. Verbatim port of the prototype's stMark() (reference lines 607-611): the 'run' branch wraps
// IC.spin in a SECOND `.wfo-spin` span, matching the prototype exactly.
function StMark({ state }: { state: RunNodeState }) {
  if (state === 'run') return <span className="wfo-spin"><Icon svg={IC.spin} /></span>
  if (state === 'ok') return <Icon svg={IC.check} />
  if (state === 'fail') return <Icon svg={IC.x} />
  return <span className="hd" />
}

// B1: derives a stage's RunNodeState from run2 data — mirrors the mapping table in the WF-B plan.
// Order matters: a failed outcome/inbox failure wins over everything else, then the confirm/input
// gates, then done/ok, then running, else wait.
function stageRunState(stageKey: string, state: RunControllerState): RunNodeState {
  const outcomes = state.outcomes[stageKey]
  const hasFailedOutcome = outcomes?.some((o) => o.status === 'failed') ?? false
  const hasFailureEvent = state.inbox.some((e) => e.kind === 'failure' && e.stageKey === stageKey)
  if (hasFailedOutcome || hasFailureEvent) return 'fail'
  if (state.inbox.some((e) => e.kind === 'gate' && e.stageKey === stageKey)) return 'confirm'
  if (state.inbox.some((e) => e.kind === 'question' && e.stageKey === stageKey)) return 'input'
  const machineStatus = state.machine.stages.find((s) => s.key === stageKey)?.status
  const hasOkOutcome = outcomes?.some((o) => o.status === 'ok') ?? false
  if (machineStatus === 'done' || hasOkOutcome) return 'ok'
  if (machineStatus === 'running') return 'run'
  return 'wait'
}

// B2 (WF-B): what skill/rule/mcp this stage's lane would load if it ran in its cwd right now —
// reuses the same cwd-scanner (window.forge.scanContext) as RunPanel's LaneContext (P-B2 Task 2),
// kept as its own tiny per-component cache rather than importing RunPanel's private cache.
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

// B2: 1:1 port of the prototype's renderBody() run branch (reference lines 649-705) for a
// NON-code stage's single lane — `.wfo-sec` LLM 输入 (`.wfo-io.in`) + `.wfo-sec` 已加载
// Skill·Rule·MCP (`.wfo-caps`, live via scanContext rather than the prototype's static CAPS mock)
// + `.wfo-sec` LLM 输出 (`.wfo-io`, laneLogs text, with a `.cur` blink cursor while `state==='run'`).
// A code stage's per-project lane IO lives in the fan-out lanes (task B4) — callers must not render
// this for `stage.code` stages.
function RunNodeBody({
  stageKey,
  prompt,
  cwd,
  state,
  laneLogs,
}: {
  stageKey: string
  prompt: string
  cwd: string | undefined
  state: RunNodeState
  laneLogs: RunLogLine[]
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
          <div className="wfo-io" id={`wfout-${stageKey}`}>
            {outputText}
            {state === 'run' && <span className="cur" />}
          </div>
        </div>
      )}
    </>
  )
}

// P5-UI WF-A Task 2: opened from a workflow "/" command in chat. Loads launchInfo, lets the user pick a
// workflow tab + type a goal. Task 3 fills in the `.wfo-flow` stage chart; Task 5 wires the 启动 button
// to actually start a run (kept as a stub here — onStarted is threaded through for that later task).
export function WorkflowOverlay({ workspacePath, initialSeed, onClose, onStarted, run2 }: WorkflowOverlayProps) {
  const [info, setInfo] = useState<LaunchInfo>(EMPTY_INFO)
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>('')
  const [goal, setGoal] = useState(() => initialSeed ?? '')
  // Task 3: per-stage expanded state for the config-state flowchart nodes. Mirrors the prototype's
  // st.openNode, which is wiped whenever the workflow tab switches (initWf() resets it) — see
  // selectWorkflow below.
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({})
  // Task 4: per-stage config state, mirroring the prototype's st.proj / st.model / st.projModel.
  // projSel — which projects a code stage fans out to (default ALL selected). stageModel — the model
  // label for a non-code stage's header chip. projModel — per-project model label for a code stage.
  // All three are (re)initialised by the effect below whenever the selected workflow / projects change,
  // matching the prototype's initWf() reset on tab switch.
  const [projSel, setProjSel] = useState<Record<string, Record<string, boolean>>>({})
  const [stageModel, setStageModel] = useState<Record<string, string>>({})
  const [projModel, setProjModel] = useState<Record<string, Record<string, string>>>({})
  // Task 5: launch state — queuedNote mirrors RunLauncher's pattern (manager.start() can return
  // {status:'queued', position} instead of firing onStarted immediately).
  const [starting, setStarting] = useState(false)
  const [queuedNote, setQueuedNote] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Named run2Ipc (not run2) — the `run2` identifier in this component scope is the live-state prop.
    const run2Ipc = (window as any).forge?.run2
    if (!run2Ipc?.launchInfo) {
      setInfo(EMPTY_INFO)
      return
    }
    run2Ipc.launchInfo(workspacePath)
      .then((li: LaunchInfo) => {
        if (cancelled) return
        setInfo(li)
        setSelectedWorkflowId((prev) => (prev && li.workflows.some((w) => w.id === prev) ? prev : li.workflows[0]?.id ?? ''))
      })
      .catch(() => {
        if (cancelled) return
        setInfo(EMPTY_INFO)
      })
    return () => {
      cancelled = true
    }
  }, [workspacePath])

  const stages = info.workflows.find((w) => w.id === selectedWorkflowId)?.stages ?? []

  // Task 4: (re)initialise per-stage config defaults whenever the workflow / project set changes —
  // mirrors the prototype's initWf(): every code stage starts with ALL projects selected, each stage's
  // model defaults to `${provider} · ${model}`, and each project's model defaults to its own configured
  // provider/model (if any) else the stage model.
  useEffect(() => {
    const nextSel: Record<string, Record<string, boolean>> = {}
    const nextStageModel: Record<string, string> = {}
    const nextProjModel: Record<string, Record<string, string>> = {}
    for (const s of stages) {
      const stageLabel = `${s.provider} · ${s.model}`
      nextStageModel[s.key] = stageLabel
      if (s.code) {
        nextSel[s.key] = {}
        nextProjModel[s.key] = {}
        for (const p of info.projects) {
          nextSel[s.key][p.name] = true
          nextProjModel[s.key][p.name] = p.model ? `${p.provider ?? s.provider} · ${p.model}` : stageLabel
        }
      }
    }
    setProjSel(nextSel)
    setStageModel(nextStageModel)
    setProjModel(nextProjModel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkflowId, info])

  // Task 5: starts the run — projectNames is the UNION of every code stage's selected projects (or,
  // if there are no code stages at all, ALL of the workspace's projects). Model override is DEFERRED
  // (per the WF-A plan): only workflowId/projectNames/task/runId go to run2 for now.
  const handleStart = () => {
    const run2Ipc = (window as any).forge?.run2
    if (!run2Ipc?.startWorkflow || !selectedWorkflowId) return
    const codeStageKeys = stages.filter((s) => s.code).map((s) => s.key)
    let projectNames: string[]
    if (codeStageKeys.length === 0) {
      projectNames = info.projects.map((p) => p.name)
    } else {
      const union = new Set<string>()
      for (const key of codeStageKeys) {
        // The projSel-init effect (above) populates this asynchronously after launchInfo resolves —
        // if it hasn't run yet for this key (undefined, as opposed to an explicit {} from user
        // deselection), fall back to "all projects selected", matching what that effect would set.
        const sel = projSel[key]
        for (const p of info.projects) {
          if (sel ? sel[p.name] : true) union.add(p.name)
        }
      }
      projectNames = Array.from(union)
    }
    setStartError(null)
    setQueuedNote(null)
    setStarting(true)
    Promise.resolve(
      run2Ipc.startWorkflow({
        workspacePath,
        workflowId: selectedWorkflowId,
        projectNames,
        task: goal,
        runId: `run2-${Date.now()}`,
      })
    )
      .then((result: unknown) => {
        // manager.start() returns a union: {status:'started', state} | {status:'queued', position}.
        // Only 'queued' changes behavior — everything else (incl. legacy void) falls back to onStarted().
        if (result && typeof result === 'object' && (result as { status?: unknown }).status === 'queued') {
          const position = (result as { position?: unknown }).position
          setQueuedNote(`已加入队列（位置 ${position}），等待当前工作流完成`)
          return
        }
        onStarted?.()
      })
      .catch((err: unknown) => setStartError(err instanceof Error ? err.message : String(err)))
      .finally(() => setStarting(false))
  }

  const toggleProj = (stageKey: string, projName: string) => {
    setProjSel((prev) => {
      const forStage = prev[stageKey] ?? {}
      return { ...prev, [stageKey]: { ...forStage, [projName]: !forStage[projName] } }
    })
  }
  const cycleStageModel = (stageKey: string, current: string) => {
    setStageModel((prev) => ({ ...prev, [stageKey]: cycleModel(current) }))
  }
  const cycleProjModel = (stageKey: string, projName: string, current: string) => {
    setProjModel((prev) => ({
      ...prev,
      [stageKey]: { ...(prev[stageKey] ?? {}), [projName]: cycleModel(current) },
    }))
  }

  // Switching workflow tabs resets which nodes are expanded (prototype's initWf() does the same).
  const selectWorkflow = (id: string) => {
    setSelectedWorkflowId(id)
    setOpenNodes({})
  }
  const toggleNode = (key: string) => {
    setOpenNodes((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  // B1 (WF-B): `run2.state != null` is RUN mode. `now` ticks every second while running so the
  // per-node elapsed time (fmtTime(now - startedAt)) for the currently-running stage stays live —
  // mirrors the prototype's setInterval-driven #wftime-<k> updater (reference lines 866-876).
  const running = run2.state != null
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])

  // Ordered stage list for RUN mode, sourced from the actual run plan (machine.plan.stages) rather
  // than the config-tab selection above — once a run exists it is authoritative regardless of which
  // workflow tab happens to be selected in the UI. `name`/`code` come from the plan snapshot; `desc`
  // is enriched from launchInfo (info.workflows) by key when available, else left blank.
  const stageDescByKey: Record<string, string> = {}
  const stagePromptByKey: Record<string, string> = {}
  for (const w of info.workflows) for (const s of w.stages) {
    stageDescByKey[s.key] = s.desc
    stagePromptByKey[s.key] = s.prompt
  }
  const runStages = running
    ? run2.state!.machine.plan.stages.map((sp) => ({
        key: sp.key,
        name: sp.name,
        desc: stageDescByKey[sp.key] ?? '',
        code: sp.scope === 'per-project',
      }))
    : []
  const runStageStates: Record<string, RunNodeState> = {}
  if (running) {
    for (const rs of runStages) runStageStates[rs.key] = stageRunState(rs.key, run2.state!)
  }
  const doneN = running ? run2.state!.machine.stages.filter((s) => s.status === 'done').length : 0
  const totalStages = running ? run2.state!.machine.stages.length : 0
  const pct = totalStages ? Math.round((doneN / totalStages) * 100) : 0
  const runAllDone = running && run2.state!.status === 'ok' && totalStages > 0

  return (
    <div className="wfo">
      <div className="wfo-scrim" onClick={onClose} />
      <div className="wfo-panel">
        <div className="wfo-head">
          <div className="wfo-title">
            <span className="ti"><Icon svg={IC.flow} /></span>
            <span className="tt">
              {running ? '工作流执行中' : (
                <>
                  开启工作流
                  <small>选择流程 · 配置模块 · 下达目标</small>
                </>
              )}
            </span>
            <button className="wfo-x" title="关闭" onClick={onClose}>
              <Icon svg={IC.close} />
            </button>
          </div>
          {running ? (
            <div className="wfo-prog">
              <span className="lbl">已完成 {doneN} / {totalStages}</span>
              <span className="bar"><i style={{ width: `${pct}%` }} /></span>
              <span className="pct">{pct}%</span>
            </div>
          ) : (
            <>
              <div className="wfo-tabs">
                {info.workflows.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    className={`wfo-tab${w.id === selectedWorkflowId ? ' on' : ''}`}
                    onClick={() => selectWorkflow(w.id)}
                  >
                    {w.name}
                    <span className="n">{w.stages.length}</span>
                  </button>
                ))}
              </div>
              <div className="wfo-legend">
                <i className="run">执行中</i>
                <i className="ok">完成</i>
                <i className="confirm">待确认</i>
                <i className="input">待输入</i>
                <i className="fail">失败</i>
              </div>
            </>
          )}
        </div>

        {running ? (
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
              const timing = run2.state!.stageTimings[rs.key]
              const timeText =
                st === 'run'
                  ? fmtTime(now - (timing?.startedAt ?? now))
                  : timing?.startedAt != null && timing?.endedAt != null
                    ? fmtTime(timing.endedAt - timing.startedAt)
                    : ''
              const cc = connClass(st)
              // B2: the stage's single lane (non-code stages fan out to exactly one order,
              // id `${stageKey}:root` — see fanout.ts buildWorkOrders). cwd comes from the live
              // lane while running, else the settled outcome's order.cwd (task brief).
              const laneId = `${rs.key}:root`
              const laneCwd = run2.state!.liveLanes[laneId]?.cwd ?? run2.state!.outcomes[rs.key]?.[0]?.order.cwd
              const laneLines = run2.laneLogs[laneId] ?? []
              return (
                <Fragment key={rs.key}>
                  <div className={`wfo-node${openNodes[rs.key] ? ' open' : ''} ${nodeClass(st)}`} data-stage={rs.key}>
                    <div className="wfo-box">
                      <div className="wfo-cardhead" data-node={rs.key} onClick={() => toggleNode(rs.key)}>
                        <span className="wfo-ic"><StMark state={st} /></span>
                        <span className="wfo-cn">
                          <b>{rs.name}</b>
                          <span>{rs.desc}</span>
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
                        {!rs.code && (
                          <RunNodeBody
                            stageKey={rs.key}
                            prompt={stagePromptByKey[rs.key] ?? ''}
                            cwd={laneCwd}
                            state={st}
                            laneLogs={laneLines}
                          />
                        )}
                      </div>
                    </div>
                  </div>
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
        ) : (
        <div className="wfo-flow">
          <div className="wfo-chart">
            <div className="wfo-term start">
              <Icon svg={IC.play} />开始
            </div>
            <div className="wfo-conn">
              <span className="ln" />
              <span className="ar" />
            </div>
            {stages.map((stage) => {
              const sel = projSel[stage.key] ?? {}
              const selNames = info.projects.filter((p) => sel[p.name])
              const stageMdl = stageModel[stage.key] ?? `${stage.provider} · ${stage.model}`
              // Code-stage header chip is a read-only summary of the selected projects' unique models
              // (prototype's projModelSummary): color dots for up to 3 distinct models + a compact label.
              const uniqModels: string[] = []
              for (const p of selNames) {
                const m = projModel[stage.key]?.[p.name] ?? stageMdl
                if (!uniqModels.includes(m)) uniqModels.push(m)
              }
              const summaryLabel = uniqModels.length === 0
                ? '未选项目'
                : uniqModels.length === 1
                  ? modelShort(uniqModels[0])
                  : `${uniqModels.length} 种模型`
              return (
              <Fragment key={stage.key}>
                <div className={`wfo-node${openNodes[stage.key] ? ' open' : ''}`}>
                  <div className="wfo-box">
                    <div className="wfo-cardhead" data-node={stage.key} onClick={() => toggleNode(stage.key)}>
                      <span className="wfo-ic">
                        <span className="hd" />
                      </span>
                      <span className="wfo-cn">
                        <b>{stage.name}</b>
                        <span>{stage.desc}</span>
                      </span>
                      <span className={`wfo-mode${stage.code ? ' code' : ''}`}>{stage.code ? '代码' : '读写'}</span>
                      {stage.gate && (
                        <span className="wfo-gate" title="需人工确认后才会继续下游阶段">
                          门
                        </span>
                      )}
                      {stage.code ? (
                        <span className="wfo-model ro" title="每个代码项目单独选择模型 · 展开查看">
                          {uniqModels.slice(0, 3).map((m, i) => (
                            <span key={i} className="dot" style={{ background: modelColor(m) }} />
                          ))}
                          <span className="mv">{summaryLabel}</span>
                        </span>
                      ) : (
                        <span
                          className="wfo-model"
                          data-model={stage.key}
                          onClick={(e) => {
                            e.stopPropagation()
                            cycleStageModel(stage.key, stageMdl)
                          }}
                        >
                          <span className="dot" style={{ background: modelColor(stageMdl) }} />
                          <span className="mv">{stageMdl}</span>
                          <Icon svg={IC.chev} />
                        </span>
                      )}
                      <span className="wfo-chev">
                        <Icon svg={IC.chev} />
                      </span>
                    </div>
                    <div className="wfo-cardbody">
                      <div className="wfo-sec">
                        <div className="wfo-sec-h">阶段指令</div>
                        <div className="wfo-prompt">{stage.prompt}</div>
                      </div>
                      {stage.code && (
                        <div className="wfo-sec">
                          <div className="wfo-sec-h">
                            涉及代码项目
                            <span className="c">已选 {selNames.length} / {info.projects.length}</span>
                          </div>
                          {info.projects.map((p) => {
                            const on = !!sel[p.name]
                            const pmdl = projModel[stage.key]?.[p.name] ?? stageMdl
                            return (
                              <div key={p.name} className={`wfo-proj${on ? ' on' : ''}`}>
                                <span
                                  className="wfo-ckhit"
                                  data-proj={`${stage.key}::${p.name}`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    toggleProj(stage.key, p.name)
                                  }}
                                >
                                  <span className="wfo-ck"><Icon svg={IC.check} /></span>
                                  <span className="pg"><Icon svg={IC.git} /></span>
                                  <span className="pn">
                                    <b>{p.name}</b>
                                    <span>{p.provider ?? stage.provider}</span>
                                  </span>
                                </span>
                                {on && (
                                  <span
                                    className="wfo-model sm"
                                    data-pmodel={`${stage.key}::${p.name}`}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      cycleProjModel(stage.key, p.name, pmdl)
                                    }}
                                  >
                                    <span className="dot" style={{ background: modelColor(pmdl) }} />
                                    <span className="mv">{modelShort(pmdl)}</span>
                                    <Icon svg={IC.chev} />
                                  </span>
                                )}
                              </div>
                            )
                          })}
                          <div className="wfo-proj-hint">每个项目各派一个开发代理 · 可分别选择模型 · 取消勾选可将其排除。</div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="wfo-conn">
                  <span className="ln" />
                  <span className="ar" />
                </div>
              </Fragment>
              )
            })}
            <div className="wfo-term end">
              <Icon svg={IC.flag} />结束
            </div>
          </div>
        </div>
        )}

        <div className="wfo-foot">
          <div className="wfo-goal">
            <textarea
              rows={1}
              placeholder="描述本次工作流要达成的目标… 例如：把 tokens 迁移到 OKLch 并补上视觉回归测试"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
            <button className="wfo-start" disabled={goal.trim() === '' || starting} onClick={handleStart}>
              <Icon svg={IC.play} /> 启动
            </button>
          </div>
          {queuedNote && <div className="wfo-queued-note">{queuedNote}</div>}
          {startError && <div className="wfo-start-error">{startError}</div>}
          <div className="wfo-foot-hint">
            <Icon svg={IC.bolt} />
            主代理将按上方流程编排为多代理执行，每个模块使用你指定的模型。<kbd>⌘↩</kbd> 启动
          </div>
        </div>
      </div>
    </div>
  )
}
