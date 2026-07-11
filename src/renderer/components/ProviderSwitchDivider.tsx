// 会话内切换 provider 时,在时间线插入的分割线 + 友情提示——让"上一轮 A 答/这一轮 B 答"之间的
// 上下文重建(preamble 回填/水位线补档,见 Task 17-18)对用户可见,而不是静默发生。
// 视觉上跟随既有 `.imported-sep`(WorkspaceView.tsx 里"导入的历史对话"分隔条)的居中分割线风格。
export function ProviderSwitchDivider({ from, to }: { from: string; to: string }) {
  return (
    <div className="provider-switch-sep" role="separator">
      <span className="line" />
      <span className="lbl">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="17 1 21 5 17 9" />
          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
          <polyline points="7 23 3 19 7 15" />
          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
        </svg>
        已从【{from}】切换到【{to}】— 新模型将基于之前对话继续（历史重建，可能有损）
      </span>
      <span className="line" />
    </div>
  )
}
