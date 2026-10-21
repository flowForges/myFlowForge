import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CouncilConfig, CouncilSeat, CouncilState } from '@shared/council'
import { flashToast } from '../components/flashToast'

export type CouncilLastConfig = Omit<CouncilConfig, 'topic' | 'attachments'>

export type CouncilApi = {
  /** 这个会话里的全部共商(进行中 + 已结束)。 */
  states: CouncilState[]
  /** 进行中的那一场:优先 running / finalizing(一个会话同时最多一场),没有才取 paused 的。 */
  active: CouncilState | undefined
  lastConfig: CouncilLastConfig | null
  start(cfg: CouncilConfig): Promise<void>
  // 控制类调用:失败时弹一句提示,resolve 成 false(从不 reject);成功 resolve 成 true。
  pause(id: string): Promise<boolean>
  /** newLeader:领导者失败暂停后换一位接着跑(§7.3)。 */
  resume(id: string, newLeader?: CouncilSeat): Promise<boolean>
  stop(id: string, mode: 'finalize' | 'abort'): Promise<boolean>
  interject(id: string, text: string): Promise<boolean>
  followup(id: string, q: string, target: 'all' | string): Promise<boolean>
  choose(id: string, name: string): Promise<boolean>
  /** 当前工作区里可选作参考材料的项目。 */
  projects(): Promise<{ name: string; cwd: string }[]>
}

const ACTION_ERRORS: Record<string, string> = {
  'not-done': '共商尚未结束',
  busy: '当前会话正忙',
  'target-invalid': '配置无效',
}
// ★同一个 busy 因动作而异:追问的 busy = 上一问还在答;继续的 busy = 会话被普通对话 / 另一场共商占着(R9/R10)
const FOLLOWUP_ERRORS: Record<string, string> = { busy: '正在回答上一个追问' }

export type CouncilAction = 'followup' | 'resume' | 'control'

/**
 * 控制类 IPC 失败时给用户看的一句话。invoke 的错误长这样:
 * "Error invoking remote method 'council:followup': Error: not-done" —— 取最后那段当错误码。
 */
export function councilActionError(e: unknown, action: CouncilAction = 'control'): string {
  const raw = e instanceof Error ? e.message : String(e)
  const msg = raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '').trim()
  return (action === 'followup' ? FOLLOWUP_ERRORS[msg] : undefined) ?? ACTION_ERRORS[msg] ?? '操作失败'
}

// ★控制调用一律兜住:原来是 `void invoke(...)`,主进程一抛就成了未处理的 rejection,用户什么也看不到
function settle(call: () => Promise<unknown>, action: CouncilAction = 'control'): Promise<boolean> {
  let p: Promise<unknown>
  try { p = Promise.resolve(call()) } catch (e) { p = Promise.reject(e) }
  return p.then(() => true, (e: unknown) => { flashToast(councilActionError(e, action)); return false })
}

// 占着会话的(R9):同一会话同一时间只能有一场在跑;暂停的不占
const HOLDING = new Set<CouncilState['status']>(['running', 'finalizing'])

function upsert(list: CouncilState[], s: CouncilState): CouncilState[] {
  const i = list.findIndex(x => x.id === s.id)
  if (i < 0) return [...list, s]
  const next = list.slice()
  next[i] = s
  return next
}

export function useCouncil(workspacePath?: string, sessionId?: string): CouncilApi {
  const [states, setStates] = useState<CouncilState[]>([])
  const [lastConfig, setLastConfig] = useState<CouncilLastConfig | null>(null)
  const api = useRef(window.forge)

  useEffect(() => {
    setStates([])
    if (!workspacePath || !sessionId) return
    let live = true
    // ★快照回来之前可能已经收到了 council:state 推送 —— 推送更新,快照不能把它盖回去
    // ★老 preload / 测试桩里可能没有共商 IPC:没有就当这个会话没有共商,不让整个工作区视图跟着崩。
    void api.current.councilList?.({ workspacePath, sessionId }).then(list => {
      if (!live) return
      setStates(cur => list.reduce((acc, s) => (acc.some(x => x.id === s.id) ? acc : [...acc, s]), cur))
    })
    const off = api.current.onCouncilState?.(s => {
      if (s.workspacePath !== workspacePath || s.sessionId !== sessionId) return
      setStates(cur => upsert(cur, s))
    })
    return () => { live = false; off?.() }
  }, [workspacePath, sessionId])

  useEffect(() => {
    setLastConfig(null)
    if (!workspacePath) return
    let live = true
    void api.current.councilLastConfig?.({ workspacePath }).then(c => { if (live) setLastConfig(c) })
    return () => { live = false }
  }, [workspacePath])

  const start = useCallback(async (cfg: CouncilConfig) => {
    if (!workspacePath || !sessionId) return
    await api.current.councilStart({ workspacePath, sessionId, config: cfg })
    const { topic: _topic, attachments: _attachments, ...rest } = cfg
    setLastConfig(rest)
  }, [workspacePath, sessionId])

  const pause = useCallback((id: string) => settle(() => api.current.councilPause({ councilId: id })), [])
  const resume = useCallback((id: string, newLeader?: CouncilSeat) =>
    settle(() => api.current.councilResume(newLeader ? { councilId: id, newLeader } : { councilId: id }), 'resume'), [])
  const stop = useCallback((id: string, mode: 'finalize' | 'abort') => settle(() => api.current.councilStop({ councilId: id, mode })), [])
  const interject = useCallback((id: string, text: string) => settle(() => api.current.councilInterject({ councilId: id, text })), [])
  const followup = useCallback((id: string, q: string, target: 'all' | string) =>
    settle(() => api.current.councilFollowup({ councilId: id, question: q, target }), 'followup'), [])
  const choose = useCallback((id: string, name: string) => settle(() => api.current.councilChoose({ councilId: id, candidate: name })), [])
  const projects = useCallback(async () => {
    if (!workspacePath) return []
    return api.current.councilProjects({ workspacePath })
  }, [workspacePath])

  // ★暂停的那场不挡新开的:有正在跑的就取正在跑的,否则才取暂停的那场
  const active = useMemo(() => states.find(s => HOLDING.has(s.status)) ?? states.find(s => s.status === 'paused'), [states])

  return { states, active, lastConfig, start, pause, resume, stop, interject, followup, choose, projects }
}
