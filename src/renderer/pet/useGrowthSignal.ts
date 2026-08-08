import { useEffect, useRef, useState } from 'react'

// 只剩今日 token。goal/progress 随「百分比阶段」一起去掉了 —— 阶段门槛现在是每个成长包自带的绝对区间
// (GrowthStage.from),没有全局分母,消费方直接拿 todayTokens 去 pickGrowthSprite。
export interface GrowthSignalView { todayTokens: number }

// 订阅主进程广播的成长信号。先拉一次当前值(宠物窗口可能晚于主窗口启动,不能干等下一次广播),
// 之后跟着 chatService 每轮对话的累加走。没有这个 IPC(旧 preload)时返回 null,调用方回落到普通宠物。
export function useGrowthSignal(): GrowthSignalView | null {
  const [sig, setSig] = useState<GrowthSignalView | null>(null)
  // 广播先于首次 invoke 的 resolve 到达时,那次拉取拿到的是更旧的快照 —— 让它别回写,
  // 否则进度会倒退一格再被下一次广播纠正(肉眼可见的一跳)。
  const pushed = useRef(false)
  useEffect(() => {
    let alive = true
    // ★可选链要一路加到 window.forge 本身,不能只加在方法上:这个 hook 现在也被设置页用,
    // 而那边的测试环境里 window.forge 整个不存在,`window.forge.x?.()` 会直接抛。
    void Promise.resolve(window.forge?.growthSignalGet?.())
      .then((s) => { if (alive && s && !pushed.current) setSig(s) })
      .catch(() => { /* 拿不到就等广播 */ })
    const off = window.forge?.onGrowthSignal?.((s) => { pushed.current = true; setSig(s) })
    return () => { alive = false; off?.() }
  }, [])
  return sig
}
