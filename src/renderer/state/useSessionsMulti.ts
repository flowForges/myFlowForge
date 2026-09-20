import { useEffect, useRef, useState } from 'react'
import type { ChatSession, SessionsFile } from '@shared/types'
import type { ForgeApi } from '../../preload/index'

// 为「多个展开工作区」懒加载会话列表。键 = workspacePath。新出现的 path 拉一次；
// 订阅 onSessionsChanged 后按 workspacePath 精确更新；移出的 path 保留旧缓存（无害，避免抖动）。
//
// ★★`hostKey` 一变,缓存整份作废。这个 hook 按 **workspacePath** 记「拉过了」,而两台机器上的
//  工作区路径完全可以一模一样(同一个人、同样的目录习惯;自测时更是同一台机器上的同一个路径)⇒
//  切过去之后 `loaded.has(path)` 为真,**一次都不再拉**,侧栏里展开的还是上一台机器的会话,
//  而那枚主机徽章已经写着新主机的名字。和 `useHome` 那条(2026-09-09)是同一个形状:
//  主进程 `remote/router.ts` 守着「绝不回落到本机」,渲染层的缓存从另一头把它破了。
// ★「移出的 path 保留旧缓存」在**同一台机器内**仍然成立(那是防抖动);跨机器不成立。
export function useSessionsMulti(paths: string[], hostKey = 'local'): Record<string, ChatSession[]> {
  const [map, setMap] = useState<Record<string, ChatSession[]>>({})
  const loaded = useRef<Set<string>>(new Set())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = useRef((window as any).forge as ForgeApi)

  // ★清空**同步**发生在换主机这一帧,不等新数据回来 —— 那几百毫秒(远程还要等握手)里
  //  留着上一台的会话,就是「本机的数据顶着远程主机的名牌」。空着比显示错的对。
  const prevHost = useRef(hostKey)
  if (prevHost.current !== hostKey) {
    prevHost.current = hostKey
    loaded.current = new Set()
    // 渲染期改自己的 state = React 官方那条「props 变了顺手调整 state」的写法,
    // 它会立刻重渲一次,不会多刷一帧给人看见旧数据。
    setMap({})
  }

  useEffect(() => {
    let live = true
    for (const p of paths) {
      if (!p || loaded.current.has(p) || !api.current.sessionList) continue
      loaded.current.add(p)
      void api.current.sessionList(p).then((f: SessionsFile) => {
        if (live) setMap(prev => ({ ...prev, [p]: f.sessions }))
      })
    }
    return () => { live = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.join('|'), hostKey])

  useEffect(() => {
    if (!api.current.onSessionsChanged) return
    const off = api.current.onSessionsChanged((raw: unknown) => {
      const m = raw as { workspacePath: string; file: SessionsFile }
      setMap(prev => ({ ...prev, [m.workspacePath]: m.file.sessions }))
    })
    return () => { off() }
  }, [])

  return map
}
