// 卡片只挂一次,换位置不重挂(08b R3;Task 5 评审 1)。每张卡片经 createPortal 渲染进它自己的宿主 div(按 key 固定,容器不变 React 就不重挂);
// 宿主 div 由 CardSlot 搬进对话流或活动面板的位置。于是切面板、宽度跨 1280、开关抽屉时,卡片里进行中的请求、重试的 commandId、
// 已合并 / 已丢弃、打开着的确认框都留着。没有位置的卡片宿主不在文档里(和今天一样挂着,只是看不见)。
import { useCallback, useLayoutEffect, useRef } from 'react'

export type HostOf = (key: string) => HTMLElement

/** key → 宿主 div;keep 之外的丢掉 */
export function useCardHosts(): { host: HostOf; keep(keys: Iterable<string>): void } {
  const hosts = useRef(new Map<string, HTMLElement>())
  const host = useCallback<HostOf>((key) => {
    let h = hosts.current.get(key)
    if (!h) {
      h = document.createElement('div')
      h.className = 'mffai-cardhost'
      hosts.current.set(key, h)
    }
    return h
  }, [])
  const keep = useCallback((keys: Iterable<string>) => {
    const k = new Set(keys)
    for (const [key, h] of hosts.current) if (!k.has(key)) { h.remove(); hosts.current.delete(key) }
  }, [])
  return { host, keep }
}

/** 卡片在这里显示:把它的宿主搬进来;卸下时搬走 */
export function CardSlot({ host }: { host: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const slot = ref.current
    if (!slot) return
    slot.appendChild(host)
    return () => { if (host.parentNode === slot) slot.removeChild(host) }
  }, [host])
  return <div ref={ref} className="mffai-cardslot" />
}
