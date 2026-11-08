// 会话列表(08 §7.1):挂载时拉 session.list;列表相关的事件到了,合并 300 ms 再拉一次;重置时马上拉。
// IM 会话的 Telegram 名字:channel.telegram.chats 按 sessionId 对上账号,名字取 status.paired;拿不到就不显示(-32601 照常)。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EventType, SessionSummary } from '@mffai/protocol'
import { call, isUnsupported } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'

export const REFRESH_MS = 300

const TRIGGERS: readonly EventType[] = [
  'session.created', 'session.renamed', 'session.deleted', 'turn.started', 'turn.ended', 'turn.failed',
  'turn.parked', 'turn.resumed', 'approval.requested', 'approval.resolved', 'channel.paired', 'channel.unpaired',
]
/** 这些也要重读 Telegram 的绑定 */
const IM_TRIGGERS = new Set<string>(['session.created', 'session.deleted', 'channel.paired', 'channel.unpaired'])

const newestFirst = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt

async function loadImNames(): Promise<Map<string, string>> {
  const [chats, status] = await Promise.all([
    call('channel.telegram.chats').catch(() => undefined),
    call('channel.telegram.status').catch(() => undefined),
  ])
  const names = new Map((status?.paired ?? []).map((p) => [p.accountId, p.name]))
  return new Map((chats?.chats ?? []).map((c) => [c.sessionId, names.get(c.accountId) ?? c.accountId]))
}

export function useSessions(): {
  sessions: SessionSummary[]
  imNames: Map<string, string>
  reload(): void
  unsupported: boolean
  /** 至少答过一次 */
  loaded: boolean
} {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [imNames, setImNames] = useState<Map<string, string>>(() => new Map())
  const [unsupported, setUnsupported] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const gen = useRef(0)
  const imDirty = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const alive = useRef(true)

  const reload = useCallback(() => {
    const g = ++gen.current
    void call('session.list').then(
      (r) => {
        if (!alive.current || g !== gen.current) return
        setSessions([...r.sessions].sort(newestFirst))
        setUnsupported(false)
        setLoaded(true)
        if (imDirty.current && r.sessions.some((s) => s.origin === 'im')) {
          imDirty.current = false
          void loadImNames().then((m) => { if (alive.current) setImNames(m) })
        }
      },
      (e) => {
        if (!alive.current || g !== gen.current) return
        setUnsupported(isUnsupported(e))
        setLoaded(true)
        if (!isUnsupported(e)) console.error('mffai session.list', e)
      },
    )
  }, [])

  useEffect(() => {
    alive.current = true
    reload()
    return () => { alive.current = false; clearTimeout(timer.current) }
  }, [reload])

  useMffaiEvent({ types: TRIGGERS }, (e) => {
    if (IM_TRIGGERS.has(e.type)) imDirty.current = true
    if (timer.current !== undefined) return
    timer.current = setTimeout(() => { timer.current = undefined; reload() }, REFRESH_MS)
  })
  useMffaiReset(() => {
    imDirty.current = true
    clearTimeout(timer.current)
    timer.current = undefined
    reload()
  })

  return { sessions, imNames, reload, unsupported, loaded }
}
