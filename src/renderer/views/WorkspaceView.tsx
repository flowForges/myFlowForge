import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { EngineApi } from '../state/useEngine'
import type { StartRunOpts } from '../App'
import type { ProviderInfo, ChangeType, ChatMessage, ImportedMessage, DesignDocRef, WsWorkflow } from '@shared/types'
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '@shared/permissions'
import { AgentNode } from '../components/AgentNode'
import { HookNode } from '../components/HookNode'
import { WorkflowStrip } from '../components/WorkflowStrip'
import { WorkflowGlance } from '../components/WorkflowGlance'
import type { Plugin } from '@shared/plugin'
import { ReqCard } from '../components/ReqCard'
import { PlanCard } from '../components/PlanCard'
import { ProviderSwitchDivider } from '../components/ProviderSwitchDivider'
import { AgentContextMeta } from '../components/AgentContextMeta'
import { ResizeHandle } from '../shell/ResizeHandle'
import { useChat } from '../state/useChat'
import type { SessionsApi } from '../state/useSessions'
import { useSessions } from '../state/useSessions'
import { useWorktree } from '../state/useWorktree'
import { useLastRun } from '../state/useLastRun'
import { MessageStream } from './chat/MessageStream'
import { Message } from './chat/Message'
import { buildTimeline } from './chat/timeline'
import { Composer } from './chat/Composer'
import { workflowMenuCommands } from './chat/slashCommands'
import { SessionTabs } from './chat/SessionTabs'
import { ChatJumpRail } from './chat/ChatJumpRail'
import { ArchiveNote } from './ArchiveNote'
import { ChangesPane } from './inspector/ChangesPane'
import { FileTreePane } from './inspector/FileTreePane'
import { pickPreviewCwd } from './inspector/previewTarget'
import { FilePreview } from './inspector/FilePreview'
import { FileBrowser } from './inspector/FileBrowser'
import { ProjectPicker, ALL_PROJECTS } from './inspector/ProjectPicker'
import { FileIc } from './inspector/fileIcon'
import type { Attachment, MultiChanges } from '@shared/types'
import { canContinue } from './chat/canContinue'
import { providerSupportsResume } from '@shared/nativeResumeProviders'
import { deriveOpenTarget } from '../shell/deriveOpenTarget'
import type { OpenTarget } from '@shared/openers'

function importedToChat(im: ImportedMessage, i: number): ChatMessage {
  return { id: String(i), who: im.who, text: im.text, ts: im.ts }
}

const STATE_IDX_MAP: Record<string, string> = {
  wait: '', run: 'run', ok: 'ok', err: 'err',
}

// Stage key → display name (mirrors src/renderer/settings/WorkflowPane.tsx).
const STAGE_NAMES: Record<string, string> = { requirement: '需求评估', design: '技术方案设计', develop: '代码开发', test: '写单测', review: '代码 CR' }

// Quick-command chips that seed the composer with a starter prompt.
const QUICK_CMDS = [
  { label: '梳理仓库架构', prompt: '梳理这个仓库的整体架构,画出模块依赖关系' },
  { label: '定位 token 相关代码', prompt: '定位与主题 token 相关的代码,列出涉及文件' },
  { label: '解释一段代码', prompt: '解释这段限流中间件的工作原理' },
]

type TabId = 'agents' | 'changes' | 'files'

// Shape returned by window.forge.getWorkspace
interface WsStageInfo { key: string; provider: string; model: string }
interface WsProjectInfo { repoId: string; name: string; branch: string; provider: string; model: string }
interface WorkspaceInfo {
  name: string; path: string; workflowId: string;
  stages: WsStageInfo[];
  projects: WsProjectInfo[];
  status: string;
  // The user's configured plugin hooks (workspace-level + stage-scoped). readWorkspace already
  // returns these; the view surfaces them so a custom workflow's plugins are visibly accounted for.
  plugins?: Plugin[];
  stepPlugins?: Plugin[];
  // The workspace's full named-workflow list (Task 11: right-side "at a glance" panel). readWorkspace
  // already returns this (ensureWorkspaceWorkflows guarantees it); optional here only for callers that
  // predate multi-workflow support.
  workflows?: WsWorkflow[];
  autoDecide?: boolean;
}

interface WorkspaceViewProps {
  engine: EngineApi
  providers: ProviderInfo[]
  workspacePath?: string   // selected workspace; falls back to the live run's path
  // When set (a freshly-created workspace with no run yet), the first composer message starts the
  // run seeded with that message as the task, instead of being sent as a normal chat turn.
  pendingStartOpts?: StartRunOpts
  onStartRun?: (opts: StartRunOpts, task: string) => void
  inspectorWidth?: number
  onInspectorHandleDown?: (e: ReactPointerEvent<HTMLDivElement>) => void
  inspectorCollapsed?: boolean
  sessionsApi?: SessionsApi
  onEditWorkspace?: () => void
  archived?: boolean
  createdAt?: number
  archivedAt?: number | null
  /** Open the bottom 实时日志 drawer scoped to one agent (its full output, larger view). */
  onViewAgentLog?: (agentId: string, agentName: string) => void
  // Report what the 顶栏「打开位置」button should open (current workspace / previewed file), or null.
  onOpenTargetChange?: (t: OpenTarget | null) => void
}

// A truncated overview value: an INSTANT (CSS) tooltip shows the full text on hover, and clicking
// copies it with a prominent 已复制 pill — so long paths/branches aren't lost behind the ellipsis.
// Empty/'—' renders a plain dash (nothing to copy).
function Copyable({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false)
  const textRef = useRef<HTMLSpanElement>(null)
  const real = !!text && text !== '—'
  // On hover, if the value is truncated, marquee it leftward (via animated text-indent) so the full
  // value scrolls into view without leaving the ellipsized state — measured here, animated in CSS.
  const onEnter = () => {
    const el = textRef.current
    if (!el) return
    const over = el.scrollWidth - el.clientWidth
    el.style.setProperty('--mq', over > 4 ? `-${over}px` : '0px')
  }
  if (!real) return <b className={className}>—</b>
  return (
    <b
      className={(className ? className + ' ' : '') + 'ic-copyable' + (done ? ' copied' : '')}
      data-full={text}
      onMouseEnter={onEnter}
      onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1100) }}
    >
      <span className="ic-cp-text" ref={textRef}>{text}</span>
      <span className="ic-cp-pill">{done ? '已复制 ✓' : '点击复制'}</span>
    </b>
  )
}

export function WorkspaceView({ engine, providers, workspacePath, pendingStartOpts, onStartRun, inspectorWidth, onInspectorHandleDown, inspectorCollapsed, sessionsApi, onEditWorkspace, archived, createdAt, archivedAt, onViewAgentLog, onOpenTargetChange }: WorkspaceViewProps) {
  const { resolve, cancel } = engine
  const [activeTab, setActiveTab] = useState<TabId>('agents')
  const onViewChanges = useCallback(() => setActiveTab('changes'), [])
  const [quickSeed, setQuickSeed] = useState<{ text: string; nonce: number }>()
  // Task 15/16 shared mechanism: clicking "修改方向…" on a plan card (Task 15) or a stage-gate card
  // (Task 16, not yet wired) seeds a quote marker into the MAIN composer instead of opening a cramped
  // inline textarea; the next send routes back to that item's resolver as a 'modify' decision rather
  // than a normal chat message.
  const [pendingSupplement, setPendingSupplement] = useState<{ kind: 'plan' | 'gate'; id: string; label: string } | null>(null)
  const startSupplement = useCallback((kind: 'plan' | 'gate', id: string, label: string) => {
    setPendingSupplement({ kind, id, label })
    setQuickSeed({ text: `> 针对【技术方案·${label}】补充：\n`, nonce: Date.now() })
  }, [])
  const [selection, setSelection] = useState<{ agentId: string; modelId: string; permissionMode?: import('@shared/permissions').PermissionMode }>()
  // 本机扫描到的当前 provider 的自定义命令/prompt + skills(进 "/" 菜单)。随 provider/workspace 变化拉取。
  const [dynamicCommands, setDynamicCommands] = useState<import('./chat/slashCommands').MenuCommand[]>([])
  const writeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selForRef = useRef<{ ws?: string; sid?: string }>({}) // which (ws,session) the current `selection` belongs to
  // Pending provider switch awaiting user confirmation (old provider already ran in this session).
  const [pendingSwitch, setPendingSwitch] = useState<{ from: string; to: string; toModel: string; permissionMode?: import('@shared/permissions').PermissionMode } | null>(null)
  const wsPath = workspacePath ?? engine.run?.workspacePath
  const localSessions = useSessions(wsPath)
  const sessions = sessionsApi ?? localSessions
  // Confirm a pending provider switch: apply the selection, persist it, and have the new provider
  // summarize the prior conversation as a visible message (a provider-switch divider auto-inserts).
  const confirmSwitch = useCallback(() => {
    const prev = pendingSwitch
    if (!prev) return
    const s = { agentId: prev.to, modelId: prev.toModel, permissionMode: prev.permissionMode }
    setSelection(s)
    const sid = sessions.activeSessionId
    if (wsPath && sid) {
      selForRef.current = { ws: wsPath, sid }
      window.forge.sessionSetModel?.({ workspacePath: wsPath, sessionId: sid, agentId: s.agentId, modelId: s.modelId })
      if (s.permissionMode) window.forge.sessionSetPermission?.({ workspacePath: wsPath, sessionId: sid, mode: s.permissionMode })
      void window.forge.chatSwitchSummary?.({ workspacePath: wsPath, sessionId: sid, toAgent: prev.to, model: prev.toModel })
    }
    setPendingSwitch(null)
  }, [pendingSwitch, wsPath, sessions.activeSessionId])
  // Session switch → clear any seeded composer text (workflow-trigger phrase or supplement quote) so a
  // fresh session opens EMPTY instead of inheriting the previous session's seed. Guard with a ref so
  // the initial mount / first-settle does NOT clear (that would wipe a just-set same-session chip
  // seed); only a genuine change from one session id to another clears. (User draft lives in draftStore.)
  const prevSidRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const sid = sessions.activeSessionId
    if (prevSidRef.current !== undefined && prevSidRef.current !== sid) setQuickSeed(undefined)
    prevSidRef.current = sid
  }, [sessions.activeSessionId])
  // #3: a run belongs to the session that started it. Show the live run + its gate/pending cards ONLY
  // in that session's tab — a run raising a permission gate must NOT steal whatever tab is in front
  // (the "画着图呢，A 的权限门跳到 C" bug). Runs with no sessionId (legacy/direct) show anywhere in the ws.
  const liveRunForTab = engine.run && engine.run.workspacePath === wsPath
    && (!engine.run.sessionId || engine.run.sessionId === sessions.activeSessionId)
    ? engine.run : null
  const run = useLastRun(wsPath, liveRunForTab)
  const pending = liveRunForTab ? engine.pending : []
  // #3: if a run in THIS workspace but a DIFFERENT session is waiting on a gate, badge that session's
  // tab (single-run engine → at most one such session today; a Set keeps it concurrency-ready).
  const attentionIds = useMemo(() => {
    const s = new Set<string>()
    if (engine.run && engine.run.workspacePath === wsPath && engine.run.sessionId
      && engine.run.sessionId !== sessions.activeSessionId && engine.pending.length > 0) {
      s.add(engine.run.sessionId)
    }
    return s
  }, [engine.run, engine.pending, wsPath, sessions.activeSessionId])
  const chat = useChat(wsPath, sessions.activeSessionId, (mode) => {
    if (mode === 'workflow') setForceChat(false)
  })
  const wsName = run?.workspaceName ?? wsPath?.split('/').filter(Boolean).pop() ?? ''

  // Inspector mode: forceChat overrides to chat mode; reset when a run for this ws goes live
  const [forceChat, setForceChat] = useState(false)
  const runIsLiveHere = engine.run?.workspacePath === wsPath
  const runLiveHereNow = engine.run?.workspacePath === wsPath && engine.run?.status === 'run'
  const chatMode = !runIsLiveHere || forceChat

  // When a run for THIS workspace becomes live, reset forceChat so we show workflow mode
  useEffect(() => {
    if (runIsLiveHere) setForceChat(false)
  }, [runIsLiveHere])

  // Load workspace data for the chat panel
  const [wsInfo, setWsInfo] = useState<WorkspaceInfo | null>(null)
  // 「允许 LLM 自行决策」(per-workspace):开=工作流不弹选择门,主代理自填门决策。初值随 wsInfo 载入。
  const [autoDecide, setAutoDecide] = useState(false)
  const reloadWsInfo = useCallback(() => {
    if (!wsPath) { setWsInfo(null); return }
    void window.forge.getWorkspace(wsPath).then((ws: WorkspaceInfo | null) => setWsInfo(ws))
  }, [wsPath])
  useEffect(() => { reloadWsInfo() }, [reloadWsInfo])
  useEffect(() => { setAutoDecide(!!wsInfo?.autoDecide) }, [wsInfo])
  useEffect(() => {
    const off = window.forge.onWorkspacesChanged?.(() => reloadWsInfo())
    return () => { off?.() }
  }, [reloadWsInfo])

  // Provider/model + permission are remembered PER SESSION. On switching session/workspace, restore that
  // session's own saved choice; on a session's first use, seed from the develop stage → first installed
  // provider. Crucially, when only session DATA changes (not a switch) and we already have a selection —
  // e.g. right after the user picked one — we DON'T re-derive, so the user's choice is never overwritten
  // and each session stays independent + stable.
  useEffect(() => {
    if (!wsPath) return
    const sid = sessions.activeSessionId
    // Already resolved a selection for this (ws, session)? Leave it — the user's choice is stable and
    // never overwritten by later provider/session-data churn. (selForRef is also set on user pick.)
    if (selForRef.current.ws === wsPath && selForRef.current.sid === sid) return
    const s = (sessions.sessions ?? []).find(x => x.id === sid)
    const installed = (providers ?? []).filter(p => p.installed)
    const perm = s?.permissionMode ?? DEFAULT_PERMISSION_MODE
    // Value-equal short-circuit: never trigger a re-render (or a render loop) when the derived selection
    // matches what's already there — even if this effect re-runs on churn or a flickering activeSessionId.
    const apply = (next: { agentId: string; modelId: string; permissionMode: typeof perm }) => {
      selForRef.current = { ws: wsPath, sid }
      setSelection(prev => (prev && prev.agentId === next.agentId && prev.modelId === next.modelId && prev.permissionMode === next.permissionMode ? prev : next))
    }
    // 1) Session remembers its own agent/model → restore it.
    if (s?.agentId && installed.some(p => p.id === s.agentId)) {
      apply({ agentId: s.agentId, modelId: s.modelId ?? '', permissionMode: perm })
      return
    }
    // 2) First use of this session → seed from develop stage, else the first installed provider. Only
    //    commit once we actually have something to seed (so we retry when providers arrive).
    if (!wsInfo) return
    const dev = (wsInfo.workflows ?? []).flatMap(w => w.stages).find(st => st.key === 'develop')
    const seed = (dev && installed.some(p => p.id === dev.provider))
      ? { agentId: dev.provider, modelId: dev.model }
      : installed[0] ? { agentId: installed[0].id, modelId: installed[0].models[0]?.id ?? '' } : undefined
    if (seed) apply({ ...seed, permissionMode: perm })
  }, [sessions.activeSessionId, sessions.sessions, wsInfo, providers, wsPath])

  // Fetch the provider's on-disk commands/prompts + skills for the "/" menu (changes with provider/ws).
  useEffect(() => {
    const agentId = selection?.agentId
    if (!agentId) { setDynamicCommands([]); return }
    let live = true
    void window.forge.commandsList?.(agentId, wsPath).then(cs => { if (live) setDynamicCommands(cs) })
    return () => { live = false }
  }, [selection?.agentId, wsPath])

  // "/" menu = on-disk commands/skills + one entry per this workspace's named workflow (Task 13),
  // so the user can name a workflow explicitly instead of relying on the agent's auto-detection.
  const composerCommands = useMemo(
    () => [...dynamicCommands, ...workflowMenuCommands(wsInfo?.workflows ?? [])],
    [dynamicCommands, wsInfo?.workflows],
  )
  // Picking a workflow from "/" has no approach/task yet (the composer was just the "/token"), so —
  // consistent with the built-in /工作流 command — seed a workflow-scoped trigger phrase and let the
  // user type the actual task, then send normally (deterministic reproposeWorkflow needs real
  // approach/task text, which doesn't exist at pick time).
  const onPickWorkflow = useCallback((workflowId: string) => {
    const wf = wsInfo?.workflows?.find(w => w.id === workflowId)
    setQuickSeed({ text: `开启「${wf?.name ?? ''}」工作流,按以下需求分阶段执行,先给出技术方案等我批准:\n`, nonce: Date.now() })
  }, [wsInfo?.workflows])

  // Clear any pending debounce write timer on unmount.
  useEffect(() => () => { if (writeTimer.current) clearTimeout(writeTimer.current) }, [])

  // Read-only imported session: load full history via sessionImportRead (not chatHistory).
  const activeSession = useMemo(
    () => sessions.sessions.find(s => s.id === sessions.activeSessionId),
    [sessions.sessions, sessions.activeSessionId],
  )
  // Permission mode is remembered PER SESSION. When the active session changes (switch/create),
  // restore its saved mode into the composer selection; absent = default 'auto'. Only touches the
  // permission facet — agent/model stay as seeded.
  // Per-session permission is restored by the unified selection effect above (on session switch).
  const activePerm = activeSession?.permissionMode ?? DEFAULT_PERMISSION_MODE
  // Imported history: loaded for BOTH a pure read-only imported session AND a session that was
  // "基于此历史继续" (writable but still carries `external`), so the continued chat can show the
  // imported history above a divider — the user keeps the original context inline.
  const [roMessages, setRoMessages] = useState<ChatMessage[]>([])
  useEffect(() => {
    const s = activeSession
    if (!s?.external || !wsPath) { setRoMessages([]); return }
    let live = true
    void window.forge.sessionImportRead({
      source: s.external.source,
      externalId: s.external.externalId,
      cwd: wsPath,
      filePaths: s.external.filePaths,
      title: s.title,
      // 以下四个字段为占位值：readSession 实际只用 source/externalId/cwd/filePaths 定位文件，
      // startedAt/lastTs/messageCount/hasBody 在此处不影响读取行为。
      startedAt: 0,
      lastTs: 0,
      messageCount: 0,
      hasBody: true,
    }).then((msgs: import('@shared/types').ImportedMessage[]) => {
      if (live) setRoMessages(msgs.map(importedToChat))
    })
    return () => { live = false }
  }, [activeSession, wsPath])

  // Which messages to render. Read-only imported session → imported history only. A continued session →
  // imported history (above a divider) + the live conversation. A plain session → live conversation.
  const isReadOnlySession = !!activeSession?.readonly
  const isContinuedSession = !!activeSession?.continuedFrom
  const importedHistory = (isReadOnlySession || isContinuedSession) ? roMessages : []
  const liveMessages = isReadOnlySession ? [] : chat.messages
  const visibleMessages = importedHistory.length ? [...importedHistory, ...liveMessages] : liveMessages

  // Text-fallback warning: show when this is a continued session that cannot use native --resume.
  // Native resume = same-source provider that supports --resume (claude/cursor/qoder).
  // Cross-provider continues, or codex/gemini sources, fall back to a text preamble (context may be lost).
  const cont = activeSession?.continuedFrom
  const willUseTextFallback = !!cont && !!selection && !(selection.agentId === cont.source && providerSupportsResume(cont.source))

  // Auto-scroll the chat to the bottom as messages stream in, so the latest AI output is
  // never hidden behind the composer. Sending a message (or the AI starting a new one) always
  // pins to the bottom; mid-stream deltas only follow when you're already near the bottom, so
  // scrolling up to read history isn't yanked back down.
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const prevLenRef = useRef(0)
  const onChatScroll = () => {
    const el = scrollRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (visibleMessages.length > prevLenRef.current) stickRef.current = true   // new turn → pin to bottom
    prevLenRef.current = visibleMessages.length
    // rAF: wait for the new Markdown / think-block layout before measuring scrollHeight,
    // otherwise we scroll to a stale (too-short) height and the latest output stays hidden.
    if (stickRef.current) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  }, [visibleMessages, chat.streamingIds, chat.plans.length, chat.confirms.length, pending.length])

  // Inspector worktree: switch which project's 变更/文件树 we show, or aggregate across all.
  // Prefer the live run's projects; fall back to workspace config projects so chat mode
  // (no live run) can still show 变更/文件树 for the workspace's actual worktrees.
  const projects = useMemo(() => {
    if (run?.projects?.length) return run.projects
    return (wsInfo?.projects ?? []).map(p => {
      const name = p.name || p.repoId
      return { name, cwd: `${wsPath}/${name}` }
    })
  }, [run?.projects, wsInfo, wsPath])
  const multi = projects.length > 1
  const [activeCwd, setActiveCwd] = useState<string | undefined>(undefined)
  // Valid inspector targets: the "全部项目" sentinel (only when >1 project) + each project worktree.
  const validCwd = (c: string | undefined) =>
    !!c && ((c === ALL_PROJECTS && multi) || projects.some(p => p.cwd === c))
  // Default: aggregate across all projects when there's more than one; else the single project.
  const selected = validCwd(activeCwd) ? activeCwd! : (multi ? ALL_PROJECTS : (projects[0]?.cwd ?? wsPath))
  const aggregate = selected === ALL_PROJECTS
  // useWorktree drives single-project mode; in aggregate mode we use changesMulti instead.
  const cwd = aggregate ? undefined : selected
  const wt = useWorktree(cwd)

  // Aggregate changes across every project worktree (only fetched in "全部项目" mode).
  const [multiChanges, setMultiChanges] = useState<MultiChanges | null>(null)
  const projectCwds = useMemo(() => projects.map(p => p.cwd), [projects])
  useEffect(() => {
    if (!aggregate || projectCwds.length === 0) { setMultiChanges(null); return }
    let live = true
    void window.forge.changesMulti(projectCwds).then((m: MultiChanges) => { if (live) setMultiChanges(m) })
    return () => { live = false }
  }, [aggregate, projectCwds])
  // Group changes by project name (byProject is keyed by cwd; map back to names).
  const changeGroups = useMemo(() => {
    if (!multiChanges) return undefined
    const nameByCwd = new Map(projects.map(p => [p.cwd, p.name]))
    return multiChanges.byProject.map(b => ({ name: nameByCwd.get(b.cwd) ?? b.cwd, cwd: b.cwd, changes: b.changes }))
  }, [multiChanges, projects])
  const totalChangeCount = aggregate ? (multiChanges?.total ?? 0) : wt.changes.length

  // Aggregate file tree for workspace root (only fetched in "全部项目" mode).
  const [aggTree, setAggTree] = useState<import('@shared/types').TreeNode[]>([])
  useEffect(() => {
    if (!aggregate || !wsPath) { setAggTree([]); return }
    let live = true
    void window.forge.fsTree(wsPath).then((t: import('@shared/types').TreeNode[]) => { if (live) setAggTree(t) })
    return () => { live = false }
  }, [aggregate, wsPath])

  // Manual 刷新: re-read the file tree + changes now. Aggregate mode is fetched once on entry (no
  // git watcher), so a file the AI just wrote — especially one at the workspace ROOT, outside any
  // project's git repo — won't appear until refreshed. Single-project mode has a watcher but we still
  // expose refresh for parity / an immediate re-read.
  const refreshInspector = useCallback(() => {
    if (aggregate) {
      if (wsPath) void window.forge.fsTree(wsPath).then(setAggTree)
      if (projectCwds.length) void window.forge.changesMulti(projectCwds).then(setMultiChanges)
    } else {
      wt.refresh()
    }
  }, [aggregate, wsPath, projectCwds, wt])

  const treeForPane = aggregate ? aggTree : wt.tree
  // Root cwd for file-tree content (full-text) search: the workspace root in aggregate mode
  // (its tree paths are relative to it), else the selected single project.
  const treeSearchRoot = aggregate ? wsPath : selected

  // File preview overlay state. In aggregate mode each file carries its own (group) cwd;
  // otherwise it falls back to the selected single-project cwd.
  const [preview, setPreview] = useState<{ file: string; type: ChangeType; cwd: string; mode?: 'diff' | 'full' } | null>(null)
  // Report the 「打开位置」target upward: a previewed file (open its worktree + reveal it) wins;
  // else the selected project folder (or workspace root in aggregate mode). Cleared on unmount.
  const openBaseFolder = aggregate ? (wsPath ?? '') : (selected ?? wsPath ?? '')
  useEffect(() => {
    onOpenTargetChange?.(deriveOpenTarget(preview ? { file: preview.file, cwd: preview.cwd } : null, openBaseFolder))
  }, [preview, openBaseFolder, onOpenTargetChange])
  useEffect(() => () => { onOpenTargetChange?.(null) }, [onOpenTargetChange])

  const openPreview = (file: string, type: ChangeType, groupCwd?: string) => {
    // Aggregate mode has no single cwd; the file-tree pane passes none either, so fall back to the
    // workspace root (its tree nodes are paths relative to it, read via fs). Without this the
    // guard silently dropped file-tree clicks in 全部项目 mode → "preview won't open".
    const target = pickPreviewCwd(groupCwd, cwd, wsPath)
    if (target) setPreview({ file, type, cwd: target })
  }

  // 文件树/变更 tab both open files in the full-screen browser (sidebar left, big content right)
  // instead of the cramped inspector split. `browse` doubles as the sidebar source: 'files' shows
  // the file tree, 'changes' shows the changes list (continuous review picking, default diff mode).
  const [browse, setBrowse] = useState<false | 'files' | 'changes'>(false)
  const openBrowse = (file: string, type: ChangeType, groupCwd?: string, mode?: 'diff' | 'full') => {
    const target = pickPreviewCwd(groupCwd, cwd, wsPath)
    if (target) { setPreview({ file, type, cwd: target, mode }); setBrowse('files') }
  }
  // 变更 pane entry — same overlay, but the sidebar lists the session's changes (no mode → 'diff').
  const openChangeBrowse = (file: string, type: ChangeType, groupCwd?: string) => {
    const target = pickPreviewCwd(groupCwd, cwd, wsPath)
    if (target) { setPreview({ file, type, cwd: target }); setBrowse('changes') }
  }
  const closeBrowse = () => { setBrowse(false); setPreview(null) }
  // Open a design doc reported at the gate in the full-screen viewer, in rendered markdown ('full')
  // mode (a freshly-written doc has no diff). The doc's own cwd (its worktree/workspace root) wins.
  const openDoc = (doc: DesignDocRef) => openBrowse(doc.path, 'M', doc.cwd, 'full')

  // Collect all agent ids
  const allAgentIds = useMemo(() => {
    if (!run) return []
    return run.stages.flatMap(s => s.agents.map(a => a.id))
  }, [run])

  // Total agent count for orch-note
  const totalAgents = allAgentIds.length

  // Seed open ids from running agents; update when run changes
  const [openIds, setOpenIds] = useState<Set<string>>(() => {
    if (!run) return new Set()
    const running = run.stages.flatMap(s => s.agents.filter(a => a.state === 'run').map(a => a.id))
    return new Set(running)
  })
  const [closedIds, setClosedIds] = useState<Set<string>>(new Set())

  // Sync: when run changes, add any newly-running agents to openIds
  // (use a ref-free approach: compute derived open set each render)
  const effectiveOpenIds = useMemo(() => {
    if (!run) return openIds
    const runningIds = run.stages.flatMap(s =>
      s.agents.filter(a => a.state === 'run').map(a => a.id)
    )
    // merge: keep all user-toggled states, ensure running agents are open
    const merged = new Set(openIds)
    runningIds.forEach(id => { if (!closedIds.has(id)) merged.add(id) })
    return merged
  }, [run, openIds, closedIds])

  const allOpen = allAgentIds.length > 0 && allAgentIds.every(id => effectiveOpenIds.has(id))

  const handleExpandAll = () => {
    if (allOpen) {
      setOpenIds(new Set())
      setClosedIds(new Set(allAgentIds))
    } else {
      setOpenIds(new Set(allAgentIds))
      setClosedIds(new Set())
    }
  }

  const handleToggle = (id: string) => {
    setOpenIds(prev => {
      const next = new Set(prev)
      // also seed current state from effectiveOpenIds so toggling works correctly
      allAgentIds.forEach(aid => {
        if (effectiveOpenIds.has(aid)) next.add(aid)
      })
      if (next.has(id)) {
        next.delete(id)
        setClosedIds(c => new Set(c).add(id))
      } else {
        next.add(id)
        setClosedIds(c => { const n = new Set(c); n.delete(id); return n })
      }
      return next
    })
  }

  // Derive chat-panel data from wsInfo
  const selProvider = providers.find(p => p.id === selection?.agentId)
  const agentLabel = selProvider
    ? `${selProvider.displayName} · ${selection!.modelId}`
    : '—'
  // provider id → 显示名,复用已检测的 providers 目录(与上面 selProvider 同一份数据源);未检测到
  // (已卸载/未知 provider)时退回裸 id,而不是新造一张标签表。
  const providerLabel = useCallback(
    (id: string) => providers.find(p => p.id === id)?.displayName ?? id,
    [providers],
  )
  const displayPath = wsPath ?? '—'
  const loadedContext = useMemo(() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const ctx = chat.messages[i].context
      if (ctx && (ctx.skills.length || ctx.rules.length || ctx.mcps?.length)) return ctx
    }
    return undefined
  }, [chat.messages])

  // 本次对话引用: every unique file attached across this session's messages (dedupe by path+name).
  const sessionRefs = useMemo(() => {
    const seen = new Set<string>()
    const out: Attachment[] = []
    for (const m of chat.messages) {
      for (const f of m.files ?? []) {
        const key = `${f.path}::${f.name}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(f)
      }
    }
    return out
  }, [chat.messages])

  const handleToChatMode = () => {
    if (runLiveHereNow) {
      if (!window.confirm('结束当前工作流并回到对话?')) return
      cancel()
    }
    setForceChat(true)
  }

  // Drive the width INLINE for both states. Collapse used to rely on removing the inline width so the
  // `.insp-collapsed { width:0 }` CSS could win — but inline style always beats CSS, so any lingering
  // inline width silently defeated the collapse (first click "did nothing"). Setting 0 explicitly makes
  // collapse deterministic regardless of CSS ordering/transition timing.
  const inspectorStyle = inspectorWidth !== undefined
    ? { flex: inspectorCollapsed ? '0 0 0px' : `0 0 ${inspectorWidth}px`, width: inspectorCollapsed ? 0 : inspectorWidth, minWidth: 0 }
    : undefined

  return (
    <div className="view on" id="view-ws">
      {/* 对话主列 */}
      <div className="chat" style={{ position: 'relative' }}>
        <SessionTabs
          sessions={sessions.sessions}
          activeSessionId={sessions.activeSessionId}
          onSwitch={sessions.switchSession}
          onClose={sessions.closeSession}
          onRename={sessions.renameSession}
          onNew={archived ? () => {} : sessions.newSession}
          workspacePath={wsPath}
          archived={archived}
          attentionIds={attentionIds}
        />
        {/* 只读会话: 基于此历史继续 */}
        {isReadOnlySession && canContinue(activeSession!, roMessages.length) && !archived && (
          <div className="si-continue-bar">
            <button
              className="btn-add"
              onClick={async () => {
                const ext = activeSession!.external!
                // sessionContinueFrom creates a new writable session and broadcasts sessionsChanged.
                // useSessions.onSessionsChanged picks up the update automatically (including the new
                // activeSessionId), so no explicit switchSession call is needed.
                await window.forge.sessionContinueFrom({
                  wsPath: wsPath!,
                  source: ext.source,
                  externalId: ext.externalId,
                  title: activeSession!.title,
                  filePaths: ext.filePaths,
                })
              }}
            >
              基于此历史继续
            </button>
            <span className="si-ro-hint">只读导入会话 · 点击开始新对话</span>
          </div>
        )}
        <ChatJumpRail messages={visibleMessages} scrollRef={scrollRef} />
        <div className="chat-scroll" ref={scrollRef} onScroll={onChatScroll}>
          {archived && <ArchiveNote createdAt={createdAt ?? 0} archivedAt={archivedAt ?? null} />}
          {willUseTextFallback && (
            <div className="ws-archive-note">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <span>⚠️ 此续聊以历史摘要重建，可能丢失部分上下文</span>
            </div>
          )}
          <div className="chat-inner">
            {/* 导入的历史对话(只读)——位于分隔条上方 */}
            {importedHistory.length > 0 && (
              <>
                <MessageStream messages={importedHistory} streamingIds={new Set()} onViewChanges={onViewChanges} windowSize={60} />
                {isContinuedSession && (
                  <div className="imported-sep" role="separator">
                    <span className="line" />
                    <span className="lbl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>以上为导入的历史对话 · 以下为当前对话</span>
                    <span className="line" />
                  </div>
                )}
              </>
            )}
            {/* 当前对话:消息与子代理/主代理的交互卡片按时间线归并内联渲染 */}
            {!isReadOnlySession && buildTimeline(liveMessages, pending, chat.confirms, chat.plans).map(entry => {
              if (entry.kind === 'provider-switch') {
                return (
                  <ProviderSwitchDivider
                    key={`ps-${entry.ts}-${entry.from}-${entry.to}`}
                    from={providerLabel(entry.from)}
                    to={providerLabel(entry.to)}
                  />
                )
              }
              if (entry.kind === 'message') {
                return (
                  <Message
                    key={entry.msg.id}
                    msg={entry.msg}
                    index={entry.index}
                    streaming={chat.streamingIds.has(entry.msg.id)}
                    onViewChanges={onViewChanges}
                    onOpenDoc={openDoc}
                  />
                )
              }
              if (entry.kind === 'pending') {
                const a = entry.action
                return (
                  <ReqCard
                    key={a.id}
                    action={a}
                    onResolve={(p) => {
                      // Allow/deny on the stage-gate this supplement targets abandons the pending supplement too.
                      if (pendingSupplement?.kind === 'gate' && pendingSupplement.id === a.id) setPendingSupplement(null)
                      resolve(p)
                    }}
                    onOpenDoc={openDoc}
                    onSupplement={a.kind === 'confirm' && a.reworkable
                      ? () => startSupplement('gate', a.id, a.role ?? a.title)
                      : undefined}
                  />
                )
              }
              if (entry.kind === 'confirm') {
                const c = entry.confirm
                return (
                  <ReqCard
                    key={c.id}
                    action={{ id: c.id, kind: 'confirm', agentId: 'chat', agentName: '主代理', wsName, provider: 'claude', title: c.title, where: c.where }}
                    onResolve={(p) => chat.resolveConfirm({ id: p.id, decision: p.decision === 'allow' ? 'allow' : 'deny', value: p.value })}
                  />
                )
              }
              return (
                <PlanCard
                  key={entry.plan.id}
                  req={entry.plan}
                  onResolve={(d) => {
                    // Allow/deny on the plan this supplement targets abandons the pending supplement too.
                    if (pendingSupplement?.kind === 'plan' && pendingSupplement.id === entry.plan.id) setPendingSupplement(null)
                    chat.resolvePlan({ id: entry.plan.id, decision: d.decision, value: d.value, selection: d.selection })
                  }}
                  onSwitchWorkflow={(workflowId) => {
                    if (!wsPath) return
                    // Dismiss the current card, then re-propose the same task/approach under the chosen
                    // workflow (undefined = ad-hoc). Backend emits a fresh plan-request with new stages.
                    if (pendingSupplement?.kind === 'plan' && pendingSupplement.id === entry.plan.id) setPendingSupplement(null)
                    chat.resolvePlan({ id: entry.plan.id, decision: 'deny' })
                    void window.forge.reproposeWorkflow({ workspacePath: wsPath, approach: entry.plan.approach, task: entry.plan.task, workflowId })
                  }}
                  onSupplement={() => startSupplement('plan', entry.plan.id, '方案')}
                />
              )
            })}
            {chat.asks.map(a => (
              <ReqCard
                key={a.id}
                action={a.options && a.options.length
                  ? { id: a.id, kind: 'select', agentId: 'delegate', agentName: a.agentName ?? '委派子代理', wsName, provider: 'claude', title: a.title, options: a.options }
                  : { id: a.id, kind: 'input', agentId: 'delegate', agentName: a.agentName ?? '委派子代理', wsName, provider: 'claude', title: a.title }}
                onResolve={(p) => chat.resolveAsk({ id: p.id, decision: p.decision === 'deny' ? 'deny' : 'allow', value: p.value, choice: p.choice })}
              />
            ))}
          </div>
        </div>
        {chat.queue.length > 0 && (
          <div className="task-queue show">
            <div className="tq-head"><span className="tq-dot" />队列中 {chat.queue.length} 条指令 · 当前任务完成后依次执行<button className="tq-clear" onClick={() => chat.clearQueue()}>全部取消</button></div>
            {chat.queue.map((q, i) => (
              <div className="tq-item" key={q.id}>
                <span className="tq-ord">{i + 1}</span>
                <span className="tq-txt">{q.text}</span>
                {q.source !== '你' && <span className="tq-src">来自{q.source}</span>}
                <span className="tq-wait">排队中</span>
                <button className="tq-x" title="取消(AI 尚未读取)" onClick={() => { setQuickSeed({ text: q.text, nonce: Date.now() }); chat.cancelQueued(q.id) }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>
              </div>
            ))}
          </div>
        )}
        {pendingSupplement && (
          <div className="supplement-banner">
            <span>补充中：针对【{pendingSupplement.label}】—— 发送后作为修改方向</span>
            <button className="supplement-cancel" onClick={() => setPendingSupplement(null)}>取消</button>
          </div>
        )}
        {pendingSwitch && (
          <div className="supplement-banner switch-banner">
            <span>当前对话由 <b>{providerLabel(pendingSwitch.from)}</b> 执行。切换到 <b>{providerLabel(pendingSwitch.to)}</b> 会丢失原生上下文；确认后将由 {providerLabel(pendingSwitch.to)} 读取并总结已有对话（会花一些 token）再继续。</span>
            <button className="supplement-ok" onClick={confirmSwitch}>确认切换</button>
            <button className="supplement-cancel" onClick={() => setPendingSwitch(null)}>取消</button>
          </div>
        )}
        <Composer
          providers={providers}
          disabled={!wsPath || !!archived}
          busy={chat.busy}
          running={chat.busy && chat.running != null}
          onStop={() => chat.stop()}
          // Has the running turn produced assistant text yet? Stopping before any output restores the
          // sent message to the box; stopping after output (possible changes) does not.
          turnHasOutput={liveMessages.some(m => m.who === 'ai' && chat.streamingIds.has(m.id) && !!m.text.trim())}
          readOnly={isReadOnlySession}
          archived={!!archived}
          seedText={quickSeed}
          // Remount the composer per chat so its unsent draft is isolated per session (persisted in a
          // module store keyed by the same value) — no draft leaking across sessions, no re-render storm.
          key={`composer ${wsPath ?? ''} ${sessions.activeSessionId ?? ''}`}
          draftKey={`${wsPath ?? ''} ${sessions.activeSessionId ?? ''}`}
          selection={selection}
          dynamicCommands={composerCommands}
          onPickWorkflow={onPickWorkflow}
          autoDecide={autoDecide}
          onToggleAutoDecide={() => {
            const next = !autoDecide
            setAutoDecide(next)
            if (wsPath) window.forge.wsSetAutoDecide?.({ workspacePath: wsPath, value: next })
          }}
          onSelectionChange={(s) => {
            // Provider switch guard: agent changed AND the old provider already ran this session → don't
            // switch yet; raise a confirm banner (switch loses native context; the new provider will
            // summarize prior conversation, spending some tokens). Model-only changes pass through.
            const cur = selection?.agentId
            if (cur && s.agentId !== cur && chat.messages.some(m => m.who === 'ai' && m.provider === cur)) {
              setPendingSwitch({ from: cur, to: s.agentId, toModel: s.modelId, permissionMode: s.permissionMode })
              return
            }
            setSelection(s)
            const sid = sessions.activeSessionId
            if (wsPath && sid) {
              selForRef.current = { ws: wsPath, sid } // this selection now belongs to the active session
              // Agent/model are remembered PER SESSION (not the workflow's develop stage anymore, which
              // used to leak the input-box choice across sessions + workflow config). Persist immediately
              // so the restore effect reads the fresh value.
              window.forge.sessionSetModel?.({ workspacePath: wsPath, sessionId: sid, agentId: s.agentId, modelId: s.modelId })
              // Permission mode is per-session — persist it onto the active session when it changed.
              if (s.permissionMode && s.permissionMode !== activePerm) {
                window.forge.sessionSetPermission?.({ workspacePath: wsPath, sessionId: sid, mode: s.permissionMode })
              }
            }
          }}
          onSend={(m) => {
            // A pending supplement (Task 15 plan / Task 16 gate) hijacks the next send: it routes back
            // to that item's resolver as a 'modify' decision instead of a normal chat message.
            if (pendingSupplement) {
              if (pendingSupplement.kind === 'plan') {
                chat.resolvePlan({ id: pendingSupplement.id, decision: 'modify', value: m.text })
              } else {
                // kind === 'gate' → the orchestrator stage-gate resolver (same one the removed inline
                // textarea used): injects reworkNote and reruns the stage, then re-gates.
                resolve({ id: pendingSupplement.id, decision: 'modify', value: m.text })
              }
              setPendingSupplement(null)
              return
            }
            const runLive = engine.run?.workspacePath === wsPath
            // First message in a freshly-created workspace starts the run (seeded with the text);
            // once started (App clears pendingStartOpts) or if a run is already live, send as chat.
            if (pendingStartOpts && !runLive) { onStartRun?.(pendingStartOpts, m.text) }
            else chat.send(m)
          }}
          onPaste={wsPath ? async (f) => window.forge.savePaste({ workspacePath: wsPath, name: f.name, dataBase64: f.dataBase64 }) : undefined}
        />
      </div>

      {/* 右侧检查器 resize handle — ALWAYS mounted (hidden via CSS when collapsed) so toggling the
          panel never unmounts/remounts it; a remount used to leave the strip unhittable on alternate
          collapse→expand cycles. */}
      {onInspectorHandleDown && (
        <ResizeHandle className="insp-resize" onPointerDown={onInspectorHandleDown} />
      )}

      {/* 右侧检查器 */}
      <aside className={'inspector' + (chatMode ? ' chat' : '') + (preview && !browse ? ' previewing' : '')} style={inspectorStyle}>
        {/* 检查器标签栏 — 在对话/工作流模式下均可见 */}
        <div className="insp-tabs">
            <button
              className={`insp-tab${activeTab === 'agents' ? ' on' : ''}`}
              data-pane="agents"
              onClick={() => setActiveTab('agents')}
            >
              {chatMode ? '概览' : '代理'}
              {!chatMode && run && (
                <span className="badge">
                  {totalAgents}
                </span>
              )}
            </button>
            <button
              className={`insp-tab${activeTab === 'changes' ? ' on' : ''}`}
              data-pane="changes"
              onClick={() => setActiveTab('changes')}
            >
              变更
              {totalChangeCount > 0 && (
                <span className="badge">{totalChangeCount}</span>
              )}
            </button>
            <button
              className={`insp-tab${activeTab === 'files' ? ' on' : ''}`}
              data-pane="files"
              onClick={() => setActiveTab('files')}
            >
              文件树
            </button>
          </div>
        <div className="insp-body">
            {/* 代理编排 / 对话模式 pane */}
            <div className={`insp-pane${activeTab === 'agents' ? ' on' : ''}`} id="pane-agents">
              <div id="mainFlow">
              {run && (
                <>
                  <div className="orch-note">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 16v-4M12 8h.01" />
                    </svg>
                    <span>
                      <b>主代理</b> 已编排 <b>{totalAgents}</b> 个子代理 · 点击任意节点查看执行过程
                    </span>
                  </div>
                  <div className="orch-bar">
                    <span className="orch-legend">
                      <i className="run">执行中</i>
                      <i className="ok">完成</i>
                      <i className="wait">等待</i>
                    </span>
                    <span className="grow" />
                    {engine.run?.workspacePath === wsPath && engine.run?.status === 'run' && (
                      <button
                        className="txt-btn"
                        id="cancelRun"
                        title="终止当前运行"
                        onClick={() => cancel()}
                      >
                        取消运行
                      </button>
                    )}
                    {run?.status === 'err' && !(engine.run?.workspacePath === wsPath && engine.run?.status === 'run') && (
                      <button
                        className="txt-btn resume"
                        id="resumeRun"
                        title={selection ? `从中断处继续 · 用 ${selection.modelId} 续跑剩余阶段` : '从中断处继续执行剩余阶段'}
                        onClick={() => { if (wsPath) void window.forge.resumeRun(wsPath, selection ? { provider: selection.agentId, model: selection.modelId } : undefined) }}
                      >
                        继续执行
                      </button>
                    )}
                    {run?.status === 'err' && !(engine.run?.workspacePath === wsPath && engine.run?.status === 'run') && (
                      <button
                        className="txt-btn"
                        id="discardRun"
                        title="放弃这次工作流,不再从中断处继续;之后需要时重新单独发起一次全新的工作流"
                        onClick={() => {
                          if (!wsPath) return
                          if (!window.confirm('终止并退出这次工作流?将放弃中断处的进度,之后需要时请重新单独发起。')) return
                          void window.forge.discardRun(wsPath)
                          setForceChat(true)
                        }}
                      >
                        终止退出
                      </button>
                    )}
                    <button
                      className="txt-btn"
                      id="toChatMode"
                      title="结束工作流,回到纯对话"
                      onClick={handleToChatMode}
                    >
                      转为对话
                    </button>
                    <button
                      className="txt-btn"
                      id="agentExpandAll"
                      onClick={handleExpandAll}
                    >
                      {allOpen ? '收起全部' : '展开全部'}
                    </button>
                  </div>
                </>
              )}

              <div className="pipe" id="agentTree">
                {run?.stages.map((stage, idx) => {
                  const n = stage.agents.length
                  const stageMode = n > 1 ? `并行 · ${n} 代理` : '单代理'
                  const isParallel = n > 1
                  return (
                    <div
                      key={stage.key}
                      className={`stage${STATE_IDX_MAP[stage.state] ? ' ' + STATE_IDX_MAP[stage.state] : ''}${isParallel ? ' parallel' : ''}`}
                    >
                      <div className="stage-head">
                        <span className="stage-idx">{idx + 1}</span>
                        <span className="stage-name">{stage.name}</span>
                        <span className="stage-mode">{stageMode}</span>
                      </div>
                      <div className={`stage-agents${isParallel ? ' parallel' : ''}`}>
                        {isParallel && (
                          <div className="conc-tag"><span className="conc-pulse" />{n} 个代理同时执行</div>
                        )}
                        {stage.agents.map(agent => (
                          agent.hook || stage.key.startsWith('hook:')
                            ? <HookNode
                                key={agent.id}
                                agent={agent}
                                open={effectiveOpenIds.has(agent.id)}
                                onToggle={() => handleToggle(agent.id)}
                              />
                            : <AgentNode
                                key={agent.id}
                                agent={agent}
                                open={effectiveOpenIds.has(agent.id)}
                                onToggle={() => handleToggle(agent.id)}
                                onViewLog={onViewAgentLog ? () => onViewAgentLog(agent.id, agent.name) : undefined}
                              />
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
              </div>{/* /mainFlow */}

              <div id="mainChat">
                <div className="ic-cta">
                  <div className="ic-cta-h">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l1.9 5.1L20 10l-5.1 1.9L13 17l-1.9-5.1L6 10l5.1-1.9z"/></svg>
                    当前工作流
                  </div>
                  <p>这是当前工作区已配置的执行流程。识别到任务型指令时将按此链路编排为多代理执行。</p>
                  <WorkflowStrip
                    stages={(wsInfo?.workflows?.[0]?.stages ?? wsInfo?.stages ?? []).map(s => ({ key: s.key, name: STAGE_NAMES[s.key] ?? s.key }))}
                    plugins={[...(wsInfo?.plugins ?? []), ...(wsInfo?.stepPlugins ?? [])]}
                  />
                  <button className="ic-edit-flow" disabled={!!archived} onClick={() => onEditWorkspace?.()}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
                    编辑工作流
                  </button>
                </div>

                {/* 工作流速览 — 该工作区所有已命名工作流,逐条展开看每阶段 provider/model,不必进运行/编辑态。 */}
                <WorkflowGlance workflows={wsInfo?.workflows ?? []} />

                {chat.plans.length > 0 && (
                  <div className="ic-card workflow-pending-card">
                    <div className="ic-card-h">工作流待确认</div>
                    <div className="wf-pending-title">{chat.plans[0].task ?? '待执行任务'}</div>
                    <div className="wf-pending-steps">
                      {chat.plans[0].stages.map((stage, idx) => (
                        <div className="wf-pending-step" key={`${stage.name}-${idx}`}>
                          <span>{idx + 1}</span>
                          <b>{stage.name}</b>
                          <i>{stage.agents} agent{stage.agents > 1 ? 's' : ''}</i>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="ic-card ic-card-kv">
                  <div className="ic-card-h">会话</div>
                  <div className="ic-row"><span>编码代理</span><b>{agentLabel}</b></div>
                  <div className="ic-row"><span>工作目录</span><Copyable text={displayPath} className="mono" /></div>
                  {(wsInfo?.projects ?? []).map(p => (
                    <div className="ic-row ic-proj" key={p.repoId || p.name}>
                      <span className="ic-proj-name" title={p.name || p.repoId}>{p.name || p.repoId}</span>
                      {p.branch && (
                        <span className="tree-branch-tag" title={`git 分支:${p.branch}`}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
                          {p.branch}
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {/* 上下文用量卡片已移除:该数字是本地近似(CLI 逐轮 usage token ÷ 硬编码窗口),无法取到 CLI
                    session 的真实剩余上下文,展示不准且影响判断,故不再显示。 */}

                {loadedContext && (
                  <div className="ic-card">
                    <div className="ic-card-h">已加载 SKILL / RULE / MCP</div>
                    <AgentContextMeta context={loadedContext} />
                  </div>
                )}

                <div className="ic-card">
                  <div className="ic-card-h">本次对话引用</div>
                  <div className="ic-refs">
                    {sessionRefs.length === 0 ? (
                      <div className="ic-empty">暂无引用文件。粘贴或附加文件后,会在此列出本次对话引用的内容。</div>
                    ) : (
                      sessionRefs.map(f => (
                        <div className="ic-ref" key={f.path + '::' + f.name}><FileIc name={f.name} /><span className="nm">{f.name}</span></div>
                      ))
                    )}
                  </div>
                </div>

                <div className="ic-card">
                  <div className="ic-card-h">快捷指令</div>
                  <div className="ic-chips">
                    {QUICK_CMDS.map(q => (
                      <button className="ic-chip" key={q.label} onClick={() => setQuickSeed({ text: q.prompt, nonce: Date.now() })}>{q.label}</button>
                    ))}
                  </div>
                </div>
              </div>{/* /mainChat */}
            </div>

            {/* 变更 pane — 项目选择器只在与项目相关的 变更/文件树 里出现 */}
            <div className={`insp-pane${activeTab === 'changes' ? ' on' : ''}`} id="pane-changes">
              {activeTab === 'changes' && <>
                <ProjectPicker projects={projects} activeCwd={selected} onSelect={setActiveCwd} />
                <ChangesPane changes={wt.changes} groups={aggregate ? changeGroups : undefined} cwd={cwd} onOpen={openChangeBrowse} onRefresh={refreshInspector} />
              </>}
            </div>

            {/* 文件树 pane */}
            <div className={`insp-pane${activeTab === 'files' ? ' on' : ''}`} id="pane-files">
              {activeTab === 'files' && <>
                <ProjectPicker projects={projects} activeCwd={selected} onSelect={setActiveCwd} />
                <FileTreePane tree={treeForPane} onOpen={openBrowse} selected={browse ? preview?.file : undefined} searchRoot={treeSearchRoot} onRefresh={refreshInspector} />
              </>}
            </div>
          </div>

        {/* 文件预览 — 分屏:位于检查器下半,上方列表(文件树/变更)保持可见,方便点选其它文件。
            cwd is the file's own (group) cwd in aggregate mode, else the selected single-project cwd. */}
        {preview && !browse && (
          <FilePreview
            open={!!preview}
            cwd={preview.cwd}
            file={preview.file}
            type={preview.type}
            onClose={() => setPreview(null)}
          />
        )}
      </aside>

      {/* 全屏文件浏览器 — 文件树/变更 tab 点击文件触发,覆盖整个工作区(左侧边栏+右大内容)。
          变更入口的左栏是变更清单(连续点选评审),文件树入口保持左树。 */}
      {browse && (
        <FileBrowser
          tree={treeForPane}
          projects={projects}
          activeCwd={selected}
          onSelectProject={setActiveCwd}
          preview={preview}
          onOpen={openBrowse}
          onClose={closeBrowse}
          source={browse}
          changes={wt.changes}
          groups={aggregate ? changeGroups : undefined}
          changesCwd={cwd}
          searchRoot={treeSearchRoot}
          onOpenChange={openChangeBrowse}
          onRefresh={refreshInspector}
        />
      )}
    </div>
  )
}
