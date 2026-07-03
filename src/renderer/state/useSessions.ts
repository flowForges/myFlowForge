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

export function useSessions(workspacePath: string | undefined): SessionsApi {
  const [file, setFile] = useState<SessionsFile>({ sessions: [], activeSessionId: '' })
  const api = useRef(window.forge)

  useEffect(() => {
    if (!workspacePath) { setFile({ sessions: [], activeSessionId: '' }); return }
    if (!api.current.sessionList) {
      setFile({ sessions: [{ id: 'default', title: '新会话', mode: 'chat', createdAt: 0 }], activeSessionId: 'default' })
      return
    }
    let live = true
    void api.current.sessionList(workspacePath).then((f: SessionsFile) => { if (live) setFile(f) })
    return () => { live = false }
  }, [workspacePath])

  useEffect(() => {
    if (!api.current.onSessionsChanged) return
    const off = api.current.onSessionsChanged((raw: unknown) => {
      const p = raw as { workspacePath: string; file: SessionsFile }
      if (p.workspacePath === workspacePath) setFile(p.file)
    })
    return () => { off() }
  }, [workspacePath])

  const newSession = useCallback(async () => {
    if (!workspacePath || !api.current.sessionNew) return
    setFile(await api.current.sessionNew(workspacePath))
  }, [workspacePath])
  const switchSession = useCallback(async (sessionId: string) => {
    if (!workspacePath || !api.current.sessionSwitch) return
    setFile(await api.current.sessionSwitch({ workspacePath, sessionId }))
  }, [workspacePath])
  const closeSession = useCallback(async (sessionId: string) => {
    if (!workspacePath || !api.current.sessionClose) return
    setFile(await api.current.sessionClose({ workspacePath, sessionId }))
  }, [workspacePath])
  const renameSession = useCallback(async (sessionId: string, title: string) => {
    if (!workspacePath || !api.current.sessionRename) return
    setFile(await api.current.sessionRename({ workspacePath, sessionId, title }))
  }, [workspacePath])

  return { sessions: file.sessions, activeSessionId: file.activeSessionId || undefined, newSession, switchSession, closeSession, renameSession }
}
