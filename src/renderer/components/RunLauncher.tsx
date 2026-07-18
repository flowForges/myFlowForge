import { useEffect, useState } from 'react'

export interface RunLauncherProps {
  workspacePath: string
  onStarted?: () => void
  // Task 2: opened from a workflow "/" command in chat — pre-seeds the requirement textarea with the
  // current conversation transcript and preselects the workflow the user picked. One-time bring-in
  // (lazy useState initializer): no follow-up sync if these props change after mount.
  initialSeed?: string
  initialWorkflowId?: string
}

interface LaunchProject {
  name: string
  cwd: string
  provider?: string
  model?: string
}

// Task 1 (main): mirrors LaunchStage in src/main/run/launch.ts — the resolved per-stage
// name/provider/model/gate the launcher picker needs to render a workflow's flow preview. Task 2 wires
// this into the actual preview UI; unused here for now (fields carried through so the type matches the
// IPC payload's real shape and typecheck stays honest about what's on the wire).
interface LaunchStage {
  key: string
  name: string
  provider: string
  model: string
  gate: boolean
}

interface LaunchWorkflow {
  id: string
  name: string
  stages: LaunchStage[]
}

interface LaunchInfo {
  workflows: LaunchWorkflow[]
  projects: LaunchProject[]
}

const EMPTY_INFO: LaunchInfo = { workflows: [], projects: [] }

// Start dialog for the run2 engine (P4-A). Loads a workspace's named workflows + projects via
// window.forge.run2.launchInfo, lets the user pick a workflow + which projects to include + type a
// requirement seed, then kicks off window.forge.run2.startWorkflow. Mirrors PlanCard/ReqCard's
// .req-* / .plan-* markup conventions so it drops into the same visual language without new CSS.
export function RunLauncher({ workspacePath, onStarted, initialSeed, initialWorkflowId }: RunLauncherProps) {
  const [info, setInfo] = useState<LaunchInfo>(EMPTY_INFO)
  const [workflowId, setWorkflowId] = useState<string>(initialWorkflowId ?? '')
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [task, setTask] = useState(() => initialSeed ?? '')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Task 2 (queue): set when manager.start() reports {status:'queued'} — a queued launch isn't
  // the active run yet, so we stay on this screen and just note the position instead of firing
  // onStarted (which would switch the caller into the run view for a run that hasn't begun).
  const [queuedNote, setQueuedNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const run2 = (window as any).forge?.run2
    if (!run2?.launchInfo) {
      setInfo(EMPTY_INFO)
      return
    }
    run2.launchInfo(workspacePath)
      .then((li: LaunchInfo) => {
        if (cancelled) return
        setInfo(li)
        // Preserve an already-picked workflow (from initialWorkflowId) once the info load completes;
        // otherwise fall back to the first workflow, as before.
        setWorkflowId((prev) => prev || li.workflows[0]?.id || '')
        setChecked(Object.fromEntries(li.projects.map((p) => [p.name, true])))
        setError(null)
      })
      .catch((err: any) => {
        if (cancelled) return
        setError('加载工作流失败')
      })
    return () => {
      cancelled = true
    }
  }, [workspacePath])

  const toggleProject = (name: string) => setChecked((m) => ({ ...m, [name]: !m[name] }))

  const start = () => {
    const run2 = (window as any).forge?.run2
    if (!run2?.startWorkflow || !workflowId) return
    const projectNames = info.projects.filter((p) => checked[p.name]).map((p) => p.name)
    setError(null)
    setQueuedNote(null)
    setStarting(true)
    Promise.resolve(
      run2.startWorkflow({
        workspacePath,
        workflowId,
        projectNames,
        task,
        runId: `run2-${Date.now()}`,
      })
    )
      .then((result: unknown) => {
        // manager.start() now returns a union: {status:'started', state} | {status:'queued', position}.
        // Only the 'queued' shape changes behavior — everything else (the 'started' shape, a legacy
        // void/undefined return, or any other unexpected shape) falls back to the old onStarted().
        if (result && typeof result === 'object' && (result as { status?: unknown }).status === 'queued') {
          const position = (result as { position?: unknown }).position
          setQueuedNote(`已加入队列（位置 ${position}），等待当前工作流完成`)
          return
        }
        onStarted?.()
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setStarting(false)
      })
  }

  if (info.workflows.length === 0) {
    return (
      <div className="msg-req plan-card run-launcher">
        <div className="req-body">
          {error ? (
            <div className="launcher-error">{error}</div>
          ) : (
            <div className="req-title">该工作区暂无工作流</div>
          )}
          <div className="req-actions">
            <button className="req-ok" disabled>启动</button>
          </div>
        </div>
      </div>
    )
  }

  // The selected workflow's stage flow — recomputed from `info` on every render so switching the
  // <select> (or a fresh launchInfo load) always reflects the currently-picked workflow.
  const selectedWorkflow = info.workflows.find((w) => w.id === workflowId)
  const stages = selectedWorkflow?.stages ?? []

  return (
    <div className="msg-req plan-card run-launcher">
      <div className="req-head">
        <span className="req-kind">启动运行</span>
      </div>
      <div className="req-body">
        {error && <div className="launcher-error">{error}</div>}
        <div className="req-title">启动工作流</div>
        <div className="req-sub plan-workflow">
          <span>工作流</span>
          <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            {info.workflows.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>
        <div className="run2-launch-stages">
          {stages.length === 0 ? (
            <div className="run2-launch-stages-empty">（无阶段）</div>
          ) : (
            stages.map((s, i) => (
              <div key={s.key} className="run2-launch-stage">
                {i > 0 && <span className="run2-launch-stage-link" aria-hidden="true" />}
                <span className="run2-launch-stage-index">{i + 1}</span>
                <div className="run2-launch-stage-main">
                  <span className="run2-launch-stage-name">{s.name}</span>
                  <span className="run2-launch-stage-model">{s.provider}·{s.model}</span>
                </div>
                {s.gate && <span className="run2-launch-stage-gate">门</span>}
              </div>
            ))
          )}
        </div>
        <div className="run2-launch-projects">
          <span className="run2-launch-projects-label">项目</span>
          <div className="run2-launch-project-chips">
            {info.projects.map((p) => (
              <button
                key={p.name}
                type="button"
                className={`run2-launch-chip${checked[p.name] ? ' on' : ''}`}
                onClick={() => toggleProject(p.name)}
                aria-label={p.name}
                aria-pressed={!!checked[p.name]}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <div className="req-sub plan-task">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="描述这次要做什么…"
            rows={3}
          />
        </div>
        {queuedNote && <div className="run2-queued-note">{queuedNote}</div>}
        <div className="req-actions">
          <button className="req-ok" disabled={starting} onClick={start}>启动</button>
        </div>
      </div>
    </div>
  )
}
