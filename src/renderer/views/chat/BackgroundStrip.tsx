import { SubagentSpinner } from './Spinners'

/**
 * 后台任务条:该会话有后台还在跑的任务时,停止按钮不再挂在输入框上(composer-bg-chip 已删) ——
 * 挂到输入框上方的吸附区,在队列条**之上**(见 WorkspaceView 的渲染顺序)。
 * 转圈图标复用 Spinners.tsx 的子代理波纹(中性色、currentColor),不新画一个。
 */
export function BackgroundStrip({ count, onStop }: { count: number; onStop?: () => void }) {
  if (!count) return null
  return (
    <div className="bg-strip-wrap">
      <div className="bg-strip">
        <span className="bg-strip-ico" aria-hidden="true"><SubagentSpinner size={14} /></span>
        后台 {count} 个任务在运行
        <button className="bg-strip-stop" onClick={() => onStop?.()}>停止</button>
      </div>
    </div>
  )
}
