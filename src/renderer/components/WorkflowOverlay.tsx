import { Fragment, useEffect, useState } from 'react'
import './workflowOverlay.css'

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
}

// Task 3: kept a single flat accent-color dot for every stage's model chip — the prototype's real
// modelColor() maps a specific MODELS table (label -> oklch color) that only exists once the model
// picker (Task 4) is wired up with a real provider/model catalog. Acceptable per the task brief; Task 4
// replaces this with a real per-model color lookup.
function modelColor(_stage: LaunchStage): string {
  return 'var(--accent)'
}

function Icon({ svg }: { svg: string }) {
  return <span dangerouslySetInnerHTML={{ __html: svg }} />
}

// P5-UI WF-A Task 2: opened from a workflow "/" command in chat. Loads launchInfo, lets the user pick a
// workflow tab + type a goal. Task 3 fills in the `.wfo-flow` stage chart; Task 5 wires the 启动 button
// to actually start a run (kept as a stub here — onStarted is threaded through for that later task).
export function WorkflowOverlay({ workspacePath, initialSeed, onClose, onStarted }: WorkflowOverlayProps) {
  const [info, setInfo] = useState<LaunchInfo>(EMPTY_INFO)
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>('')
  const [goal, setGoal] = useState(() => initialSeed ?? '')
  // Task 3: per-stage expanded state for the config-state flowchart nodes. Mirrors the prototype's
  // st.openNode, which is wiped whenever the workflow tab switches (initWf() resets it) — see
  // selectWorkflow below.
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({})

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

  // Task 5 wires this to window.forge.run2.startWorkflow + onStarted(); kept a no-op stub for now.
  const handleStart = () => {
    // stub
  }

  // Switching workflow tabs resets which nodes are expanded (prototype's initWf() does the same).
  const selectWorkflow = (id: string) => {
    setSelectedWorkflowId(id)
    setOpenNodes({})
  }
  const toggleNode = (key: string) => {
    setOpenNodes((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const stages = info.workflows.find((w) => w.id === selectedWorkflowId)?.stages ?? []

  return (
    <div className="wfo">
      <div className="wfo-scrim" onClick={onClose} />
      <div className="wfo-panel">
        <div className="wfo-head">
          <div className="wfo-title">
            <span className="ti"><Icon svg={IC.flow} /></span>
            <span className="tt">
              开启工作流
              <small>选择流程 · 配置模块 · 下达目标</small>
            </span>
            <button className="wfo-x" title="关闭" onClick={onClose}>
              <Icon svg={IC.close} />
            </button>
          </div>
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
        </div>

        <div className="wfo-flow">
          <div className="wfo-chart">
            <div className="wfo-term start">
              <Icon svg={IC.play} />开始
            </div>
            <div className="wfo-conn">
              <span className="ln" />
              <span className="ar" />
            </div>
            {stages.map((stage) => (
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
                          <span className="dot" style={{ background: modelColor(stage) }} />
                          <span className="mv">{stage.provider} · {stage.model}</span>
                        </span>
                      ) : (
                        <span className="wfo-model" data-model={stage.key}>
                          <span className="dot" style={{ background: modelColor(stage) }} />
                          <span className="mv">{stage.provider} · {stage.model}</span>
                          <Icon svg={IC.chev} />
                        </span>
                      )}
                      <span className="wfo-chev">
                        <Icon svg={IC.chev} />
                      </span>
                    </div>
                    <div className="wfo-cardbody" />
                  </div>
                </div>
                <div className="wfo-conn">
                  <span className="ln" />
                  <span className="ar" />
                </div>
              </Fragment>
            ))}
            <div className="wfo-term end">
              <Icon svg={IC.flag} />结束
            </div>
          </div>
        </div>

        <div className="wfo-foot">
          <div className="wfo-goal">
            <textarea
              rows={1}
              placeholder="描述本次工作流要达成的目标… 例如：把 tokens 迁移到 OKLch 并补上视觉回归测试"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
            <button className="wfo-start" disabled={goal.trim() === ''} onClick={handleStart}>
              <Icon svg={IC.play} /> 启动
            </button>
          </div>
          <div className="wfo-foot-hint">
            <Icon svg={IC.bolt} />
            主代理将按上方流程编排为多代理执行，每个模块使用你指定的模型。<kbd>⌘↩</kbd> 启动
          </div>
        </div>
      </div>
    </div>
  )
}
