import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateInfo, InstallProgress, UpdateEvent, UpdateBusyItem } from '@shared/types'

// 'ready' = 已下载完,但有会话在跑所以没装(busy 里是清单;waiting=在等它们跑完自动装)。
//   busy 为空的 'ready' 是「界面重开时发现已经下好了」—— 只差用户点一下「安装并重启」。
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'done' | 'error' | 'uptodate' | 'checkfailed'
export type ApplyMode = 'now' | 'wait' | 'force' | 'cancel'

export interface UpdateApi {
  currentVersion: string
  info: UpdateInfo | null
  phase: UpdatePhase
  progress: InstallProgress | null
  error: string | null
  busy: UpdateBusyItem[]
  waiting: boolean
  check: () => void
  start: () => void
  apply: (mode: ApplyMode) => void
}

export function useUpdate(): UpdateApi {
  const [currentVersion, setCurrentVersion] = useState('')
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<UpdateBusyItem[]>([])
  const [waiting, setWaiting] = useState(false)
  const api = useRef(window.forge)
  const infoRef = useRef<UpdateInfo | null>(null)
  infoRef.current = info

  useEffect(() => {
    let live = true
    void api.current.getUpdate().then(({ currentVersion, info, downloaded }) => {
      if (!live) return
      setCurrentVersion(currentVersion)
      setInfo(info)
      setPhase(info ? (downloaded ? 'ready' : 'available') : 'idle')
    })
    const off = api.current.onUpdateEvent((e: UpdateEvent) => {
      switch (e.type) {
        case 'available':
          // 主进程每 10 分钟后台检查一次,每次都会再发一遍 available。同一个版本正在下载 / 已下好在等用户时,
          // 不能被它打回「立即升级」—— 那样点下去会从头再下一遍。换了新版本号才算真的「有新的可用」。
          setPhase(p => ((p === 'ready' || p === 'downloading') && infoRef.current?.version === e.info.version ? p : 'available'))
          setInfo(e.info)
          break
        case 'none':
          setPhase('uptodate')
          setTimeout(() => setPhase(p => (p === 'uptodate' ? 'idle' : p)), 2500)
          break
        case 'checkfailed':
          // A failed check must NOT read as "up to date". Show 检查失败 briefly, then fall back to idle
          // (keeping any previously-known pending update badge intact — info is untouched here).
          // Keep the real reason (proxy down / 403 rate-limit / network) so the tooltip can surface it
          // instead of swallowing it — this used to be dropped, making failures undiagnosable.
          setError(e.message || null)
          setPhase('checkfailed')
          setTimeout(() => setPhase(p => (p === 'checkfailed' ? 'idle' : p)), 3000)
          break
        case 'progress': setProgress({ stage: e.stage, pct: e.pct, log: e.log }); setPhase('downloading'); break
        case 'ready': setBusy(e.busy); setWaiting(e.waiting); setPhase('ready'); break
        case 'done': setPhase('done'); break
        case 'error': setError(e.message); setPhase('error'); break
      }
    })
    return () => { live = false; off() }
  }, [])

  const check = useCallback(() => { setPhase('checking'); void api.current.checkUpdate() }, [])
  const start = useCallback(() => { setError(null); setProgress(null); setPhase('downloading'); void api.current.startUpdate() }, [])

  const apply = useCallback((mode: ApplyMode) => {
    if (mode === 'force' || mode === 'now') setWaiting(false)
    void api.current.applyUpdate(mode)
  }, [])

  return { currentVersion, info, phase, progress, error, busy, waiting, check, start, apply }
}
