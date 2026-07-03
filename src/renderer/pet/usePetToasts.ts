import { useCallback, useEffect, useRef, useState } from 'react'
import type { Pet, EngineEvent } from '@shared/types'

export type ToastKind = 'confirm' | 'input' | 'done'
export interface Toast { id: string; kind: ToastKind; wsName: string; title: string; leaving?: boolean }

export function usePetToasts(notify: Pet['notify']): { toasts: Toast[]; dismiss: (id: string) => void } {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const leaving = useRef(new Set<string>())
  const doneSeen = useRef(new Set<string>())
  const notifyRef = useRef(notify)
  notifyRef.current = notify

  const dismiss = useCallback((id: string) => {
    if (leaving.current.has(id)) return
    leaving.current.add(id)
    const t = timers.current.get(id)
    if (t) clearTimeout(t)
    setToasts(ts => ts.map(x => x.id === id ? { ...x, leaving: true } : x))
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id)
      leaving.current.delete(id)
      setToasts(ts => ts.filter(x => x.id !== id))
    }, 260))
  }, [])

  useEffect(() => {
    const add = (t: Toast) => {
      setToasts(ts => [...ts, t])
      timers.current.set(t.id, setTimeout(() => dismiss(t.id), 7000))
    }
    const off = window.forge.onEngineEvent((e: EngineEvent) => {
      if (e.type === 'pending:add') {
        // 'select' is a needs-input style request — gate it under the 'input' notify toggle.
        const k: ToastKind = e.action.kind === 'select' ? 'input' : e.action.kind
        if (notifyRef.current[k]) add({ id: e.action.id, kind: k, wsName: e.action.wsName, title: e.action.title })
      } else if (e.type === 'pending:resolve') {
        dismiss(e.id)
      } else if (e.type === 'run:update') {
        if (e.run.status === 'ok' && notifyRef.current.done && !doneSeen.current.has(e.run.id)) {
          doneSeen.current.add(e.run.id)
          add({ id: 'done-' + e.run.id, kind: 'done', wsName: e.run.workspaceName, title: '任务完成' })
        }
      }
    })
    const timersAtMount = timers.current
    return () => { off(); timersAtMount.forEach(clearTimeout); timersAtMount.clear() }
  }, [dismiss])

  return { toasts, dismiss }
}
