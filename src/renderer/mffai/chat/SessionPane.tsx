// 选中的会话(08 §8):每一轮的消息(app 的 Message)、尾巴、审批卡片和运行卡片(按首次出现的顺序),下面是输入框。
// 模型、工具、CLI 的文字都是第三方的:只经 Message / Markdown 当文字渲染,内嵌 HTML 在这里一律关掉,
// 远程图不加载(UntrustedMdCtx:改成链接,旁边是主机名)。
// 08b §4.3:会话头 + 对话列 + 活动面板。面板停靠或抽屉时,审批卡、运行卡只在面板里,对话流原位置留锚点;收起时卡片照旧在流里(R3)。
// 面板也在这两个 Provider 里面:不可信内容的规则覆盖面板。
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
import { ChatHeader } from './ChatHeader'
import { ActivityPanel, isPending, scopeTurn, type PanelScope } from './ActivityPanel'
import { InlineAnchor } from './InlineAnchor'
import { useActivityPanel } from './useActivityPanel'
import { isEnded, rollbackable, type ApprovalItem, type RunItem, type SessionView, type TurnView } from './reduce'
import { toMessages } from './toMessages'
import { useSession } from './useSession'

/**
 * 结束了、留着 worktree 的运行:worktree 还在不在、合并过没有,要问 executor.runs。它不按会话查,也没有分页,
 * 只有 limit(最多 200):取最多的一页,按会话筛;查不到的运行卡片不给合并、丢弃
 */
/** 找 route.runId 的卡片时最多往回翻几页(每页 300 条) */
const MAX_SEARCH_PAGES = 50

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

/** 结束了、worktree 还在、有改动、没合并过的运行(RunCard 的 canMerge,不含它自己的本地状态):面板展开时对话流里留锚点 */
function unmerged(r: RunItem, row: RunRow | undefined): boolean {
  const end = r.ended
  const files = end ? end.changed.files.length + (end.changed.filesTruncated ?? 0) : 0
  return r.phase === 'ended' && files > 0 && row?.worktree?.present === true && !row.worktree.merged && !r.merged
}

/** 会话里全部待批审批的次序(按轮、再按 seq):卡片上的 n / m,纯显示 */
function pendingOrder(view: SessionView): Map<string, { n: number; m: number }> {
  const ids = view.turns.flatMap((t) => [...t.approvals].filter(isPending).sort((a, b) => a.seq - b.seq).map((a) => a.approvalId))
  return new Map(ids.map((id, i) => [id, { n: i + 1, m: ids.length }]))
}

function Cards({ sessionId, checkout, turn, view, rows, onRunChanged, placement, onOpen, order }: {
  sessionId: string; checkout?: string; turn: TurnView; view: SessionView; rows: Map<string, RunRow>; onRunChanged: () => void
  placement: 'inline' | 'anchors'
  onOpen: (target: Target) => void
  order: Map<string, { n: number; m: number }>
}) {
  const open = !isEnded(view, turn)
  if (placement === 'anchors') {
    const anchors = [
      ...turn.approvals.filter(isPending).map((a) => ({
        seq: a.seq,
        node: <InlineAnchor key={`a${a.approvalId}`} tone="warn" label={`${a.tool} 待审批`} onOpen={() => onOpen({ turnId: turn.turnId, attr: 'data-approval', id: a.approvalId })} />,
      })),
      ...[...turn.runs.values()].filter((r) => r.phase !== 'ended' || unmerged(r, rows.get(r.runId))).map((r) => ({
        seq: r.seq,
        node: <InlineAnchor key={`r${r.runId}`} tone="run" label={`${r.executor} ${r.phase === 'queued' ? '排队' : r.phase === 'running' ? '运行中' : '未合并'}`}
          onOpen={() => onOpen({ turnId: turn.turnId, attr: 'data-run', id: r.runId })} />,
      })),
    ].sort((a, b) => a.seq - b.seq)
    return <>{anchors.map((c) => c.node)}</>
  }
  const cards = [
    ...turn.approvals.map((a) => ({ seq: a.seq, node: <ApprovalCard key={`a${a.approvalId}`} sessionId={sessionId} approval={a} pos={order.get(a.approvalId)} /> })),
    ...[...turn.runs.values()].map((r) => ({
      seq: r.seq,
      node: <RunCard key={`r${r.runId}`} sessionId={sessionId} checkout={checkout} run={r} turnOpen={open} row={rows.get(r.runId)} onChanged={onRunChanged} />,
    })),
  ].sort((a, b) => a.seq - b.seq)
  return <>{cards.map((c) => c.node)}</>
}

/** 锚点点了要打开的卡片:所在的轮、卡片上的属性和值 */
interface Target { turnId: string; attr: 'data-approval' | 'data-run'; id: string }

/** 按属性值找(id 来自后台,不拼进选择器) */
const findBy = (root: ParentNode | null | undefined, sel: string, attr: string, id: string): Element | undefined =>
  root ? [...root.querySelectorAll(sel)].find((el) => el.getAttribute(attr) === id) : undefined

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
  const panel = useActivityPanel()
  const inPanel = panel.mode !== 'inline'
  // route.runId 指向这个会话的运行(去合并):面板切到会话,下面的滚动在面板里找到卡片
  const [scope, setScope] = useState<PanelScope>(() => (r.runId && r.sessionId === sessionId ? 'session' : 'turn'))
  const [target, setTarget] = useState<Target | null>(null)
  useEffect(() => { if (r.runId && r.sessionId === sessionId) setScope('session') }, [r.runId, r.sessionId, sessionId])

  // 去合并:滚到那张运行卡片,每个 runId 一次。卡片还不在(运行在更早的页里)就往回翻,直到找到或没有更早的
  const scrolled = useRef<string | undefined>(undefined)
  const searched = useRef(0)
  useEffect(() => {
    const runId = r.runId
    if (!runId || scrolled.current === runId || r.sessionId !== sessionId) return
    if (inPanel && scope !== 'session') return
    const el = document.getElementById(`mffai-run-${runId}`)
    if (!el) {
      if (view?.hasMore && searched.current < MAX_SEARCH_PAGES) { searched.current++; loadOlder() }
      return
    }
    scrolled.current = runId
    el.scrollIntoView?.({ block: 'center' })
  }, [r.runId, r.sessionId, sessionId, view, loadOlder, inPanel, scope])

  // 锚点:卡片不在本轮视图里就切到会话,渲染之后滚过去
  const openCard = useCallback((t: Target) => {
    if (view && scopeTurn(view)?.turnId !== t.turnId) setScope('session')
    setTarget(t)
  }, [view])
  useEffect(() => {
    if (!target) return
    setTarget(null)
    findBy(document.querySelector('.mffai-act'), `[${target.attr}]`, target.attr, target.id)?.scrollIntoView?.({ block: 'nearest' })
  }, [target])
  const jumpTail = useCallback((turnId: string) => {
    findBy(stick.ref.current, '.mffai-tail[data-turn]', 'data-turn', turnId)?.scrollIntoView?.({ block: 'end' })
  }, [stick.ref])

  const onScroll = () => {
    stick.onScroll()
    if (stick.ref.current && stick.ref.current.scrollTop === 0 && view?.hasMore) loadOlder()
  }

  const open = view ? view.open : summary?.open
  const running = view?.open
    ? [...(view.turns.find((t) => t.turnId === view.open!.turnId)?.runs.values() ?? [])].filter((x) => x.phase !== 'ended').length
    : undefined
  const checkout = session?.cwd ?? summary?.cwd
  const approvalMode = session?.approvalMode ?? summary?.approvalMode ?? 'ask'
  const modelId = (session?.model ?? summary?.model)?.modelId
  const pending = view ? view.turns.reduce((n, t) => n + t.approvals.filter(isPending).length, 0) : (summary?.pendingApprovals ?? 0)

  // 面板里的卡片:props 和对话流里的一样
  const order = useMemo(() => (view ? pendingOrder(view) : new Map<string, { n: number; m: number }>()), [view])
  const renderApproval = (a: ApprovalItem) => <ApprovalCard key={`a${a.approvalId}`} sessionId={sessionId} approval={a} pos={order.get(a.approvalId)} />
  const renderRun = (x: RunItem) => {
    const turn = view?.turns.find((t) => t.turnId === x.turnId)
    const turnOpen = !!view && !!turn && !isEnded(view, turn)
    return <RunCard key={`r${x.runId}`} sessionId={sessionId} checkout={checkout} run={x} turnOpen={turnOpen} row={rows.get(x.runId)} onChanged={refresh} />
  }

  return (
    <ChatHtmlCtx.Provider value={false}>
    <UntrustedMdCtx.Provider value={true}>
      <div className="mffai-convo">
      <ChatHeader title={session?.title ?? summary?.title ?? ''} running={!!open && !open.parked} cwd={checkout}
        mode={approvalMode} pending={pending} panelOn={inPanel} narrow={panel.narrow} onToggle={panel.toggle} />
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
              <Cards sessionId={sessionId} checkout={checkout} turn={turn} view={view} rows={rows} onRunChanged={refresh}
                placement={inPanel ? 'anchors' : 'inline'} onOpen={openCard} order={order} />
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
        info={{ ...(modelId && { model: modelId }), ...(checkout && { cwd: checkout }), mode: approvalMode }}
        onSend={onSend}
        onCommand={onCommand}
        onStop={onStop}
      />
      </div>
      {inPanel && view && (
        <ActivityPanel view={view} sessionId={sessionId} scope={scope} onScope={setScope} drawer={panel.mode === 'drawer'} onClose={panel.close}
          renderApproval={renderApproval} renderRun={renderRun} onJumpTail={jumpTail} />
      )}
    </UntrustedMdCtx.Provider>
    </ChatHtmlCtx.Provider>
  )
}
