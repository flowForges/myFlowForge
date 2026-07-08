import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateInfo, InstallProgress, UpdateEvent } from '@shared/types'

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'done' | 'error' | 'uptodate' | 'checkfailed'

export interface UpdateApi {
  currentVersion: string
  info: UpdateInfo | null
  phase: UpdatePhase
  progress: InstallProgress | null
  error: string | null
  check: () => void
  start: () => void
}

export function useUpdate(): UpdateApi {
  const [currentVersion, setCurrentVersion] = useState('')
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const api = useRef(window.forge)

  useEffect(() => {
    let live = true
    void api.current.getUpdate().then(({ currentVersion, info }) => {
      if (!live) return
      setCurrentVersion(currentVersion)
      setInfo(info)
      setPhase(info ? 'available' : 'idle')
    })
    const off = api.current.onUpdateEvent((e: UpdateEvent) => {
      switch (e.type) {
        case 'available': setInfo(e.info); setPhase('available'); break
        case 'none':
          setPhase('uptodate')
          setTimeout(() => setPhase(p => (p === 'uptodate' ? 'idle' : p)), 2500)
          break
        case 'checkfailed':
          // A failed check must NOT read as "up to date". Show 检查失败 briefly, then fall back to idle
          // (keeping any previously-known pending update badge intact — info is untouched here).
          setPhase('checkfailed')
          setTimeout(() => setPhase(p => (p === 'checkfailed' ? 'idle' : p)), 3000)
          break
        case 'progress': setProgress({ stage: e.stage, pct: e.pct, log: e.log }); setPhase('downloading'); break
        case 'done': setPhase('done'); break
        case 'error': setError(e.message); setPhase('error'); break
      }
    })
    return () => { live = false; off() }
  }, [])

  const check = useCallback(() => { setPhase('checking'); void api.current.checkUpdate() }, [])
  const start = useCallback(() => { setError(null); setProgress(null); setPhase('downloading'); void api.current.startUpdate() }, [])

  return { currentVersion, info, phase, progress, error, check, start }
}
