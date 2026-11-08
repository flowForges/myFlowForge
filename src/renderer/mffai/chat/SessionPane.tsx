// 选中的会话(08 §8):每一轮的消息(app 的 Message)、尾巴、审批卡片和运行卡片(按首次出现的顺序),下面是输入框。
// 模型、工具、CLI 的文字都是第三方的:只经 Message / Markdown 当文字渲染,内嵌 HTML 在这里一律关掉,
// 远程图不加载(UntrustedMdCtx:改成链接,旁边是主机名)。
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RunRow, SessionSummary } from '@mffai/protocol'
import { Message } from '../../views/chat/Message'
import { ChatHtmlCtx } from '../../views/chat/markdown'
import { UntrustedMdCtx } from '../../views/chat/untrusted'
import { useStickToBottom } from '../../components/useStickToBottom'
import { call, isUnsupported, toCallError } from '../rpc'
import { useMffaiEvent } from '../events'
import { useRoute } from '../useRoute'
import { Chip } from '../ui/Chip'
import { MffaiComposer } from './MffaiComposer'
import { ApprovalCard } from './ApprovalCard'
import { RunCard } from './RunCard'
import { TurnTail } from './TurnTail'
import { isEnded, rollbackable, type SessionView, type TurnView } from './reduce'
import { toMessages } from './toMessages'
import { useSession } from './useSession'

/** 结束了、留着 worktree 的运行:重开之后 worktree 还在不在、合并过没有,要问 executor.runs */
function useRunRows(sessionId: string, view: SessionView | null): { rows: Map<string, RunRow>; refresh: () => void } {
  const [rows, setRows] = useState<Map<string, RunRow>>(new Map())
  const need = useMemo(() => (view?.turns ?? []).flatMap((t) => [...t.runs.values()])
    .filter((r) => r.phase === 'ended' && (r.ended?.worktree ?? r.worktree)).map((r) => r.runId).join(','), [view])
  const gen = useRef(0)
  const refresh = useCallback(() => {
    if (!need) return
    const my = ++gen.current
    void call('executor.runs', { limit: 200 }).then(
      (r) => { if (my === gen.current) setRows(new Map(r.runs.filter((x) => x.sessionId === sessionId).map((x) => [x.runId, x]))) },
      (e) => { if (!isUnsupported(e)) console.error('mffai executor.runs', toCallError(e)) },
    )
  }, [need, sessionId])
  useEffect(refresh, [refresh])
  useMffaiEvent({ types: ['executor.worktree.merged'], sessionId }, refresh)
  return { rows, refresh }
}

function Cards({ sessionId, checkout, turn, view, rows, onRunChanged }: {
  sessionId: string; checkout?: string; turn: TurnView; view: SessionView; rows: Map<string, RunRow>; onRunChanged: () => void
}) {
  const open = !isEnded(view, turn)
  const cards = [
    ...turn.approvals.map((a) => ({ seq: a.seq, node: <ApprovalCard key={`a${a.approvalId}`} sessionId={sessionId} approval={a} /> })),
    ...[...turn.runs.values()].map((r) => ({
      seq: r.seq,
      node: <RunCard key={`r${r.runId}`} sessionId={sessionId} checkout={checkout} run={r} turnOpen={open} row={rows.get(r.runId)} onChanged={onRunChanged} />,
    })),
  ].sort((a, b) => a.seq - b.seq)
  return <>{cards.map((c) => c.node)}</>
}

export function SessionPane({ sessionId, summary, imName, onSend, onCommand, onStop }: {
  sessionId: string
  /** session.list 里的这一行:session.state 还没回来(或旧后台没有)时靠它 */
  summary?: SessionSummary
  imName?: string
  onSend: (text: string) => Promise<unknown>
  onCommand: (name: string, args: string) => Promise<unknown>
  onStop: () => void
}) {
  const r = useRoute()
  const { view, session, loadOlder, reload, error } = useSession(sessionId)
  const origin = session?.origin ?? summary?.origin ?? 'app'
  const { groups, streamingIds } = useMemo(() => (view ? toMessages(view, origin) : { groups: [], streamingIds: new Set<string>() }), [view, origin])
  const canRollback = useMemo(() => (view ? rollbackable(view) : undefined), [view])
  const { rows, refresh } = useRunRows(sessionId, view)
  const stick = useStickToBottom(view)

  // 去合并:滚到那张运行卡片,每个 runId 一次
  const scrolled = useRef<string | undefined>(undefined)
  useEffect(() => {
    const runId = r.runId
    if (!runId || scrolled.current === runId || r.sessionId !== sessionId) return
    const el = document.getElementById(`mffai-run-${runId}`)
    if (!el) return
    scrolled.current = runId
    el.scrollIntoView?.({ block: 'center' })
  }, [r.runId, r.sessionId, sessionId, view])

  const onScroll = () => {
    stick.onScroll()
    if (stick.ref.current && stick.ref.current.scrollTop === 0 && view?.hasMore) loadOlder()
  }

  const open = view ? view.open : summary?.open
  const running = view?.open
    ? [...(view.turns.find((t) => t.turnId === view.open!.turnId)?.runs.values() ?? [])].filter((x) => x.phase !== 'ended').length
    : undefined

  return (
    <ChatHtmlCtx.Provider value={false}>
    <UntrustedMdCtx.Provider value={true}>
      <div className="mffai-chat-body" ref={stick.ref} onScroll={onScroll}>
        {view?.hasMore && <button className="txt-btn mffai-older" onClick={loadOlder}>更早</button>}
        {error === 'gone' && <Chip tone="bad">已删除</Chip>}
        {error === 'unsupported' && <Chip>不支持</Chip>}
        {error === 'failed' && <><span className="mffai-fail">失败</span><button className="txt-btn" onClick={reload}>重试</button></>}
        {view && groups.map((g, i) => {
          const turn = view.turns[i]
          return (
            <Fragment key={g.turnId}>
              {g.messages.map((m) => <Message key={m.id} msg={m} streaming={streamingIds.has(m.id)} />)}
              <TurnTail sessionId={sessionId} turn={turn} canRollback={canRollback === turn.turnId} />
              <Cards sessionId={sessionId} checkout={session?.cwd ?? summary?.cwd} turn={turn} view={view} rows={rows} onRunChanged={refresh} />
            </Fragment>
          )
        })}
      </div>
      <MffaiComposer
        session={{ id: sessionId, origin }}
        imName={imName}
        canStop={!!open}
        parked={open?.parked ? (running !== undefined ? { running } : {}) : undefined}
        readOnly={error === 'gone'}
        onSend={onSend}
        onCommand={onCommand}
        onStop={onStop}
      />
    </UntrustedMdCtx.Provider>
    </ChatHtmlCtx.Provider>
  )
}
