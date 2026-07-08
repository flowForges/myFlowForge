import type { AgentState, LogLine } from '@shared/types'
import { HookNode } from '../components/HookNode'
import type { AgentRuntime } from '@shared/types'
import './setupProgress.css'

// Per-hook aggregated state maintained by the parent (App) as events arrive.
export interface HookEntry {
  id: string
  name: string
  phase: '__basic' | '__proj'
  state: AgentState
  logs: LogLine[]
  skills: string[]
  tools: string[]
}

export interface ProvisionedProject {
  name: string
  index: number
  total: number
}

// Full aggregated state fed from App.tsx as SetupEvents arrive. Controlled component for testability.
export interface SetupProgressState {
  started: boolean
  done: boolean
  basicHooks: HookEntry[]
  projHooks: HookEntry[]
  provisionedProjects: ProvisionedProject[]
  total: number
  pulling: { project: string; index: number } | null
  failed: { project: string; index: number; message: string } | null
}

interface SetupProgressProps {
  state: SetupProgressState
  onClose?: () => void
}

function hookToRuntime(hook: HookEntry): AgentRuntime {
  return {
    id: hook.id,
    name: hook.name,
    role: hook.phase === '__basic' ? '基本信息 · 步骤' : '项目拉取 · 步骤',
    provider: '',
    model: '',
    state: hook.state,
    logs: hook.logs,
    hook: true,
    hookSkills: hook.skills,
    hookTools: hook.tools,
  }
}

export function SetupProgress({ state, onClose }: SetupProgressProps) {
  if (!state.started) return null

  const total = state.total || state.provisionedProjects[0]?.total || 0

  return (
    <div className="setup-overlay on">
      <div className="setup-panel">
        {/* Header */}
        <div className="setup-head">
          <div className="setup-head-ic">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
            </svg>
          </div>
          <div className="setup-head-meta">
            <h3>正在配置工作区</h3>
            <span className="setup-head-sub">执行建区 Hook · 拉取项目</span>
          </div>
          {state.done && onClose && (
            <button className="setup-x" onClick={onClose} aria-label="关闭">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div className="setup-body">
          {/* __basic hooks section */}
          {state.basicHooks.length > 0 && (
            <section className="setup-sec">
              <div className="setup-sec-h">
                <span className="setup-sec-tag">基础配置</span>
                <span className="setup-sec-hint">__basic · 项目拉取前执行</span>
              </div>
              <div className="setup-hooks">
                {state.basicHooks.map(hook => (
                  <HookNode key={hook.id} agent={hookToRuntime(hook)} open={true} onToggle={() => {}} />
                ))}
              </div>
            </section>
          )}

          {/* Provision section */}
          <section className="setup-sec">
            <div className="setup-sec-h">
              <span className="setup-sec-tag">拉取项目</span>
              {total > 0 && (
                <span className="setup-sec-hint">
                  {state.provisionedProjects.length} / {total}
                </span>
              )}
            </div>
            <div className="setup-provision-list">
              {total === 0 && state.provisionedProjects.length === 0 && !state.pulling ? (
                <div className="setup-provision-empty">等待拉取…</div>
              ) : (
                Array.from({ length: total }, (_, i) => {
                  const done = state.provisionedProjects.find(p => p.index === i)
                  const pulling = state.pulling?.index === i
                  const failed = state.failed?.index === i
                  const name = done?.name ?? (pulling ? state.pulling!.project : failed ? state.failed!.project : `项目 ${i + 1}`)
                  const cls = done ? ' done' : failed ? ' failed' : pulling ? ' pulling' : ' pending'
                  return (
                    <div key={i} className={`setup-provision-row${cls}`}>
                      <span className="setup-prov-dot" />
                      <span className="setup-prov-name">
                        {pulling ? `正在拉取项目 ${name} (${i + 1}/${total})` : name}
                      </span>
                      {done && <span className="setup-prov-ok">✓</span>}
                      {pulling && <span className="setup-prov-spin" aria-label="拉取中" />}
                      {failed && <span className="setup-prov-err" title={state.failed!.message}>✕</span>}
                    </div>
                  )
                })
              )}
            </div>
            {state.failed && (
              <div className="setup-provision-errmsg">拉取「{state.failed.project}」失败:{state.failed.message}</div>
            )}
          </section>

          {/* __proj hooks section */}
          {state.projHooks.length > 0 && (
            <section className="setup-sec">
              <div className="setup-sec-h">
                <span className="setup-sec-tag">项目配置</span>
                <span className="setup-sec-hint">__proj · 项目拉取后执行</span>
              </div>
              <div className="setup-hooks">
                {state.projHooks.map(hook => (
                  <HookNode key={hook.id} agent={hookToRuntime(hook)} open={true} onToggle={() => {}} />
                ))}
              </div>
            </section>
          )}

          {/* Done indicator */}
          {state.done && (
            <div className="setup-done" data-testid="setup-done">
              <span className="setup-done-ic">✓</span>
              <span>全部完成 — 正在进入工作区</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Reducer: accumulate SetupEvents into SetupProgressState ───────────────────

import type { SetupEvent } from '@shared/types'

export const INITIAL_SETUP_STATE: SetupProgressState = {
  started: false,
  done: false,
  basicHooks: [],
  projHooks: [],
  provisionedProjects: [],
  total: 0,
  pulling: null,
  failed: null,
}

export function applySetupEvent(state: SetupProgressState, event: SetupEvent): SetupProgressState {
  switch (event.type) {
    case 'setup:start':
      return { ...INITIAL_SETUP_STATE, started: true }

    case 'hook:start': {
      const newHook: HookEntry = {
        id: event.plugin.id,
        name: event.plugin.name,
        phase: event.phase,
        state: 'run',
        logs: [],
        skills: event.plugin.skills,
        tools: event.plugin.tools,
      }
      if (event.phase === '__basic') {
        return { ...state, basicHooks: [...state.basicHooks, newHook] }
      }
      return { ...state, projHooks: [...state.projHooks, newHook] }
    }

    case 'hook:log': {
      const updateHooks = (hooks: HookEntry[]) =>
        hooks.map(h => h.id === event.pluginId ? { ...h, logs: [...h.logs, event.line] } : h)
      return {
        ...state,
        basicHooks: updateHooks(state.basicHooks),
        projHooks: updateHooks(state.projHooks),
      }
    }

    case 'hook:state': {
      const updateHooks = (hooks: HookEntry[]) =>
        hooks.map(h => h.id === event.pluginId ? { ...h, state: event.state as AgentState } : h)
      return {
        ...state,
        basicHooks: updateHooks(state.basicHooks),
        projHooks: updateHooks(state.projHooks),
      }
    }

    case 'provision:start':
      return { ...state, total: event.total, pulling: { project: event.project, index: event.index } }

    case 'provision':
      return {
        ...state,
        total: event.total,
        pulling: state.pulling && state.pulling.index === event.index ? null : state.pulling,
        provisionedProjects: [
          ...state.provisionedProjects,
          { name: event.project, index: event.index, total: event.total },
        ],
      }

    case 'provision:error':
      return {
        ...state,
        total: event.total,
        pulling: state.pulling && state.pulling.index === event.index ? null : state.pulling,
        failed: { project: event.project, index: event.index, message: event.message },
      }

    case 'setup:done':
      return { ...state, done: true }

    default:
      return state
  }
}
