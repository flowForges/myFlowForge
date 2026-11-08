// 每个窗口只有一个 onEvent 订阅(08 §6.3),按引用计数:第一个订阅者来了才注册,最后一个走了就退掉。
// 同样只有一个 onAlert 订阅,把 {kind:'reset'} 发给 onMffaiReset 的订阅者(评审修订 R11)。
import { useEffect, useRef } from 'react'
import type { EventType, KernelEvent, MffaiAlert } from '@mffai/protocol'

export interface EventFilter { types?: readonly EventType[]; sessionId?: string }
type Sub = { types?: ReadonlySet<string>; sessionId?: string; cb: (e: KernelEvent) => void }

const subs = new Set<Sub>()
let offEvent: (() => void) | undefined
const resets = new Set<() => void>()
let offAlert: (() => void) | undefined

function safe(f: () => void): void {
  try { f() } catch (err) { console.error('mffai event', err) }
}

function dispatch(e: KernelEvent): void {
  for (const s of [...subs]) {
    if (s.types && !s.types.has(e.type)) continue
    if (s.sessionId !== undefined && e.sessionId !== s.sessionId) continue
    safe(() => s.cb(e))
  }
}

export function onMffaiEvent(filter: EventFilter, cb: (e: KernelEvent) => void): () => void {
  const s: Sub = { cb, ...(filter.types && { types: new Set(filter.types) }), ...(filter.sessionId !== undefined && { sessionId: filter.sessionId }) }
  subs.add(s)
  if (!offEvent) offEvent = window.forge.mffai.onEvent(dispatch)
  return () => {
    if (!subs.delete(s) || subs.size) return
    const off = offEvent
    offEvent = undefined
    off?.()
  }
}

function onAlert(a: MffaiAlert): void {
  if (a?.kind !== 'reset') return
  for (const cb of [...resets]) safe(cb)
}

/** 后台的事件流重置了:页面丢掉缓存全部重取 */
export function onMffaiReset(cb: () => void): () => void {
  const wrapped = () => cb()
  resets.add(wrapped)
  if (!offAlert) offAlert = window.forge.mffai.onAlert(onAlert)
  return () => {
    if (!resets.delete(wrapped) || resets.size) return
    const off = offAlert
    offAlert = undefined
    off?.()
  }
}

/** 挂载期间订阅;cb 总是最新的那个,过滤条件按内容比较(每次渲染新建对象不会重订) */
export function useMffaiEvent(filter: EventFilter, cb: (e: KernelEvent) => void): void {
  const ref = useRef(cb)
  ref.current = cb
  const types = filter.types ? [...filter.types].sort().join(',') : undefined
  const { sessionId } = filter
  useEffect(() => {
    const f: EventFilter = { ...(types !== undefined && { types: types ? (types.split(',') as EventType[]) : [] }), ...(sessionId !== undefined && { sessionId }) }
    return onMffaiEvent(f, (e) => ref.current(e))
  }, [types, sessionId])
}

export function useMffaiReset(cb: () => void): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => onMffaiReset(() => ref.current()), [])
}
