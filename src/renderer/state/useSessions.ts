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

const EMPTY: SessionsFile = { sessions: [], activeSessionId: '' }

export function useSessions(workspacePath: string | undefined): SessionsApi {
  // ★状态和它所属的 workspacePath 绑在一起。只存 file 的话,切换工作区时 file 仍是上一个工作区的 ——
  // activeSessionId 也是上一个的,于是标题会先渲染成【上一个工作区那个会话】的名字,等 sessionList 回来
  // 才纠正,肉眼就是「标题闪一下变成别人再变回来」。带上 path 后,不匹配即视为还没加载,宁可空也不显示错的。
  const [state, setState] = useState<{ path: string; file: SessionsFile }>({ path: '', file: EMPTY })
  const api = useRef(window.forge)
  const path = workspacePath ?? ''
  const file = state.path === path ? state.file : EMPTY

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

  useEffect(() => {
    if (!api.current.onSessionsChanged) return
    const off = api.current.onSessionsChanged((raw: unknown) => {
      const p = raw as { workspacePath: string; file: SessionsFile }
      if (p.workspacePath === workspacePath) setState({ path: p.workspacePath, file: p.file })
    })
    return () => { off() }
  }, [workspacePath])

  const newSession = useCallback(async () => {
    if (!workspacePath || !api.current.sessionNew) return
    setState({ path: workspacePath, file: await api.current.sessionNew(workspacePath) })
  }, [workspacePath])
  const switchSession = useCallback(async (sessionId: string) => {
    if (!workspacePath || !api.current.sessionSwitch) return
    setState({ path: workspacePath, file: await api.current.sessionSwitch({ workspacePath, sessionId }) })
  }, [workspacePath])
  const closeSession = useCallback(async (sessionId: string) => {
    if (!workspacePath || !api.current.sessionClose) return
    setState({ path: workspacePath, file: await api.current.sessionClose({ workspacePath, sessionId }) })
  }, [workspacePath])
  const renameSession = useCallback(async (sessionId: string, title: string) => {
    if (!workspacePath || !api.current.sessionRename) return
    setState({ path: workspacePath, file: await api.current.sessionRename({ workspacePath, sessionId, title }) })
  }, [workspacePath])

  return { sessions: file.sessions, activeSessionId: file.activeSessionId || undefined, newSession, switchSession, closeSession, renameSession }
}
