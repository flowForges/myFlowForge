import type { ReactElement } from 'react'
import type { FinalizeFailure } from '../../main/run/controller'

/**
 * 收尾没成时的那张卡。
 *
 * 它存在的唯一理由是「说人话」：用户看到「回滚 / 丢弃」这类 git 术语时，读到的是「我跑了半天的
 * 结果没了」。事实恰恰相反 —— 改动一行没丢，全在 forge/run-<id> 上。所以这张卡的第一句必须先
 * 把这件事说死，然后才是原因、冲突文件、和可直接粘贴的命令。
 *
 * Task 8 fix round 3 (I2)：标题和命令块按 `f.decision`（用户在收尾门上选的动作）分岔。收尾门有三个
 * 出口，失败记录走的是同一条路（controller.ts 的 runFinalizeGate），可这张卡此前写死了合并那套叙事：
 * 一个点了「先不合并」的用户，保留失败之后会被这张卡劝去 `git merge --no-ff` 合并他刚刚拒绝的东西。
 * 老的落盘状态没有 decision 字段 → 按 'merge' 兜底，与它们当时唯一能显示的文案一致。
 */
const DECISION_VERB: Record<'merge' | 'discard' | 'park', string> = {
  merge: '自动合并',
  discard: '丢弃',
  park: '保留分支',
}

// 每种收尾动作失败后，用户真正需要敲的那几行。合并 = 手工合一遍；丢弃 = 确认后手工删分支；
// 保留 = 什么都不用做，只要回到自己的分支（本次改动本来就在临时分支上待着）。
function recoveryCommands(f: FinalizeFailure, decision: 'merge' | 'discard' | 'park'): string[] {
  if (decision === 'merge') {
    return [
      `git merge --no-ff ${f.tempBranch}`,
      `git commit                       # 解完冲突`,
      `git branch -D ${f.tempBranch}     # 确认无误后再删`,
    ]
  }
  if (decision === 'discard') {
    return [
      `git switch ${f.target}`,
      `git branch -D ${f.tempBranch}     # 确认真的不要了再删`,
    ]
  }
  return [
    `git status                       # 看看当前在哪条分支、有什么没提交`,
    `git switch ${f.target}            # 本次运行的改动留在 ${f.tempBranch} 上`,
  ]
}
export function FinalizeFailureCard({ failures, onHandoff, onRetry, handoffWarning }: {
  failures: FinalizeFailure[]
  // #7 fix round 2 (N1): optional — a caller with no live run to act on (read-only historical
  // replay, RunHistoryPanel.tsx renders <RunExecPanel staticState readOnly> with NO run2) has
  // nothing this button could actually do. Omitting `onHandoff` hides the button entirely (see
  // below) rather than wiring it to a no-op that still LOOKS like it did something.
  onHandoff?: () => void
  onRetry?: () => void
  // #7 fix round 1 (F1/F2): resolveGate(gateId, {type:'handoff'}) and discardResumable() are NOT
  // equivalent — resolveGate keeps this run's saved record (marks it finalized-by-handoff, status
  // stays an honest 'failed'); discardResumable ERASES the record entirely (see RunExecPanel.tsx's
  // routing doc for exactly when each applies). The caller passes this ONLY when the fallback
  // (record-erasing) route is what 知道了，我自己处理 will actually do here — the button's own label
  // never changes (existing callers/tests rely on the exact text), so the warning is the only place
  // that says "this deletes the record" before the click happens.
  handoffWarning?: string
}): ReactElement {
  // 一次收尾里每个项目走的是同一个动作，取第一条即可；缺失（老落盘状态）按合并兜底。
  const decision = failures[0]?.decision ?? 'merge'
  return (
    <div className="msg-req k-gate ff-card">
      <div className="req-head">
        <span className="req-kind">无法{DECISION_VERB[decision]} · 本次改动一个都没丢</span>
      </div>
      <div className="req-body">
        {failures.map((f) => (
          <div key={f.project} className="ff-proj">
            {decision === 'merge' ? (
              <div className="ff-line">
                项目 <b>{f.project}</b>：<code>{f.target}</code> 已恢复到合并前的干净状态。
              </div>
            ) : (
              <div className="ff-line">
                项目 <b>{f.project}</b>：目标分支 <code>{f.target}</code>。
              </div>
            )}
            <div className="ff-line">
              本次工作流的全部改动，完整保留在分支 <code>{f.tempBranch}</code>。
            </div>
            {f.conflictFiles.length > 0 ? (
              <div className="ff-line">
                冲突文件：
                <ul className="ff-files">{f.conflictFiles.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
              </div>
            ) : null}
            <div className="ff-line ff-detail">原因：{f.detail}</div>
            <div className="ff-line">{decision === 'merge' ? '手工合并（可直接粘贴）：' : '接下来你可以（可直接粘贴）：'}</div>
            <pre className="ff-cmd">{recoveryCommands(f, decision).join('\n')}</pre>
          </div>
        ))}
        {handoffWarning ? <div className="ff-line ff-warn">{handoffWarning}</div> : null}
        {(onRetry || onHandoff) && (
          <div className="arow">
            {onRetry ? <button className="wfo-btn ghost" onClick={onRetry}>重新收尾</button> : null}
            {/* #7 fix round 2 (N1): must not render with no handler — round 1's fix made a click here
                produce a VISIBLE "已记录" confirmation (see RunExecPanel.tsx's handoffAcked), which
                would be a straight-up LIE with no run2 behind it: nothing gets recorded anywhere. */}
            {onHandoff ? <button className="wfo-btn pri" onClick={onHandoff}>知道了，我自己处理</button> : null}
          </div>
        )}
      </div>
    </div>
  )
}
