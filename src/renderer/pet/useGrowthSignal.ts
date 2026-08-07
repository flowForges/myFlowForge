import { useEffect, useState } from 'react'

export interface GrowthSignalView { todayTokens: number; goal: number; progress: number }

// 订阅主进程广播的成长信号。先拉一次当前值(宠物窗口可能晚于主窗口启动,不能干等下一次广播),
// 之后跟着 chatService 每轮对话的累加走。没有这个 IPC(旧 preload)时返回 null,调用方回落到普通宠物。
export function useGrowthSignal(): GrowthSignalView | null {
  const [sig, setSig] = useState<GrowthSignalView | null>(null)
  useEffect(() => {
    let alive = true
    void Promise.resolve(window.forge.growthSignalGet?.())
      .then((s) => { if (alive && s) setSig(s) })
      .catch(() => { /* 拿不到就等广播 */ })
    const off = window.forge.onGrowthSignal?.((s) => setSig(s))
    return () => { alive = false; off?.() }
  }, [])
  return sig
}
