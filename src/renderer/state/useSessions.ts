import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatSession, SessionsFile } from '@shared/types'

export interface SessionsApi {
  sessions: ChatSession[]
  activeSessionId: string | undefined
  newSession: () => Promise<void>
  switchSession: (sessionId: string) => Promise<void>
  closeSession: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
}

/**
 * 「我在这台设备上看的是哪个会话」。
 *
 * ★★★2026-09-20 用户原话:「我在 windows 或者本机,不管点哪个会话,另外一个也跟着跳过去」。
 *  原因:选中项一直读的是主机那份 `activeSessionId` —— 那是**工作区里**的一个值
 *  (`.forge/chat-session.json`),谁切都写它,写完广播给所有连着的设备,于是所有人一起跳。
 *
 * 现在:**选中项归设备**。主机那份仍然写(机器人那条路和「新设备第一次进来看哪个」还要用它),
 *  但只在这台设备还没有自己的选择、或者它选的那个会话已经不存在时才拿来当默认值。
 */
export interface SessionsPrefs {
  /** 这台设备记住的选择(App 从 settings.lastActiveSession 里按 `${hostKey}::${path}` 取好传进来) */
  remembered?: string
  /** 选中变化时回写(App 落进 settings.lastActiveSession) */
  onPick?: (workspacePath: string, sessionId: string) => void
}

const EMPTY: SessionsFile = { sessions: [], activeSessionId: '' }

export function useSessions(workspacePath: string | undefined, prefs: SessionsPrefs = {}): SessionsApi {
  // ★状态和它所属的 workspacePath 绑在一起。只存 file 的话,切换工作区时 file 仍是上一个工作区的 ——
  // activeSessionId 也是上一个的,于是标题会先渲染成【上一个工作区那个会话】的名字,等 sessionList 回来
  // 才纠正,肉眼就是「标题闪一下变成别人再变回来」。带上 path 后,不匹配即视为还没加载,宁可空也不显示错的。
  const [state, setState] = useState<{ path: string; file: SessionsFile }>({ path: '', file: EMPTY })
  // 这台设备自己的选择。★和 state 一样绑着 path —— 否则切工作区的那一帧会拿上一个工作区的选择去比。
  const [picked, setPicked] = useState<{ path: string; id: string }>({ path: '', id: '' })
  const api = useRef(window.forge)
  const path = workspacePath ?? ''
  const file = state.path === path ? state.file : EMPTY
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  /**
   * 落到界面上的选中项:先认这台设备的选择,它不在了(被别的设备关掉、或还没选过)才退到
   * 主机那份 `activeSessionId`,再不行就第一个会话。
   * ★「它不在了」这一步必须有:不然关掉当前会话之后界面会指着一个不存在的 id,右边一片空白。
   */
  const mine = picked.path === path ? picked.id : (prefs.remembered ?? '')
  const activeSessionId =
    (mine && file.sessions.some(s => s.id === mine) ? mine : '') ||
    (file.activeSessionId && file.sessions.some(s => s.id === file.activeSessionId) ? file.activeSessionId : '') ||
    file.sessions[0]?.id || ''

  /** 选中变了就记在这台设备上。★只记「人主动选的那一下」,不记跟随主机的回落值。 */
  const pick = useCallback((sessionId: string) => {
    if (!path || !sessionId) return
    setPicked({ path, id: sessionId })
    prefsRef.current.onPick?.(path, sessionId)
  }, [path])

  useEffect(() => {
    if (!workspacePath) { setState({ path: '', file: EMPTY }); return }
    if (!api.current.sessionList) {
      setState({ path: workspacePath, file: { sessions: [{ id: 'default', title: '新会话', mode: 'chat', createdAt: 0 }], activeSessionId: 'default' } })
      return
    }
    let live = true
    void api.current.sessionList(workspacePath).then((f: SessionsFile) => { if (live) setState({ path: workspacePath, file: f }) })
    return () => { live = false }
  }, [workspacePath])

  // 当前落在界面上的那个 id,给下面的广播处理用(它要在应用新 file **之前**把「我正在看的」钉住)。
  const activeRef = useRef('')
  activeRef.current = activeSessionId

  useEffect(() => {
    if (!api.current.onSessionsChanged) return
    const off = api.current.onSessionsChanged((raw: unknown) => {
      const p = raw as { workspacePath: string; file: SessionsFile }
      if (p.workspacePath !== workspacePath) return
      // ★★这条广播可能是**别的设备**切了会话(它照样会写主机那份 activeSessionId)。
      //  列表要跟上(新建/关闭/改名都走这条),但**选中项不许动** —— 那正是用户报的
      //  「我在 windows 点一个会话,本机也跟着跳过去」。这台设备还没选过的话,
      //  就把此刻正在看的这个钉成它的选择,之后别人再切也带不动它。
      setPicked(prev => (prev.path === p.workspacePath ? prev : { path: p.workspacePath, id: activeRef.current }))
      setState({ path: p.workspacePath, file: p.file })
    })
    return () => { off() }
  }, [workspacePath])

  const newSession = useCallback(async () => {
    if (!workspacePath || !api.current.sessionNew) return
    const f = await api.current.sessionNew(workspacePath)
    setState({ path: workspacePath, file: f })
    // 新建的那个就是主机刚置为 active 的那个 —— 新建的人当然要跳过去看它。
    if (f.activeSessionId) pick(f.activeSessionId)
  }, [workspacePath, pick])
  const switchSession = useCallback(async (sessionId: string) => {
    if (!workspacePath || !api.current.sessionSwitch) return
    // ★先记在本设备上,再告诉主机。主机那份照旧要写(机器人/新设备首次进入还认它),
    //  但**别的设备不会再跟着跳** —— 它们各自认自己的选择。
    pick(sessionId)
    setState({ path: workspacePath, file: await api.current.sessionSwitch({ workspacePath, sessionId }) })
  }, [workspacePath, pick])
  const closeSession = useCallback(async (sessionId: string) => {
    if (!workspacePath || !api.current.sessionClose) return
    const f = await api.current.sessionClose({ workspacePath, sessionId })
    setState({ path: workspacePath, file: f })
    // 关掉的正是我在看的那个 → 跟着主机的回落走(它挑的是前一个),并记成这台设备的新选择。
    if (sessionId === activeSessionId && f.activeSessionId) pick(f.activeSessionId)
  }, [workspacePath, activeSessionId, pick])
  const renameSession = useCallback(async (sessionId: string, title: string) => {
    if (!workspacePath || !api.current.sessionRename) return
    setState({ path: workspacePath, file: await api.current.sessionRename({ workspacePath, sessionId, title }) })
  }, [workspacePath])

  return { sessions: file.sessions, activeSessionId: activeSessionId || undefined, newSession, switchSession, closeSession, renameSession }
}
