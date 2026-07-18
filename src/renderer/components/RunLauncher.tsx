import { useEffect, useState } from 'react'

export interface RunLauncherProps {
  workspacePath: string
  onStarted?: () => void
}

interface LaunchProject {
  name: string
  cwd: string
  provider?: string
  model?: string
}

interface LaunchWorkflow {
  id: string
  name: string
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
export function RunLauncher({ workspacePath, onStarted }: RunLauncherProps) {
  const [info, setInfo] = useState<LaunchInfo>(EMPTY_INFO)
  const [workflowId, setWorkflowId] = useState<string>('')
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [task, setTask] = useState('')
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    let cancelled = false
    const run2 = (window as any).forge?.run2
    if (!run2?.launchInfo) {
      setInfo(EMPTY_INFO)
      return
    }
    run2.launchInfo(workspacePath).then((li: LaunchInfo) => {
      if (cancelled) return
      setInfo(li)
      setWorkflowId(li.workflows[0]?.id ?? '')
      setChecked(Object.fromEntries(li.projects.map((p) => [p.name, true])))
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
    setStarting(true)
    Promise.resolve(
      run2.startWorkflow({
        workspacePath,
        workflowId,
        projectNames,
        task,
        runId: `run2-${Date.now()}`,
      })
    ).finally(() => {
      setStarting(false)
      onStarted?.()
    })
  }

  if (info.workflows.length === 0) {
    return (
      <div className="msg-req k-confirm plan-card run-launcher">
        <div className="req-body">
          <div className="req-title">该工作区暂无工作流</div>
          <div className="req-actions">
            <button className="req-ok" disabled>启动</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="msg-req k-confirm plan-card run-launcher">
      <div className="req-head">
        <span className="req-kind">启动运行</span>
      </div>
      <div className="req-body">
        <div className="req-sub plan-workflow">
          <span>工作流</span>
          <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            {info.workflows.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>
        <div className="plan-stages">
          <span className="plan-stages-label">项目</span>
          <div className="plan-stage-list">
            {info.projects.map((p) => (
              <label key={p.name} className="plan-stage-row plan-stage-head">
                <input
                  type="checkbox"
                  checked={!!checked[p.name]}
                  onChange={() => toggleProject(p.name)}
                  aria-label={p.name}
                />
                <span className="plan-stage-name">{p.name}</span>
              </label>
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
        <div className="req-actions">
          <button className="req-ok" disabled={starting} onClick={start}>启动</button>
        </div>
      </div>
    </div>
  )
}
