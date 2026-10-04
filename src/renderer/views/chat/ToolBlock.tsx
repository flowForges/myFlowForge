import { useContext, useState } from 'react'
import type { ToolActivity } from '@shared/types'
import { ToolOutputCtx } from './toolOutput'

// 「执行」块折叠状态记忆(会话级,内存):消息 id → 是否折叠。切到别的会话再切回来,Message 会重挂、组件 state 丢,
// 靠这张表把用户手动折叠的状态恢复回去(默认展开)。App 重启不保留(用户只要求切会话来回时保持)。
const collapsedByMsg = new Map<string, boolean>()

// The main agent's OWN tool calls this turn — the "执行" block. Shows each tool as a titled row (live
// while running, ✓/✗ on completion); the raw output is collapsed by default (click a row to expand) so
// the user can watch what the current CLI is executing and see the output without the log flooding the
// conversation. Not every provider streams tool output — rows without output just show the title/status.

function statusMark(s: ToolActivity['status']): string {
  return s === 'run' ? '' : s === 'error' ? '✗' : '✓'
}

/** 按需取回来的那段输出此刻处于什么状态。★`null` = 还没点开过,一次都没去取。 */
type Fetched = { state: 'loading' } | { state: 'ok'; text: string } | { state: 'fail'; msg: string } | null

/**
 * 一次工具调用。
 *
 * ★★那枚 🛡:这次调用是被「完全访问」档自动放行的。
 *  它以前是**对话流里一条独立消息**(`who:'ai'` + 「系统」头像 +「回答」标签),于是长得和模型的
 *  回答一模一样,还夹在这张卡和真正的回答中间。用户原话:「bash 的结果应该在 bash 的那个折叠里,
 *  不应该出现在 LLM 输出的内容界面啊」。它是**这次调用的属性**,所以就该在这一行上。
 * ★做成一枚安静的标记而不是一行字:一轮里十几次调用都会带它,写成句子就是十几句重复的话。
 *  完整措辞放在 title 里,鼠标停上去看得到。
 */
function Row({ tool, messageId }: { tool: ToolActivity; messageId?: string }) {
  const [open, setOpen] = useState(false)
  const [fetched, setFetched] = useState<Fetched>(null)
  const ctx = useContext(ToolOutputCtx)
  // ★★`outputOmitted` 的那条**也算有输出** —— 只是还没下载。漏掉它的话那一行是**灰的、点不开**,
  //   用户会以为这次调用没有任何输出(静默丢数据,这套渲染最不能犯的错)。
  const omitted = !!tool.outputOmitted
  const hasOutput = !!tool.output || omitted

  const fetch = () => {
    if (!messageId || !ctx) { setFetched({ state: 'fail', msg: '取不到这段输出（当前界面没有接取回数据的通道）' }); return }
    setFetched({ state: 'loading' })
    ctx.load(messageId, tool.id)
      .then(text => setFetched({ state: 'ok', text }))
      .catch((e: unknown) => setFetched({ state: 'fail', msg: e instanceof Error ? e.message : String(e) }))
  }
  const toggle = () => {
    if (!hasOutput) return
    const next = !open
    setOpen(next)
    // 只在**第一次**展开时去取:取回来的留在 state 里,折叠再展开不再走一次往返。
    if (next && omitted && fetched === null) fetch()
  }

  const body = () => {
    if (!omitted) return <pre className="tool-output">{tool.output}</pre>
    if (fetched === null || fetched.state === 'loading') return <div className="tool-output tool-output-note">正在取这段输出…</div>
    if (fetched.state === 'fail') {
      // ★失败必须**说出来并且能重试**:静默空白和「这条本来就没有输出」长得一模一样。
      return (
        <div className="tool-output tool-output-note">
          没取到这段输出：{fetched.msg}
          <button type="button" className="tool-retry" onClick={fetch}>重试</button>
        </div>
      )
    }
    if (!fetched.text) return <div className="tool-output tool-output-note">这次调用没有输出</div>
    return <pre className="tool-output">{fetched.text}</pre>
  }

  return (
    <div className={`tool-row st-${tool.status}`}>
      <button className="tool-head" onClick={toggle} aria-expanded={open} disabled={!hasOutput}>
        <span className={`tool-dot d-${tool.status}`} aria-hidden="true" />
        <span className="tool-title" title={tool.title}>{tool.title}</span>
        {tool.autoAllowed && (
          <span className="tool-auto" title="当前权限档是「完全访问」，这次调用没有弹确认门，已自动放行">🛡</span>
        )}
        {tool.status !== 'run' && <span className={`tool-mark m-${tool.status}`} aria-hidden="true">{statusMark(tool.status)}</span>}
        {hasOutput && <span className={`tool-caret${open ? ' open' : ''}`} aria-hidden="true">▸</span>}
      </button>
      {open && hasOutput ? body() : null}
    </div>
  )
}

export function ToolBlock({ tools, stateKey, messageId }: { tools: ToolActivity[]; stateKey?: string; messageId?: string }) {
  // 受控 <details>:open 由 collapsed 决定,用户切换写回记忆表,切会话回来仍保持折叠。默认展开。
  const [collapsed, setCollapsed] = useState(() => (stateKey ? collapsedByMsg.get(stateKey) ?? false : false))
  if (!tools.length) return null
  const running = tools.filter(t => t.status === 'run').length
  return (
    <details className="tool-block" open={!collapsed}
      onToggle={e => { const c = !(e.currentTarget as HTMLDetailsElement).open; setCollapsed(c); if (stateKey) collapsedByMsg.set(stateKey, c) }}>
      <summary className="tool-lead" title="当前代理这一轮自己执行的工具/命令(读文件、跑命令、改代码…)。标题实时显示,原始输出点开可展开。">
        <span className={`tool-lead-dot${running ? ' live' : ''}`} aria-hidden="true" />
        执行 · {running ? `${running} 进行中 / 共 ${tools.length} 步` : `${tools.length} 步`}
      </summary>
      <div className="tool-rows">
        {tools.map(t => <Row key={t.id} tool={t} messageId={messageId} />)}
      </div>
    </details>
  )
}
