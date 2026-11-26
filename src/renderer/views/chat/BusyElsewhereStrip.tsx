/**
 * 会话互通的阻断条:这个会话正在官方 App(或另一个 Forge 会话)里进行,刚发的消息被拦在队列里。
 * 和后台任务条同一个吸附区、同一套样式(见 WorkspaceView 的渲染顺序)。「重试」= 把被拦下的那条重新发。
 */
export function BusyElsewhereStrip({ app, onRetry }: { app: string | null; onRetry?: () => void }) {
  if (!app) return null
  return (
    <div className="bg-strip-wrap">
      <div className="bg-strip busy-strip">
        这个会话正在 {app} 中进行 · 先在那边停止
        <button className="bg-strip-stop busy-strip-retry" onClick={() => onRetry?.()}>重试</button>
      </div>
    </div>
  )
}
