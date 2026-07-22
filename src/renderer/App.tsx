import { useEffect, useMemo, useRef, useState } from 'react'
import { Titlebar } from './shell/Titlebar'
import { Sidebar } from './shell/Sidebar'
import { useUnread } from './state/useUnread'
import { ResizeHandle } from './shell/ResizeHandle'
import { StatusBar } from './shell/StatusBar'
import { LogConsole } from './shell/LogConsole'
import { TerminalPanel } from './views/terminal/TerminalPanel'
import { LayoutToggle } from './shell/LayoutToggle'
import './shell/dock.css'
import { useEngine } from './state/useEngine'
import { useConfig } from './state/useConfig'
import { useHookLibrary } from './state/useHookLibrary'
import { useSettings } from './state/useSettings'
import type { OpenTarget } from '@shared/openers'
import { useLogs } from './state/useLogs'
import { useResizable } from './state/useResizable'
import { usePanelDock } from './state/panelDock'
import { useSessions } from './state/useSessions'
import { useSessionsMulti } from './state/useSessionsMulti'
import { toggleExpanded, loadExpanded, saveExpanded } from './state/expandedWs'
import { useUpdate } from './state/useUpdate'
import { usePlugins } from './state/usePlugins'
import { applyTheme } from './theme/applyTheme'
import { injectDownloadedFontFaces } from './theme/fontFaces'
import { fmtRelTime } from '@shared/relTime'
import { WorkspaceView } from './views/WorkspaceView'
import { HomeView } from './views/HomeView'
import { useHome } from './state/useHome'
import { CreateWorkspace } from './views/CreateWorkspace'
import { SettingsModal } from './settings/SettingsModal'
import { ProjectPane } from './settings/ProjectPane'
import { AppearancePane } from './settings/AppearancePane'
import { NotificationsPane } from './settings/NotificationsPane'
import { AppIconPane } from './settings/AppIconPane'
import { TermProxyPane } from './settings/TermProxyPane'
import { AgentsPane } from './settings/AgentsPane'
import { WorkflowPane } from './settings/WorkflowPane'
import { CustomStagesPane } from './settings/CustomStagesPane'
import { HookLibraryPane } from './settings/HookLibraryPane'
import { SkillPane } from './settings/SkillPane'
import { PetPane } from './settings/PetPane'
import { LoadPane } from './settings/LoadPane'
import { PluginPane } from './settings/PluginPane'
import { NsfwPane } from './settings/NsfwPane'
import { UnlockModal } from './settings/UnlockModal'
import { nsfwConfigured } from '@shared/nsfw'
import { SessionImportPane } from './settings/SessionImportPane'
import { DebugLogPane } from './settings/DebugLogPane'
import { AboutPane } from './settings/AboutPane'
import { MemoryPane } from './settings/MemoryPane'
import { KeybindingsPane } from './settings/KeybindingsPane'
import { useKeybindings } from './state/useKeybindings'
import { UpgradeModal } from './shell/UpgradeModal'
import { DeleteConfirm } from './shell/DeleteConfirm'
import { ActionConfirm } from './shell/ActionConfirm'
import { markAllRead, notifFromLifecycle, sanitize, type Notif } from './shell/notifications'
import { SetupProgress, INITIAL_SETUP_STATE, applySetupEvent } from './views/SetupProgress'
import type { SetupProgressState } from './views/SetupProgress'
import type { AgentState, ChatEvent, ChatQueueEvent, CreateWorkspaceOpts, EngineEvent, SetupEvent, Workspace } from '@shared/types'
import { deriveWsBadge } from './shell/wsBadge'

// Minimal renderer-facing shape of the orchestrator's StartRunOpts. The canonical type lives in
// main (src/main/orchestrator/orchestrator.ts), which the renderer must not import at runtime;
// the renderer only ever receives an opaque StartRunOpts from window.forge.createWorkspace to read
// the canonical workspacePath off of (window.forge.startRun itself is gone — the old orchestrator's
// run-start path is disabled; workflows only ever start via run2's launcher now). We keep the fields
// the renderer actually touches typed, plus an index signature so the opaque payload round-trips intact.
export interface StartRunOpts { workspacePath: string; task?: string; [k: string]: unknown }

export function App() {
  const [collapsed, setCollapsed] = useState(false)
  const [inspCollapsed, setInspCollapsed] = useState(false)
  // 全局搜索(Cmd+Shift+F)信号:每次触发 +1,WorkspaceView 据此展开检查器→切到文件树→聚焦搜索框。
  const [searchSignal, setSearchSignal] = useState(0)
  // 启动默认落在首页(HomeView):新用户没有工作区时不再看到一个空的 WorkspaceView。
  const [view, setView] = useState<'home' | 'ws'>('home')
  // 「打开位置」目标:WorkspaceView 上报当前工作区/预览文件,供顶栏按钮消费。
  const [openTarget, setOpenTarget] = useState<OpenTarget | null>(null)
  const [activeId, setActiveId] = useState('')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsPane, setSettingsPane] = useState('appearance')
  const [unlockOpen, setUnlockOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  // Archive / remove-from-list ask for confirmation before firing (they used to run on a single click).
  const [pendingConfirm, setPendingConfirm] = useState<{ kind: 'archive' | 'remove'; id: string } | null>(null)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Workspace | null>(null)
  // Notifications start empty — they're populated by real lifecycle events (notifFromLifecycle).
  // No mock seed, so the bell shows a badge only when something real is unread.
  const [notifs, setNotifs] = useState<Notif[]>([])
  const [notifOpen, setNotifOpen] = useState(false)
  const [upgradeOpen, setUpgradeOpen] = useState(false)
  const updateCtx = useUpdate()
  // Auto-surface the upgrade modal when a (possibly backgrounded) download finishes, so the user is
  // prompted to install even if they minimized it and kept working.
  const prevUpdPhase = useRef(updateCtx.phase)
  useEffect(() => {
    if (updateCtx.phase === 'done' && prevUpdPhase.current !== 'done') setUpgradeOpen(true)
    prevUpdPhase.current = updateCtx.phase
  }, [updateCtx.phase])
  const [logOpen, setLogOpen] = useState(false)
  // When set, the bottom log drawer is scoped to a single agent (opened from its card's 日志台 button).
  const [agentLogFilter, setAgentLogFilter] = useState<{ id: string; name: string } | null>(null)
  const [termOpen, setTermOpen] = useState(false)
  const bothPanels = logOpen && termOpen
  // Bottom dock: layout (stack/split) + per-panel resize, clamped to the dock bounds (never crosses top).
  const dock = usePanelDock(logOpen, termOpen)
  // Setup progress: accumulated events from onSetupEvent during workspace creation with __basic/__proj hooks.
  const [setupState, setSetupState] = useState<SetupProgressState>(INITIAL_SETUP_STATE)
  const [setupVisible, setSetupVisible] = useState(false)
  // 后台运行: the overlay is hidden but setup is still running. Mirrored into a ref because the
  // onSetupEvent subscription below closes over initial state (empty-deps effect) and must read the
  // live value to decide whether to fire a completion notification. creatingNameRef names the
  // in-flight workspace for that notif (the event only carries a path).
  const [setupBackgrounded, setSetupBackgrounded] = useState(false)
  const backgroundedRef = useRef(false)
  const creatingNameRef = useRef('')
  const setBackgrounded = (v: boolean) => { backgroundedRef.current = v; setSetupBackgrounded(v) }
  const sidebar = useResizable('sidebarW', 248, 180, 440, 'right')
  const inspector = useResizable('inspectorW', 380, 280, 720, 'left')
  const engine = useEngine()
  // Workspaces with a chat turn in flight (per-workspace chat-queue busy flag). Used to light the sidebar
  // status dot for chat activity — w.status only reflects orchestrator runs, not a running chat agent.
  const [busyWs, setBusyWs] = useState<Set<string>>(new Set())
  // The session that currently owns each workspace's in-flight chat turn (workspacePath → sessionId).
  // Per-workspace because the chat queue serializes one turn at a time per workspace; across workspaces
  // multiple can run. Drives the per-session status dot so you can tell WHICH session is executing —
  // the workspace-level 运行中 pill alone can't. Derived into `runningSessionIds` below.
  const [runningSessByWs, setRunningSessByWs] = useState<Map<string, string[]>>(new Map())
  // Per-workspace "just had chat activity" timestamp. home.stats.lastMessageAt is only fetched on
  // load/reload, so without this the sidebar's relative time stays stale right after a new turn. Any
  // chat-queue event for a workspace stamps it "now" so its sidebar time refreshes to 刚刚 immediately.
  const [recentActivity, setRecentActivity] = useState<Map<string, number>>(new Map())
  useEffect(() => {
    const off = window.forge.onChatQueueEvent((e: ChatQueueEvent) => {
      setBusyWs(prev => {
        if (e.busy === prev.has(e.workspacePath)) return prev
        const n = new Set(prev)
        if (e.busy) n.add(e.workspacePath); else n.delete(e.workspacePath)
        return n
      })
      setRunningSessByWs(prev => {
        const cur = prev.get(e.workspacePath)
        const next = e.runningSessionIds
        // Skip the state churn when the running-session set is unchanged (order-insensitive).
        if ((cur ?? []).length === next.length && (cur ?? []).every(s => next.includes(s))) return prev
        const n = new Map(prev)
        if (next.length) n.set(e.workspacePath, next); else n.delete(e.workspacePath)
        return n
      })
      setRecentActivity(prev => { const n = new Map(prev); n.set(e.workspacePath, Date.now()); return n })
    })
    return () => { off() }
  }, [])
  // User feedback (2026-07-20): a RUNNING workflow's session dot didn't light. `engine.run.sessionId`
  // below only covers the LEGACY orchestrator run — now unreachable (run2 is the sole workflow path),
  // so a run2 run's owning session never lit. Track each workspace's live run2 run's owning session
  // (workspacePath → sessionId) from the run2:update broadcast; a non-terminal run (running/awaiting)
  // lights it, terminal (ok/failed) clears it. Folded into `runningSessionIds` below.
  const [run2SessByWs, setRun2SessByWs] = useState<Map<string, string>>(new Map())
  // Per-workspace pending-gate counts for the sidebar status badge (#3). Chat gates come from ChatEvent
  // (confirm-request/ask-request, each carries workspacePath); workflow gates come from run2 state.pending.
  const [chatGateByWs, setChatGateByWs] = useState<Map<string, { confirm: Set<string>; input: Set<string> }>>(new Map())
  useEffect(() => {
    const off = window.forge.onChatEvent((e: ChatEvent) => {
      setChatGateByWs(prev => {
        const n = new Map(prev)
        const cur = n.get(e.workspacePath) ?? { confirm: new Set<string>(), input: new Set<string>() }
        const confirm = new Set(cur.confirm), input = new Set(cur.input)
        if (e.type === 'confirm-request') confirm.add(e.id)
        else if (e.type === 'confirm-resolved') confirm.delete(e.id)
        else if (e.type === 'ask-request') input.add(e.id)
        else if (e.type === 'ask-resolved') input.delete(e.id)
        else return prev
        n.set(e.workspacePath, { confirm, input })
        return n
      })
    })
    return () => { off() }
  }, [])
  const [run2GateByWs, setRun2GateByWs] = useState<Map<string, { confirm: number; input: number }>>(new Map())
  useEffect(() => {
    const off = (window as any).forge?.run2?.onUpdate?.((p: { workspacePath: string; state: { sessionId?: string; status?: string; pending?: import('@shared/types').PendingAction[] } | null }) => {
      const st = p.state
      const sid = st?.sessionId
      const active = !!st && st.status !== 'ok' && st.status !== 'failed'
      setRun2SessByWs(prev => {
        const cur = prev.get(p.workspacePath)
        const next = active && sid ? sid : undefined
        if (cur === next) return prev
        const n = new Map(prev)
        if (next) n.set(p.workspacePath, next); else n.delete(p.workspacePath)
        return n
      })
      setRun2GateByWs(prev => {
        const pend = st?.pending ?? []
        const confirm = pend.filter(a => a.kind === 'confirm').length
        const input = pend.filter(a => a.kind === 'input' || a.kind === 'select').length
        const n = new Map(prev)
        if (confirm || input) n.set(p.workspacePath, { confirm, input }); else n.delete(p.workspacePath)
        return n
      })
    })
    return () => { off?.() }
  }, [])
  // Relative "last activity" labels (刚刚 / N 分钟前 / N 小时前) are computed against `now`. Without a
  // periodic tick that `now` is frozen at the last render, so a 刚刚 never ages to 2 小时前 on its own.
  // Re-stamp every minute (matches the label's minute granularity) to keep them current.
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  const { logs, busy: logBusy, clear: clearLogs } = useLogs()
  const pluginsApi = usePlugins()
  const { usageByProvider } = pluginsApi
  const notifAgentPrev = useRef<Map<string, AgentState>>(new Map())
  const notifRunPrev = useRef<Map<string, AgentState>>(new Map())
  const home = useHome()
  const { projects, workflows, customStages, providers, addProject, deleteProject, updateProjectBranch, addWorkflow, deleteWorkflow, updateWorkflow, updateStagePrompts, updateStages, upsertCustomStage, deleteCustomStage, redetect } = useConfig()
  const hookLib = useHookLibrary()
  const { settings, update } = useSettings()
  const sidebarGroups = useMemo(() => {
    const now = nowTick
    const items = home.workspaces.map(w => {
      const cg = chatGateByWs.get(w.path)
      const rg = run2GateByWs.get(w.path)
      const confirm = (cg?.confirm.size ?? 0) + (rg?.confirm ?? 0)
      const input = (cg?.input.size ?? 0) + (rg?.input ?? 0)
      // Light the dot when an agent is actually executing here: a chat turn in flight OR the live
      // orchestrator run. Kept separate from `status` (which drives the persisted 运行中 pill).
      const live = busyWs.has(w.path) || (engine.run?.status === 'run' && engine.run.workspacePath === w.path)
      return {
        id: w.path, name: w.name,
        sub: w.archived
          ? (w.description || '已归档 · 只读')
          : (w.imported ? '本机导入' : `${w.projectCount} 个项目`),
        status: w.status as AgentState,
        imported: w.imported,
        live,
        statusBadge: w.archived ? null : deriveWsBadge({ live, confirm, input }),
        pinned: w.pinned,
        lastActivity: fmtRelTime(Math.max(home.stats[w.path]?.lastMessageAt ?? 0, recentActivity.get(w.path) ?? 0), now),
        archived: w.archived,
        archivedAt: w.archivedAt,
        createdAt: w.createdAt,
      }
    })
    const live = items.filter(i => !i.archived)
    const pinned = live.filter(i => i.pinned)
    const rest = live.filter(i => !i.pinned)
    // No 进行中/最近 split anymore — pinned items get their own group at the top (置顶), and
    // everything else is one flat, drag-reorderable list (group key 'all'). Archived workspaces
    // live in a separate collapsible dock at the bottom (see archivedItems).
    return [
      ...(pinned.length ? [{ key: 'pinned', label: '置顶', items: pinned }] : []),
      { key: 'all', label: '全部', items: rest },
    ]
  }, [home.workspaces, home.stats, busyWs, engine.run, recentActivity, nowTick, chatGateByWs, run2GateByWs])
  const archivedItems = useMemo(
    () => home.workspaces.filter(w => w.archived).map(w => ({
      id: w.path, name: w.name,
      sub: w.description || '已归档 · 只读',
      status: 'idle' as AgentState,
      imported: w.imported, archived: true,
      archivedAt: w.archivedAt, createdAt: w.createdAt,
    })),
    [home.workspaces],
  )
  // user selection wins; fall back to the live run's workspace when nothing selected yet
  const activeWsId = activeId || (engine.run?.workspacePath ?? '')
  // On the home view the titlebar shows just "Forge" — never a stale workspace name from the
  // last-viewed workspace or a still-active run.
  const crumb = view === 'home' ? '' : (home.workspaces.find(w => w.path === activeWsId)?.name ?? engine.run?.workspaceName ?? '')
  const sessions = useSessions(activeWsId || undefined)
  // Sidebar unread dots: a session that finishes while you're elsewhere gets marked; the one you're
  // viewing is always read. On the home view nothing is "viewed", so pass empty ids.
  const unread = useUnread({ wsPath: view === 'ws' ? activeWsId : '', sessionId: sessions.activeSessionId ?? '' })

  // expandedWs: tracks which workspaces are expanded in the sidebar (persisted to localStorage).
  // Expansion is purely user-toggled — clicking a workspace (even the active one) freely
  // collapses/expands it. We intentionally do NOT force the active workspace open.
  const [expandedWs, setExpandedWs] = useState<Set<string>>(() => new Set(loadExpanded()))
  const expandedPaths = useMemo(() => Array.from(expandedWs), [expandedWs])
  const sessionsByWs = useSessionsMulti(expandedPaths)
  // Merge active workspace's live sessions (from useSessions) so active-ws session ops remain instant
  const sessionsMap = { ...sessionsByWs, ...(activeWsId ? { [activeWsId]: sessions.sessions } : {}) }
  // Session ids with something actually executing right now: an in-flight chat turn (per-workspace, from
  // the chat queue) plus the live orchestrator run (which carries its own sessionId). Drives the sidebar
  // per-session dot so multiple concurrently-running sessions each light up, not just the workspace pill.
  const runningSessionIds = useMemo(() => {
    const s = new Set<string>()
    for (const ids of runningSessByWs.values()) for (const sid of ids) s.add(sid)
    if (engine.run?.status === 'run' && engine.run.sessionId) s.add(engine.run.sessionId)
    for (const sid of run2SessByWs.values()) s.add(sid) // live run2 workflow's owning session (see above)
    return s
  }, [runningSessByWs, engine.run?.status, engine.run?.sessionId, run2SessByWs])
  const onToggleExpand = (id: string) => setExpandedWs(s => { const n = toggleExpanded(s, id); saveExpanded([...n]); return n })

  // Tell the pet which workspace the main window is "in" (null on home) so its command input can target it
  // even when idle. On home the pet falls back to a workspace the user click-selects in its own list.
  useEffect(() => {
    window.forge.setActiveWorkspace?.(view === 'ws' ? (activeWsId || null) : null)
  }, [view, activeWsId])

  // If the open workspace is removed/deleted while you're viewing it, fall back to home. Covers every
  // removal path (hard delete, 从列表移除 an imported workspace, or a removal broadcast from another
  // window): once it's gone from the list (and isn't the live run), keep showing its session area would
  // render a workspace that no longer exists. archive keeps it in the list (read-only) so it stays open.
  useEffect(() => {
    if (view !== 'ws' || !activeId) return
    const exists = home.workspaces.some(w => w.path === activeId)
    if (!exists && engine.run?.workspacePath !== activeId) { setActiveId(''); setView('home') }
  }, [home.workspaces, activeId, view, engine.run?.workspacePath])

  // Remember the last workspace the user was in (persisted) so the titlebar's 工作区 tab can restore
  // it next launch — the per-workspace activeSessionId then restores the last session for free.
  const lastWrittenWs = useRef('')
  useEffect(() => {
    if (!activeWsId || !settings || lastWrittenWs.current === activeWsId) return
    lastWrittenWs.current = activeWsId
    if (settings.lastActiveWorkspace !== activeWsId) update({ lastActiveWorkspace: activeWsId })
  }, [activeWsId, settings])

  // vibrancy maps to the window's transparent/under-window material, which is fixed at WINDOW
  // CONSTRUCTION (launch). Flipping it live would lay the translucent CSS over a window whose
  // transparency can't change → glitchy render. Freeze data-vibrancy to the launch value; the
  // setting only takes effect on the next restart (the toggle copy says so).
  const launchVibrancy = useRef<boolean | null>(null)
  useEffect(() => {
    if (!settings) return
    if (launchVibrancy.current === null) launchVibrancy.current = settings.appearance.vibrancy
    // Window transparency is now done via setOpacity (main process), not the vibrancy/glass CSS path,
    // which is shelved — keep vibrancy frozen to its launch value (harmless; both default off).
    const appearance = { ...settings.appearance, vibrancy: launchVibrancy.current }
    applyTheme(appearance)
    if (appearance.theme !== 'auto') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(appearance)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [settings])

  useEffect(() => {
    const off = window.forge.onNavigateWorkspace(({ path }) => { setActiveId(path); setView('ws') })
    return () => { off() }
  }, [])

  // Make any downloaded fonts (settings · 外观 · 应用字体) usable app-wide by injecting their @font-face
  // rules once at startup. The picker re-injects after a new download; this covers the launch path.
  useEffect(() => { void injectDownloadedFontFaces() }, [])

  // Hidden entry for gated extra content: a secret shortcut (Cmd/Ctrl+Shift+Alt+U) opens the activation
  // dialog. Nothing surfaces this in the UI. Dead (does nothing) when no content Worker is configured.
  useEffect(() => {
    if (!nsfwConfigured()) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.altKey && e.code === 'KeyU') {
        e.preventDefault()
        setUnlockOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Global-shortcut registration status from main (which OS-level accelerators the OS refused) — fed to
  // the keybindings settings pane so it can flag "already taken" conflicts. Terminal toggle and every
  // other in-app shortcut are now driven by the keybindings dispatcher below (see handlers/useKeybindings).
  const [globalFailed, setGlobalFailed] = useState<string[]>([])
  useEffect(() => {
    void window.forge.getShortcutStatus?.().then(s => setGlobalFailed(s?.failed ?? []))
    const off = window.forge.onShortcutStatus?.((s) => setGlobalFailed(s?.failed ?? []))
    return () => { off?.() }
  }, [])

  // Subscribe to workspace setup events (streamed during creation when __basic/__proj hooks exist).
  useEffect(() => {
    const off = window.forge.onSetupEvent((e: SetupEvent) => {
      if (e.type === 'setup:start') {
        setSetupState(INITIAL_SETUP_STATE)
        setSetupVisible(true)
        setBackgrounded(false)
      }
      setSetupState(prev => applySetupEvent(prev, e))
      if (e.type === 'setup:done') {
        // If the user backgrounded the panel, they can't see it finish — surface completion via the
        // bell so they know the workspace is ready. (When the panel is visible it shows 全部完成 and
        // handleCreate navigates on resolve, so no notif is needed there.)
        if (backgroundedRef.current) {
          const name = creatingNameRef.current || '工作区'
          setNotifs(ns => [{ ic: 'ok', cls: 'ni-ok', t: `<b>${sanitize(name)}</b> 工作区创建完成`, m: `建区 Hook 执行完毕 · 点击进入 · 刚刚`, unread: true, wsPath: e.workspacePath }, ...ns])
        }
        setBackgrounded(false)
      }
    })
    return () => { off() }
  }, [])

  // The legacy orchestrator engine-event stream (agent:stalled / pending:add / run:update failure
  // notifications) is gone with the orchestrator; run2 surfaces its own run cards/notifications. No
  // engine-bus subscription remains here.

  // Main-process event-loop stalls (perf monitor) surface as a bell notification.
  useEffect(() => {
    const off = window.forge.onPerfStall?.(({ msg }) => {
      // App-global (whole-app main process), NOT a session — clarify the subtitle so it isn't mistaken
      // for a workspace's agent, and route the click to the debug-log pane where stalls are recorded.
      setNotifs(ns => [{ ic: 'warn', cls: 'ni-warn', t: `<b>性能</b> ${sanitize(msg)}`, m: '应用主进程(非会话) · 刚刚', unread: true, settingsPane: 'debug' }, ...ns])
    })
    return () => off?.()
  }, [])

  const openWizard = () => { setCreateErr(null); setEditing(null); setWizardOpen(true) }

  const openEdit = async () => {
    if (!activeWsId) return
    const ws = await window.forge.getWorkspace(activeWsId)
    if (!ws) return
    setCreateErr(null); setEditing(ws); setWizardOpen(true)
  }
  // Edit a specific workspace by path (from the sidebar ⋯ / right-click menu), not just the active one.
  const openEditFor = async (path: string) => {
    const ws = await window.forge.getWorkspace(path)
    if (!ws) return
    setActiveId(path); setCreateErr(null); setEditing(ws); setWizardOpen(true)
  }
  // Quick alias rename (no wizard) from the sidebar.
  const renameWs = (path: string, name: string) => { void window.forge.renameWorkspace?.({ path, name }).then(() => home.reload()) }

  async function handleEdit(opts: CreateWorkspaceOpts) {
    if (creating || !editing) return
    creatingNameRef.current = opts.name          // name a backgrounded edit-done notif
    setCreating(true)
    try {
      // Adding a project provisions a worktree (slow git clone); editWorkspace now emits the same setup
      // events as create, so the SetupProgress overlay shows live pull progress instead of a hung 保存中.
      await window.forge.editWorkspace({ path: editing.path, opts, runProjHooks: opts.runProjHooks })
      setCreateErr(null); setWizardOpen(false); setEditing(null)
      setSetupVisible(false); setSetupState(INITIAL_SETUP_STATE)
      home.reload()
    } catch (e) {
      setSetupVisible(false); setSetupState(INITIAL_SETUP_STATE)
      setCreateErr(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
      setBackgrounded(false)
    }
  }

  async function handleCreate(opts: CreateWorkspaceOpts) {
    if (creating) return                         // guard against double-submit
    creatingNameRef.current = opts.name          // name the in-flight workspace for a backgrounded-done notif
    setCreating(true)                            // disable the create button + show 创建中… (git worktree/fetch is slow)
    try {
      const { startRunOpts } = await window.forge.createWorkspace(opts)
      // main expands `~` once and stores/registers/runs under the absolute path, so the renderer
      // MUST key everything off that canonical path — not the raw `opts.path` (which may be `~/…`).
      const wsPath = (startRunOpts as StartRunOpts).workspacePath
      setCreateErr(null)
      setWizardOpen(false)                       // close only on success
      setSetupVisible(false)                     // dismiss setup progress panel
      setSetupState(INITIAL_SETUP_STATE)         // reset for next creation
      setActiveId(wsPath)                        // highlight the new workspace in the sidebar
      setView('ws')                              // switch to the workspace view
      home.reload()                              // newly-created workspace shows on next home visit
      // No auto-run stash: the new workspace opens in plain chat. Workflows only start explicitly
      // via the run2 launcher (see handleQuickFolder below for the same no-stash pattern).
    } catch (e) {
      setSetupVisible(false)                     // also dismiss on error
      setSetupState(INITIAL_SETUP_STATE)
      // User-cancelled creation is not an error: the partial stays on disk (record dropped from the
      // sidebar) so re-picking the folder restores + continues. Show a gentle hint instead of a red error.
      const cancelled = e instanceof Error && e.name === 'SetupCancelledError'
      setCreateErr(cancelled ? '已取消创建。已拉取的部分已保留 —— 重新选择该文件夹可继续创建，或在向导里清除重来。' : (e instanceof Error ? e.message : String(e)))
      setWizardOpen(true)                        // re-open the wizard so the error is visible even if the
                                                 // user had 后台运行'd it closed (onBackground clears wizardOpen).
    } finally {
      setCreating(false)
      setBackgrounded(false)
    }
  }

  // 空态快速上手:选一个本地文件夹,建一个「纯文件夹工作区」(无项目、无阶段)直接进入对话。
  async function handleQuickFolder() {
    if (creating) return
    let dir: string | null = null
    try { dir = await window.forge.pickDirectory() } catch { dir = null }
    if (!dir) return
    setCreating(true)
    try {
      const name = dir.split('/').filter(Boolean).pop() || '工作区'
      const { startRunOpts } = await window.forge.createWorkspace({
        name, path: dir, workflows: [], projects: [],
      })
      const wsPath = (startRunOpts as StartRunOpts).workspacePath
      setCreateErr(null)
      setSetupVisible(false)                     // dismiss setup progress panel (no run to watch)
      setSetupState(INITIAL_SETUP_STATE)         // reset for next creation
      setActiveId(wsPath)
      setView('ws')
      home.reload()
    } catch (e) {
      setSetupVisible(false)                     // also dismiss on error
      setSetupState(INITIAL_SETUP_STATE)
      setCreateErr(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  const activeWsMeta = home.workspaces.find(w => w.path === activeWsId)

  // 标题栏「工作区」在没有选中工作区时不落到禁用的空 Composer:优先恢复上次活跃工作区
  // (settings.lastActiveWorkspace,会话随 per-ws activeSessionId 自动恢复),否则挑最近有
  // 动静的;一个工作区都没有就留在首页。
  const handleView = (v: 'home' | 'ws') => {
    if (v === 'ws' && !activeWsId) {
      const live = home.workspaces.filter(w => !w.archived)
      if (!live.length) return
      const last = settings?.lastActiveWorkspace
      const recency = (p: string) => Math.max(home.stats[p]?.lastMessageAt ?? 0, recentActivity.get(p) ?? 0)
      const pick = last && live.some(w => w.path === last)
        ? last
        : [...live].sort((a, b) => recency(b.path) - recency(a.path))[0].path
      setActiveId(pick)
    }
    setView(v)
  }

  // ── Keyboard shortcuts (in-app dispatcher) ──────────────────────────────────
  // Map each scope==='app' action id to its handler. Global (OS-level) actions live in main. wsOrder
  // mirrors the sidebar order (pinned first) so prev/next-workspace cycle the way the list reads.
  const wsOrder = useMemo(() => sidebarGroups.flatMap(g => g.items.map(i => i.id)), [sidebarGroups])
  const cycle = (list: string[], current: string, dir: 1 | -1): string | undefined => {
    if (!list.length) return undefined
    const i = list.indexOf(current)
    return i === -1 ? list[0] : list[(i + dir + list.length) % list.length]
  }
  const kbHandlers: Record<string, () => void> = {
    'new-workspace': openWizard,
    'new-session': () => { void sessions.newSession() },
    'prev-session': () => { const id = cycle(sessions.sessions.map(s => s.id), sessions.activeSessionId ?? '', -1); if (id) void sessions.switchSession(id) },
    'next-session': () => { const id = cycle(sessions.sessions.map(s => s.id), sessions.activeSessionId ?? '', 1); if (id) void sessions.switchSession(id) },
    'prev-workspace': () => { const id = cycle(wsOrder, activeWsId, -1); if (id) { setActiveId(id); setView('ws') } },
    'next-workspace': () => { const id = cycle(wsOrder, activeWsId, 1); if (id) { setActiveId(id); setView('ws') } },
    'toggle-terminal': () => setTermOpen(o => !o),
    'toggle-log': () => setLogOpen(o => !o),
    'toggle-sidebar': () => setCollapsed(c => !c),
    'toggle-inspector': () => setInspCollapsed(c => !c),
    'search-global': () => { if (view === 'ws') { setInspCollapsed(false); setSearchSignal(n => n + 1) } },
    'toggle-settings': () => { if (settingsOpen) setSettingsOpen(false); else { setSettingsPane('appearance'); setSettingsOpen(true) } },
    'open-plugins': () => { setSettingsPane('plugins'); setSettingsOpen(true) },
  }
  useKeybindings(settings?.keybindings?.overrides ?? {}, kbHandlers)

  // Tray / Dock context-menu items dispatch through the same handler map as keybindings. Keep the
  // latest map in a ref so the one-time subscription always calls current closures.
  const kbRef = useRef(kbHandlers)
  kbRef.current = kbHandlers
  useEffect(() => {
    const off = window.forge.onMenuAction?.(action => kbRef.current[action]?.())
    return () => { off?.() }
  }, [])

  return (
    <div className={`window${collapsed ? ' collapsed' : ''}${inspCollapsed ? ' insp-collapsed' : ''}${view === 'home' ? ' home-mode' : ''}`}>
      {/* App-wide background image layer (shown only when appearance.bgScope === 'app'; the chat-only
          scope is drawn by .chat::before instead). Fixed, behind all chrome, image + opacity from CSS vars. */}
      <div className="app-bg-layer" aria-hidden="true" />
      <Titlebar
        collapsed={collapsed}
        onToggleSidebar={() => setCollapsed(c => !c)}
        onToggleInspector={() => setInspCollapsed(c => !c)}
        view={view}
        onView={handleView}
        crumb={crumb}
        onOpenSettings={() => { setSettingsPane('appearance'); setSettingsOpen(true) }}
        notifs={notifs}
        updateAvailable={!!updateCtx.info}
        updateInfo={updateCtx.info}
        notifOpen={notifOpen}
        onToggleNotif={() => setNotifOpen(o => !o)}
        onOpenUpgrade={() => { setNotifOpen(false); setUpgradeOpen(true) }}
        onMarkAllRead={() => setNotifs(markAllRead(notifs))}
        onClearAllNotif={() => setNotifs([])}
        onSelectNotif={(n, i) => {
          // Every notif is clickable to mark it read. Then navigate to its source: a workspace (its
          // chat/session area) when known — resolving a name-only route via the registry — or a settings
          // pane for app-global notifs (e.g. a perf stall → 调试日志). Read-only notifs just mark read.
          setNotifs(ns => ns.map((x, j) => (j === i ? { ...x, unread: false } : x)))
          const path = n.wsPath || home.workspaces.find(w => w.name === n.wsName)?.path
          if (path) { setActiveId(path); setView('ws'); setNotifOpen(false) }
          else if (n.settingsPane) { setSettingsPane(n.settingsPane); setSettingsOpen(true); setNotifOpen(false) }
        }}
        canEditWorkspace={!!activeWsId}
        onEditWorkspace={openEdit}
        openTarget={view === 'ws' ? openTarget : null}
        defaultOpenerId={settings?.defaultOpenerId ?? ''}
        onSetDefaultOpener={(id) => update({ defaultOpenerId: id })}
      />
      <div className="body">
        <Sidebar
          groups={sidebarGroups}
          archivedItems={archivedItems}
          activeId={activeWsId}
          onSelect={(id) => { setActiveId(id); setView('ws') }}
          onNew={openWizard}
          onPin={(id, pinned) => { home.setPinned(id, pinned).catch(e => alert(e instanceof Error ? e.message : String(e))) }}
          onEdit={(id) => void openEditFor(id)}
          onRename={renameWs}
          onArchive={(id) => setPendingConfirm({ kind: 'archive', id })}
          onRestore={home.restore}
          onDelete={(id) => setPendingDelete(id)}
          onReveal={(id) => { home.reveal(id).then(r => { if (!r.ok) alert('打开失败：' + (r.error ?? '路径不存在')) }) }}
          onRemove={(id) => setPendingConfirm({ kind: 'remove', id })}
          onReorder={(ids) => { home.setOrder(ids).catch(e => alert(e instanceof Error ? e.message : String(e))) }}
          collapsed={collapsed}
          width={view === 'home' ? undefined : sidebar.width}
          sessions={sessions.sessions}
          activeSessionId={sessions.activeSessionId}
          onSwitchSession={(wsId, sessionId) => {
            // Clicking a session in a non-active (but expanded) workspace must switch to THAT
            // workspace — sessions.switchSession is scoped to the active ws, so route by wsId.
            if (wsId === activeWsId) { void sessions.switchSession(sessionId); return }
            setActiveId(wsId); setView('ws')
            void window.forge.sessionSwitch?.({ workspacePath: wsId, sessionId })
          }}
          onCloseSession={sessions.closeSession}
          onRenameSession={sessions.renameSession}
          onNewSession={(wsId) => {
            // Active workspace: use the bound sessions hook. A non-active (but visible) workspace's
            // "+" must create the session against ITS path — sessions.newSession is scoped to the
            // active ws — so create it directly, then navigate so useSessions(wsId) loads it active.
            if (!wsId || wsId === activeWsId) { void sessions.newSession(); return }
            void (async () => { await window.forge.sessionNew?.(wsId); setActiveId(wsId); setView('ws') })()
          }}
          expandedIds={new Set(expandedPaths)}
          sessionsByWs={sessionsMap}
          runningSessionIds={runningSessionIds}
          onToggleExpand={onToggleExpand}
          unread={unread}
        />
        {!collapsed && view !== 'home' && <ResizeHandle onPointerDown={sidebar.onHandleDown} />}
        <div className="content">
          {view === 'home'
            ? <HomeView
                workspaces={home.workspaces}
                stats={home.stats}
                activeRunPath={engine.run?.workspacePath}
                busyPaths={busyWs}
                run={engine.run ?? undefined}
                onNew={openWizard}
                onOpenDir={() => { void home.openDir() }}
                onQuickFolder={() => { void handleQuickFolder() }}
                onOpenWorkspace={(m) => { setActiveId(m.path); setView('ws') }}
                onOpenSettings={() => { setSettingsPane('providers'); setSettingsOpen(true) }}
              />
            : <WorkspaceView
                engine={engine}
                providers={providers}
                workspacePath={activeWsId || undefined}
                inspectorWidth={inspector.width}
                onInspectorHandleDown={inspector.onHandleDown}
                inspectorCollapsed={inspCollapsed}
                searchSignal={searchSignal}
                sessionsApi={sessions}
                onEditWorkspace={openEdit}
                archived={!!activeWsMeta?.archived}
                createdAt={activeWsMeta?.createdAt ?? 0}
                archivedAt={activeWsMeta?.archivedAt ?? null}
                onViewAgentLog={(id, name) => { setAgentLogFilter({ id, name }); setLogOpen(true); dock.setFocus('log') }}
                onOpenTargetChange={setOpenTarget}
                runningSessionIds={runningSessionIds}
              />}
        </div>
      </div>
      <div
        className={dock.dockClass}
        style={dock.dockStyle}
        ref={dock.dockRef}
        onPointerDownCapture={(e) => {
          const el = (e.target as HTMLElement).closest('.logcon, .term')
          if (el?.classList.contains('logcon')) dock.setFocus('log')
          else if (el?.classList.contains('term')) dock.setFocus('term')
        }}
      >
        <LogConsole
          open={logOpen}
          dual={bothPanels}
          focused={dock.focused === 'log'}
          onHandleDown={dock.startResize('log')}
          logs={logs}
          busy={logBusy}
          onClear={clearLogs}
          onClose={() => { setLogOpen(false); setAgentLogFilter(null) }}
          agentFilter={agentLogFilter}
          onClearAgentFilter={() => setAgentLogFilter(null)}
        />
        <TerminalPanel
          open={termOpen}
          dual={bothPanels}
          focused={dock.focused === 'term'}
          onHandleDown={dock.startResize('term')}
          workspaceCwd={activeWsId || undefined}
          font={settings?.terminal ?? { fontFamily: "'MesloLGS NF', 'JetBrainsMono Nerd Font', Menlo, ui-monospace, monospace", fontSize: 12.5 }}
          onRequestClose={() => setTermOpen(false)}
        />
        {/* Vertical divider for left/right resize (only shown when both panels are side-by-side, via CSS) */}
        <div className="panel-split-resizer" onPointerDown={dock.startSplitResize} role="separator" aria-orientation="vertical" title="拖动调整左右宽度" />
        {/* Floating layout pill — only visible when both panels are open (CSS) */}
        <LayoutToggle layout={dock.layout} onToggle={dock.toggleLayout} />
      </div>
      <StatusBar
        providers={providers}
        usageByProvider={usageByProvider}
        sbLog={{
          open: logOpen,
          live: logBusy,
          has: logs.length > 0 && !logOpen,
          onToggle: () => setLogOpen(o => !o),
        }}
        sbTerm={{ open: termOpen, onToggle: () => setTermOpen(o => !o) }}
        update={{
          currentVersion: updateCtx.currentVersion,
          hasUpdate: !!updateCtx.info,
          updateVersion: updateCtx.info?.version,
          checking: updateCtx.phase === 'checking',
          uptodate: updateCtx.phase === 'uptodate',
          checkFailed: updateCtx.phase === 'checkfailed',
          checkError: updateCtx.error,
          onCheck: updateCtx.check,
          onOpenUpgrade: () => setUpgradeOpen(true),
        }}
      />

      <CreateWorkspace
        open={wizardOpen}
        onCancel={() => { setWizardOpen(false); setCreateErr(null); setEditing(null) }}
        onCreate={(opts) => { if (editing) void handleEdit(opts); else void handleCreate(opts) }}
        editing={editing}
        projects={projects}
        workflows={workflows}
        customStages={customStages}
        providers={providers}
        onOpenProjectSettings={() => { setWizardOpen(false); setSettingsPane('project'); setSettingsOpen(true) }}
        onNewWorkflow={() => { setWizardOpen(false); setSettingsPane('workflow'); setSettingsOpen(true) }}
        onAddProject={addProject}
        onAddWorkflow={addWorkflow}
        onPickPath={() => window.forge.pickDirectory()}
        hookLibrary={hookLib.hooks}
        onSaveHookToLibrary={hookLib.save}
        onProbeWorkspace={(p) => window.forge.getWorkspace(p)}
        onDiscardPartial={(p) => window.forge.discardPartialWorkspace(p)}
        error={createErr}
        creating={creating}
      />

      {pendingDelete && (() => {
        const delWs = home.workspaces.find(w => w.path === pendingDelete)
        return (
          <DeleteConfirm
            name={delWs ? delWs.name + ' · ' + delWs.path : ''}
            purges={!delWs?.imported}
            onCancel={() => setPendingDelete(null)}
            onConfirm={() => { const p = pendingDelete; setPendingDelete(null); if (p) void home.remove(p) }}
          />
        )
      })()}

      {pendingConfirm && (() => {
        const ws = home.workspaces.find(w => w.path === pendingConfirm.id)
        const name = ws ? ws.name + ' · ' + ws.path : ''
        const { kind, id } = pendingConfirm
        const close = () => setPendingConfirm(null)
        const run = () => {
          close()
          if (kind === 'archive') void home.archive(id)
          else home.removeFromList(id).catch(e => alert(e instanceof Error ? e.message : String(e)))
        }
        return kind === 'archive' ? (
          <ActionConfirm kicker="归档" title="归档此工作区？" confirmLabel="归档"
            copy="归档后它会移到侧栏底部的归档坞、变为只读，磁盘文件不受影响，随时可以恢复。"
            name={name} onCancel={close} onConfirm={run} />
        ) : (
          <ActionConfirm kicker="移除" title="从列表移除此工作区？" confirmLabel="移除"
            copy="只把这条记录从列表移除，磁盘上的文件和仓库都会保留。之后可以重新导入。"
            name={name} onCancel={close} onConfirm={run} />
        )
      })()}

      {unlockOpen && <UnlockModal onClose={() => setUnlockOpen(false)} onUnlock={(code) => { update({ nsfwUnlocked: true, nsfwCode: code }); setSettingsPane('nsfw'); setSettingsOpen(true) }} />}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} initialPane={settingsPane} showNsfw={!!settings?.nsfwUnlocked} renderPane={(key) => {
        switch (key) {
          case 'appearance': return settings ? <AppearancePane appearance={settings.appearance} onChange={(p) => update({ appearance: p })} terminal={settings.terminal} onTerminalChange={(p) => update({ terminal: p })} /> : null
          case 'notifications': return settings ? <NotificationsPane notifications={settings.notifications} onNotificationsChange={(p) => update({ notifications: p })} closeAction={settings.closeAction} onCloseActionChange={(v) => update({ closeAction: v })} onTest={() => window.forge.notifyTest()} /> : null
          case 'appIcon': return settings ? <AppIconPane appIcon={settings.appIcon} onChange={(p) => update({ appIcon: p })} /> : null
          case 'project': return <ProjectPane projects={projects} onAdd={addProject} onDelete={deleteProject} onEditBranch={updateProjectBranch} />
          case 'providers': return <AgentsPane onChanged={redetect} />
          case 'agents': return <TermProxyPane termProxy={settings?.termProxy ?? ''} onChange={(v) => update({ termProxy: v })} />
          case 'workflow': return <WorkflowPane workflows={workflows} providers={providers} customStages={customStages} onCreate={addWorkflow} onDelete={deleteWorkflow} onUpdateWorkflow={updateWorkflow} onUpdateStagePrompts={updateStagePrompts} onUpdateStages={updateStages} onUpsertCustomStage={upsertCustomStage} />
          case 'customStages': return <CustomStagesPane customStages={customStages} workflows={workflows} providers={providers} onUpsert={upsertCustomStage} onDelete={deleteCustomStage} />
          case 'hookLibrary': return <HookLibraryPane hooks={hookLib.hooks} onSave={hookLib.save} onDelete={hookLib.remove} onSetAll={hookLib.setAll} />
          case 'skills': return <SkillPane />
          case 'loads': return <LoadPane />
          case 'pet': return settings ? <PetPane pet={settings.pet} onChange={(p) => update({ pet: { ...settings.pet, ...p } })} /> : null
          case 'plugins': return <PluginPane plugins={pluginsApi.plugins} results={pluginsApi.results} catalog={pluginsApi.catalog} install={pluginsApi.install} uninstall={pluginsApi.uninstall} setEnabled={pluginsApi.setEnabled} refresh={pluginsApi.refresh} installExample={pluginsApi.installExample} installError={pluginsApi.installError} creds={pluginsApi.creds} setCred={pluginsApi.setCred} />
          case 'nsfw': return settings ? <NsfwPane pet={settings.pet} nsfwInstalled={settings.nsfwInstalled ?? {}} onChangePet={(p) => update({ pet: { ...settings.pet, ...p } })} onChangeAppearance={(p) => update({ appearance: p })} onSetInstalled={(k, ref) => update({ nsfwInstalled: { ...(settings.nsfwInstalled ?? {}), [k]: ref } })} onDisable={() => { update({ nsfwUnlocked: false, nsfwCode: '' }); setSettingsPane('appearance') }} /> : null
          case 'keybindings': return settings ? <KeybindingsPane keybindings={settings.keybindings} onChange={(kb) => update({ keybindings: kb })} globalFailed={globalFailed} /> : null
          case 'sessions': return <SessionImportPane />
          case 'memory': return settings ? <MemoryPane enabled={settings.memory.enabled} onToggle={(v) => update({ memory: { enabled: v } })} wsPath={activeWsId || undefined} sessionId={sessions.activeSessionId ?? undefined} /> : null
          case 'debug': return <DebugLogPane perfStallToast={settings?.perfStallToast ?? false} onTogglePerfToast={(v) => update({ perfStallToast: v })} />
          case 'about': return <AboutPane version={updateCtx.currentVersion} />
          default: return null
        }
      }} />

      <UpgradeModal
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        info={updateCtx.info}
        currentVersion={updateCtx.currentVersion}
        phase={updateCtx.phase}
        progress={updateCtx.progress}
        onStart={updateCtx.start}
      />

      {/* Setup progress overlay: shown during workspace creation when __basic/__proj hooks exist */}
      {setupVisible && (
        <SetupProgress
          state={setupState}
          onClose={() => { setSetupVisible(false); setSetupState(INITIAL_SETUP_STATE) }}
          onCancel={() => { void window.forge.cancelSetup() }}
          // 后台运行: hide the overlay (keep state) so the user can use the app while hooks run. Setup
          // keeps going; a floating pill shows it's alive and setup:done fires a bell notif on finish.
          // ALSO close the create wizard: it stays open during 创建 (only auto-closes on success) with
          // its X/取消/backdrop all disabled while creating — so without this, backgrounding would hide
          // the overlay and reveal the locked, undismissable wizard underneath. Now 后台运行 collapses
          // both to just the pill. handleCreate still navigates on success / re-opens on error.
          onBackground={() => { setBackgrounded(true); setSetupVisible(false); setWizardOpen(false) }}
          // #13: answer a setup hook's confirm/input request → unblock the hook in main, clear the card.
          onResolveInteraction={(id, answer) => { void window.forge.resolveSetupInteraction(id, answer); setSetupState(s => ({ ...s, pendingInteraction: null })) }}
        />
      )}

      {/* Backgrounded-setup pill: setup is still running with the panel hidden. Click to re-open it. */}
      {setupBackgrounded && !setupVisible && (
        <button
          className="setup-bg-pill"
          onClick={() => { setBackgrounded(false); setSetupVisible(true) }}
          title="点击查看建区进度"
        >
          <span className="setup-bg-pill-spin" />
          正在后台配置工作区…
        </button>
      )}
    </div>
  )
}
