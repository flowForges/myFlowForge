import { useEffect, useState } from 'react'
import { describeHostState, type HostStatusView } from '@shared/remote/hostView'
import './remotebar.css'

/**
 * 「你正在看另一台机器」的常驻提示条。
 *
 * ★**只在连着远程 host 时才渲染** —— 本机状态下这个组件返回 null,界面跟以前一模一样。
 * 之所以必须常驻:设计文档十的 UI 约束写明「断线态要显式,不能拿缓存假装在线」。
 * 你在看一台远程机器、而它其实已经断了 —— 界面上不能没有任何迹象。
 */
export function RemoteBar({ onOpenHosts }: { onOpenHosts: () => void }) {
  const [status, setStatus] = useState<HostStatusView | null>(null)

  useEffect(() => {
    // ★先订阅、再拉快照,而且**快照到得晚就丢掉**。
    // 反过来写会有竞态:初始 hostsStatus() 的 promise 可能在一条实时状态之后才 resolve,
    // 用一个更旧的快照把新状态盖回去 —— 表现为「连上远程后状态条闪一下就没了」。
    let pushed = false
    const off = window.forge.onHostStatus?.((s) => { pushed = true; setStatus(s) })
    void window.forge.hostsStatus?.().then((s) => { if (!pushed) setStatus(s) })
    return off
  }, [])

  if (!status || status.hostId === null) return null
  const d = describeHostState(status.state)

  return (
    <div className={`remote-bar ${d.tone}`} role="status">
      <span className="dot" />
      <span className="who">{status.label}</span>
      <span className="sep">·</span>
      <span className="sub">{d.text}</span>
      <button type="button" className="act" onClick={onOpenHosts}>切换</button>
      <button type="button" className="act" onClick={() => { void window.forge.hostsDisconnect?.() }}>回到本机</button>
    </div>
  )
}
