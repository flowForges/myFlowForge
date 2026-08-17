import type { ReactElement } from 'react'
import type { FinalizeFailure } from '../../main/run/controller'

/**
 * 收尾没能自动合并时的那张卡。
 *
 * 它存在的唯一理由是「说人话」：用户看到「回滚 / 丢弃」这类 git 术语时，读到的是「我跑了半天的
 * 结果没了」。事实恰恰相反 —— 改动一行没丢，全在 forge/run-<id> 上。所以这张卡的第一句必须先
 * 把这件事说死，然后才是原因、冲突文件、和可直接粘贴的命令。
 */
export function FinalizeFailureCard({ failures, onHandoff, onRetry }: {
  failures: FinalizeFailure[]
  onHandoff: () => void
  onRetry?: () => void
}): ReactElement {
  return (
    <div className="msg-req k-gate ff-card">
      <div className="req-head">
        <span className="req-kind">无法自动合并 · 本次改动一个都没丢</span>
      </div>
      <div className="req-body">
        {failures.map((f) => (
          <div key={f.project} className="ff-proj">
            <div className="ff-line">
              项目 <b>{f.project}</b>：<code>{f.target}</code> 已恢复到合并前的干净状态。
            </div>
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
            <div className="ff-line">手工合并（可直接粘贴）：</div>
            <pre className="ff-cmd">{[
              `git merge --no-ff ${f.tempBranch}`,
              `git commit                       # 解完冲突`,
              `git branch -D ${f.tempBranch}     # 确认无误后再删`,
            ].join('\n')}</pre>
          </div>
        ))}
        <div className="arow">
          {onRetry ? <button className="wfo-btn ghost" onClick={onRetry}>重新收尾</button> : null}
          <button className="wfo-btn pri" onClick={onHandoff}>知道了，我自己处理</button>
        </div>
      </div>
    </div>
  )
}
