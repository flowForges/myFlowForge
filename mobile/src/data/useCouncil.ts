import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import type { CouncilState, CouncilStatus } from '../../../src/shared/council'
import type { Conn } from '../net/conn'

/**
 * 手机端的 AI 共商:只**看**和**控**电脑上已经开起来的那几场(§6.6)。
 * ★没有 start / 设置 / 追问 —— 手机上开不了共商,也配不了讨论方。
 * ★`invoke` / `on` 由调用方从 `useConn()` 递进来,不在这里 import `net/conn`:那个文件带着 react-native,
 *  这里的纯函数要在 node 下单测。
 */

// 占着会话的(R9):同一会话同一时间只能有一场在跑;暂停的不占
const HOLDING = new Set<CouncilStatus>(['running', 'finalizing'])

/** council:state 是全局广播 —— 只认本会话的;别的会话原样返回同一个数组,不触发重渲染。 */
export function applyCouncilState(
  list: CouncilState[],
  s: CouncilState,
  wsPath: string | null,
  sessionId: string | null,
): CouncilState[] {
  if (!wsPath || !sessionId || s.workspacePath !== wsPath || s.sessionId !== sessionId) return list
  const i = list.findIndex((x) => x.id === s.id)
  if (i < 0) return [...list, s]
  const next = list.slice()
  next[i] = s
  return next
}

/** ★快照回来之前可能已经收到了推送 —— 推送更新,快照不能把它盖回去。 */
export function mergeCouncilSnapshot(cur: CouncilState[], snapshot: CouncilState[]): CouncilState[] {
  return snapshot.reduce((acc, s) => (acc.some((x) => x.id === s.id) ? acc : [...acc, s]), cur)
}

/** 进行中的那一场:优先 running / finalizing(一个会话同时最多一场),没有才取 paused 的。 */
export function activeCouncil(states: CouncilState[]): CouncilState | undefined {
  // ★暂停的那场不挡新开的(R9),同一会话里可能同时有一场暂停的和一场在跑的
  return states.find((s) => HOLDING.has(s.status)) ?? states.find((s) => s.status === 'paused')
}

/** 轮间等用户(「每轮结束后等我」):引擎停在两轮之间,等人补充或「继续下一轮」。用户暂停 / 领导者失败的暂停不算。 */
export function isCouncilBreak(s?: Pick<CouncilState, 'status' | 'waitingForUser'>): boolean {
  return s?.status === 'paused' && !!s.waitingForUser
}

/**
 * 输入框提交走插话还是普通发送。running 和轮间等用户时插话(引擎只在这两种时候收)。
 * ★普通暂停时插话没人听,finalizing 时输入框整个禁用 —— 都走普通发送。
 */
export function submitTarget(s?: Pick<CouncilState, 'status' | 'waitingForUser'>): 'interject' | 'send' {
  return s?.status === 'running' || isCouncilBreak(s) ? 'interject' : 'send'
}

/** 状态行的轮次。★轮间等用户时引擎已把 round 推到下一轮;这里说的是刚结束的那一轮(同电脑端)。 */
export function councilRoundLabel(s: CouncilState): string {
  if (isCouncilBreak(s)) return `第 ${s.round - 1} 轮结束`
  return s.totalRounds ? `第 ${s.round} / ${s.totalRounds} 轮` : `第 ${s.round} 轮`
}

const ACTION_ERRORS: Record<string, string> = {
  'not-done': '共商尚未结束',
  busy: '当前会话正忙',
  'target-invalid': '配置无效',
}
// ★同电脑端:busy 因动作而异 —— 追问的 busy = 上一问还在答;继续的 busy = 会话被占着(R9/R10)
const FOLLOWUP_ERRORS: Record<string, string> = { busy: '正在回答上一个追问' }

export type CouncilAction = 'followup' | 'resume' | 'control'

/** 控制调用失败时给人看的一句话。同电脑端 `councilActionError`:剥掉前缀取错误码。 */
export function councilActionError(e: unknown, action: CouncilAction = 'control'): string {
  const raw = e instanceof Error ? e.message : String(e)
  const code = raw.replace(/^Error invoking remote method '[^']*': /, '').replace(/^Error: /, '').trim()
  return (action === 'followup' ? FOLLOWUP_ERRORS[code] : undefined) ?? ACTION_ERRORS[code] ?? '操作失败'
}

export type CouncilControls = {
  pause(id: string): Promise<boolean>
  resume(id: string): Promise<boolean>
  stop(id: string, mode: 'finalize' | 'abort'): Promise<boolean>
  interject(id: string, text: string): Promise<boolean>
  choose(id: string, name: string): Promise<boolean>
}

export function useCouncil(
  conn: Pick<Conn, 'invoke' | 'on' | 'online' | 'syncTick'>,
  wsPath: string | null,
  sessionId: string | null,
  /** 控制失败时的那句话怎么给人看 —— 手机上没有 toast,由对话屏决定。 */
  onError: (msg: string) => void,
): CouncilControls & { states: CouncilState[]; active: CouncilState | undefined } {
  const { invoke, on, online, syncTick } = conn
  const [states, setStates] = useState<CouncilState[]>([])
  const keyRef = useRef({ wsPath, sessionId })
  keyRef.current = { wsPath, sessionId }
  const errRef = useRef(onError)
  errRef.current = onError

  // ★先订阅再拉快照,理由同 useChat:反过来的话快照可能盖掉中间到的推送。
  useEffect(() => {
    const off = on(CH.councilState, (payload) => {
      const k = keyRef.current
      setStates((cur) => applyCouncilState(cur, payload as CouncilState, k.wsPath, k.sessionId))
    })
    return off
  }, [on])

  useEffect(() => {
    setStates([])
  }, [wsPath, sessionId])

  useEffect(() => {
    if (!wsPath || !sessionId || !online) return
    let alive = true
    void (async () => {
      try {
        const list = (await invoke(CH.councilList, [{ workspacePath: wsPath, sessionId }])) as CouncilState[]
        if (alive && Array.isArray(list)) setStates((cur) => mergeCouncilSnapshot(cur, list))
      } catch {
        // ★老主机没有共商 IPC:当这个会话没有共商,不连累整屏。
      }
    })()
    return () => {
      alive = false
    }
  }, [wsPath, sessionId, online, invoke, syncTick])

  // ★控制调用一律兜住:失败给一句话、resolve 成 false,从不 reject
  const settle = useCallback(
    (ch: string, arg: object) =>
      invoke(ch, [arg]).then(
        () => true,
        (e: unknown) => {
          errRef.current(councilActionError(e, ch === CH.councilResume ? 'resume' : ch === CH.councilFollowup ? 'followup' : 'control'))
          return false
        },
      ),
    [invoke],
  )

  const pause = useCallback((id: string) => settle(CH.councilPause, { councilId: id }), [settle])
  // ★换领导者(领导者失败后)只在电脑端做;手机上「继续」就是原样接着跑。
  const resume = useCallback((id: string) => settle(CH.councilResume, { councilId: id }), [settle])
  const stop = useCallback((id: string, mode: 'finalize' | 'abort') => settle(CH.councilStop, { councilId: id, mode }), [settle])
  const interject = useCallback((id: string, text: string) => settle(CH.councilInterject, { councilId: id, text }), [settle])
  const choose = useCallback((id: string, name: string) => settle(CH.councilChoose, { councilId: id, candidate: name }), [settle])

  const active = useMemo(() => activeCouncil(states), [states])
  return { states, active, pause, resume, stop, interject, choose }
}
