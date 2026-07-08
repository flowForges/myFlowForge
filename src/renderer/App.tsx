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
import { fmtRelTime } from '@shared/relTime'
import { WorkspaceView } from './views/WorkspaceView'
import { HomeView } from './views/HomeView'
import { useHome } from './state/useHome'
import { CreateWorkspace } from './views/CreateWorkspace'
import { SettingsModal } from './settings/SettingsModal'
import { ProjectPane } from './settings/ProjectPane'
import { AppearancePane } from './settings/AppearancePane'
import { AppIconPane } from './settings/AppIconPane'
import { TermProxyPane } from './settings/TermProxyPane'
import { AgentsPane } from './settings/AgentsPane'
import { WorkflowPane } from './settings/WorkflowPane'
import { HookLibraryPane } from './settings/HookLibraryPane'
import { SkillPane } from './settings/SkillPane'
import { PetPane } from './settings/PetPane'
import { LoadPane } from './settings/LoadPane'
import { PluginPane } from './settings/PluginPane'
import { SessionImportPane } from './settings/SessionImportPane'
import { DebugLogPane } from './settings/DebugLogPane'
import { KeybindingsPane } from './settings/KeybindingsPane'
import { useKeybindings } from './state/useKeybindings'
import { UpgradeModal } from './shell/UpgradeModal'
import { DeleteConfirm } from './shell/DeleteConfirm'
import { ActionConfirm } from './shell/ActionConfirm'
import { markAllRead, notifFromLifecycle, sanitize, type Notif } from './shell/notifications'
import { SetupProgress, INITIAL_SETUP_STATE, applySetupEvent } from './views/SetupProgress'
import type { SetupProgressState } from './views/SetupProgress'
import type { AgentState, ChatQueueEvent, CreateWorkspaceOpts, EngineEvent, SetupEvent, Workspace } from '@shared/types'

// Minimal renderer-facing shape of the orchestrator's StartRunOpts. The canonical type lives in
// main (src/main/orchestrator/orchestrator.ts), which the renderer must not import at runtime;
// the renderer only ever receives an opaque StartRunOpts from window.forge.createWorkspace, spreads
// it back into window.forge.startRun, and (now) attaches the seeding task. We keep the fields the
// renderer actually touches typed, plus an index signature so the opaque payload round-trips intact.
export interface StartRunOpts { workspacePath: string; task?: string; [k: string]: unknown }

export function App() {
  const [collapsed, setCollapsed] = useState(false)
  const [inspCollapsed, setInspCollapsed] = useState(false)
  // 启动默认落在首页(HomeView):新用户没有工作区时不再看到一个空的 WorkspaceView。
  const [view, setView] = useState<'home' | 'ws'>('home')
  // 「打开位置」目标:WorkspaceView 上报当前工作区/预览文件,供顶栏按钮消费。
  const [openTarget, setOpenTarget] = useState<OpenTarget | null>(null)
  const [activeId, setActiveId] = useState('')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsPane, setSettingsPane] = useState('appearance')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  // Archive / remove-from-list ask for confirmation before firing (they used to run on a single click).
  const [pendingConfirm, setPendingConfirm] = useState<{ kind: 'archive' | 'remove'; id: string } | null>(null)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // Created workspaces don't auto-run. We stash their StartRunOpts keyed by ws path; the user's
  // first chat message in that workspace starts the run (seeded with the message as the task).
  const [pendingStart, setPendingStart] = useState<Record<string, StartRunOpts>>({})
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
  const sidebar = useResizable('sidebarW', 248, 180, 440, 'right')
  const inspector = useResizable('inspectorW', 380, 280, 720, 'left')
  const engine = useEngine()
  // Workspaces with a chat turn in flight (per-workspace chat-queue busy flag). Used to light the sidebar
  // status dot for chat activity — w.status only reflects orchestrator runs, not a running chat agent.
  const [busyWs, setBusyWs] = useState<Set<string>>(new Set())
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
      setRecentActivity(prev => { const n = new Map(prev); n.set(e.workspacePath, Date.now()); return n })
    })
    return () => { off() }
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
  const { projects, workflows, providers, addProject, deleteProject, updateProjectBranch, addWorkflow, deleteWorkflow, updateWorkflow, updateStagePrompts, redetect } = useConfig()
  const hookLib = useHookLibrary()
  const { settings, update } = useSettings()
  const sidebarGroups = useMemo(() => {
    const now = nowTick
    const items = home.workspaces.map(w => ({
      id: w.path, name: w.name,
      sub: w.archived
        ? (w.description || '已归档 · 只读')
        : (w.imported ? '本机导入' : `${w.projectCount} 个项目 · ${w.workflowId}`),
      status: w.status as AgentState,
      imported: w.imported,
      // Light the dot when an agent is actually executing here: a chat turn in flight OR the live
      // orchestrator run. Kept separate from `status` (which drives the persisted 运行中 pill).
      live: busyWs.has(w.path) || (engine.run?.status === 'run' && engine.run.workspacePath === w.path),
      pinned: w.pinned,
      lastActivity: fmtRelTime(Math.max(home.stats[w.path]?.lastMessageAt ?? 0, recentActivity.get(w.path) ?? 0), now),
      archived: w.archived,
      archivedAt: w.archivedAt,
      createdAt: w.createdAt,
    }))
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
  }, [home.workspaces, home.stats, busyWs, engine.run, recentActivity, nowTick])
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
      }
      setSetupState(prev => applySetupEvent(prev, e))
      if (e.type === 'setup:done') {
        // Panel stays visible with done state until createWorkspace resolves and we navigate away.
        // App.tsx handleCreate will flip setupVisible off once the promise resolves.
      }
    })
    return () => { off() }
  }, [])

  useEffect(() => {
    const off = window.forge.onEngineEvent((e: EngineEvent) => {
      if (e.type === 'agent:stalled') {
        setNotifs(ns => [notifFromLifecycle({ kind: 'stalled', agentName: e.agentName, wsName: e.wsName, silentMs: e.silentMs }), ...ns])
        return
      }

      if (e.type === 'pending:add') {
        setNotifs(ns => [notifFromLifecycle({ kind: 'awaiting', agentName: e.action.agentName, wsName: e.action.wsName }), ...ns])
        return
      }

      if (e.type !== 'run:update') return
      const run = e.run
      // Whole-workflow completion → one aggregate notif (replaces the old per-agent "已完成" spam).
      // Seed on first sighting so a run already finished when observed on mount/reload can't fire a
      // stale toast — we only notify on a witnessed non-ok → ok transition.
      const runSeen = notifRunPrev.current.has(run.id)
      const runPrev = notifRunPrev.current.get(run.id)
      notifRunPrev.current.set(run.id, run.status)
      if (runSeen && runPrev !== 'ok' && run.status === 'ok') {
        setNotifs(ns => [notifFromLifecycle({ kind: 'run-done', agentName: run.workspaceName, wsName: run.workspaceName, wsPath: run.workspacePath }), ...ns])
      }
      // Per-agent: surface failures only (完成 is covered by the aggregate above). Same seed guard.
      for (const stage of run.stages) {
        for (const agent of stage.agents) {
          const seen = notifAgentPrev.current.has(agent.id)
          const was = notifAgentPrev.current.get(agent.id)
          notifAgentPrev.current.set(agent.id, agent.state)
          if (seen && was !== agent.state && agent.state === 'err') {
            setNotifs(ns => [
              notifFromLifecycle({ kind: 'failed', agentName: agent.name, wsName: run.workspaceName, wsPath: run.workspacePath }),
              ...ns,
            ])
          }
        }
      }
    })
    return () => { off() }
  }, [])

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

  // Start the stashed run for a workspace, seeding it with the user's first chat message as the task,
  // then drop the stash so subsequent composer sends fall through to normal chat.
  const startRunForWs = (opts: StartRunOpts, task: string) => {
    void window.forge.startRun({ ...opts, task })
    setPendingStart(s => { const n = { ...s }; delete n[opts.workspacePath]; return n })
  }

  async function handleEdit(opts: CreateWorkspaceOpts) {
    if (creating || !editing) return
    setCreating(true)
    try {
      await window.forge.editWorkspace({ path: editing.path, opts })
      setCreateErr(null); setWizardOpen(false); setEditing(null)
      home.reload()
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  async function handleCreate(opts: CreateWorkspaceOpts) {
    if (creating) return                         // guard against double-submit
    setCreating(true)                            // disable the create button + show 创建中… (git worktree/fetch is slow)
    try {
      const { startRunOpts } = await window.forge.createWorkspace(opts)
      // main expands `~` once and stores/registers/runs under the absolute path, so the renderer
      // MUST key everything off that canonical path — not the raw `opts.path` (which may be `~/…`).
      // Using the raw path would mismatch the registry/run/chat keys: the stash would never clear
      // and runLive would never become true, re-firing startRun on every message (duplicate runs).
      const wsPath = (startRunOpts as StartRunOpts).workspacePath
      setCreateErr(null)
      setWizardOpen(false)                       // close only on success
      setSetupVisible(false)                     // dismiss setup progress panel
      setSetupState(INITIAL_SETUP_STATE)         // reset for next creation
      setActiveId(wsPath)                        // highlight the new workspace in the sidebar
      setView('ws')                              // switch to the workspace view
      home.reload()                              // newly-created workspace shows on next home visit
      // Stash the run opts instead of auto-running; the first chat message will start the run.
      setPendingStart(s => ({ ...s, [wsPath]: startRunOpts as StartRunOpts }))
    } catch (e) {
      setSetupVisible(false)                     // also dismiss on error
      setSetupState(INITIAL_SETUP_STATE)
      setCreateErr(e instanceof Error ? e.message : String(e))  // keep wizard open, surface the error
    } finally {
      setCreating(false)
    }
  }

  // 空态快速上手:选一个本地文件夹,建一个「纯文件夹工作区」(无项目、无阶段)直接进入对话。与 handleCreate
  // 的关键区别是 **不** stash pendingStart —— 没有工作流,第一条消息应当是普通对话而非触发运行。
  async function handleQuickFolder() {
    if (creating) return
    let dir: string | null = null
    try { dir = await window.forge.pickDirectory() } catch { dir = null }
    if (!dir) return
    setCreating(true)
    try {
      const name = dir.split('/').filter(Boolean).pop() || '工作区'
      const { startRunOpts } = await window.forge.createWorkspace({
        name, path: dir, workflowId: workflows[0]?.id ?? 'standard', stages: [], projects: [],
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
    'toggle-settings': () => { if (settingsOpen) setSettingsOpen(false); else { setSettingsPane('appearance'); setSettingsOpen(true) } },
    'open-plugins': () => { setSettingsPane('plugins'); setSettingsOpen(true) },
  }
  useKeybindings(settings?.keybindings?.overrides ?? {}, kbHandlers)

  return (
    <div className={`window${collapsed ? ' collapsed' : ''}${inspCollapsed ? ' insp-collapsed' : ''}${view === 'home' ? ' home-mode' : ''}`}>
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
          onNewSession={sessions.newSession}
          expandedIds={new Set(expandedPaths)}
          sessionsByWs={sessionsMap}
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
                pendingStartOpts={activeWsId ? pendingStart[activeWsId] : undefined}
                onStartRun={startRunForWs}
                inspectorWidth={inspector.width}
                onInspectorHandleDown={inspector.onHandleDown}
                inspectorCollapsed={inspCollapsed}
                sessionsApi={sessions}
                onEditWorkspace={openEdit}
                archived={!!activeWsMeta?.archived}
                createdAt={activeWsMeta?.createdAt ?? 0}
                archivedAt={activeWsMeta?.archivedAt ?? null}
                onViewAgentLog={(id, name) => { setAgentLogFilter({ id, name }); setLogOpen(true); dock.setFocus('log') }}
                onOpenTargetChange={setOpenTarget}
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
        branch={engine.run?.workspaceName ?? '—'}
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
        providers={providers}
        onOpenProjectSettings={() => { setWizardOpen(false); setSettingsPane('project'); setSettingsOpen(true) }}
        onNewWorkflow={() => { setWizardOpen(false); setSettingsPane('workflow'); setSettingsOpen(true) }}
        onAddProject={addProject}
        onAddWorkflow={addWorkflow}
        onPickPath={() => window.forge.pickDirectory()}
        hookLibrary={hookLib.hooks}
        onSaveHookToLibrary={hookLib.save}
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

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} initialPane={settingsPane} renderPane={(key) => {
        switch (key) {
          case 'appearance': return settings ? <AppearancePane appearance={settings.appearance} onChange={(p) => update({ appearance: p })} notifications={settings.notifications} onNotificationsChange={(p) => update({ notifications: p })} terminal={settings.terminal} onTerminalChange={(p) => update({ terminal: p })} closeAction={settings.closeAction} onCloseActionChange={(v) => update({ closeAction: v })} /> : null
          case 'appIcon': return settings ? <AppIconPane appIcon={settings.appIcon} onChange={(p) => update({ appIcon: p })} /> : null
          case 'project': return <ProjectPane projects={projects} onAdd={addProject} onDelete={deleteProject} onEditBranch={updateProjectBranch} />
          case 'providers': return <AgentsPane onChanged={redetect} />
          case 'agents': return <TermProxyPane termProxy={settings?.termProxy ?? ''} onChange={(v) => update({ termProxy: v })} />
          case 'workflow': return <WorkflowPane workflows={workflows} onCreate={addWorkflow} onDelete={deleteWorkflow} onUpdateWorkflow={updateWorkflow} onUpdateStagePrompts={updateStagePrompts} />
          case 'hookLibrary': return <HookLibraryPane hooks={hookLib.hooks} onSave={hookLib.save} onDelete={hookLib.remove} onSetAll={hookLib.setAll} />
          case 'skills': return <SkillPane />
          case 'loads': return <LoadPane />
          case 'pet': return settings ? <PetPane pet={settings.pet} onChange={(p) => update({ pet: { ...settings.pet, ...p } })} /> : null
          case 'plugins': return <PluginPane plugins={pluginsApi.plugins} results={pluginsApi.results} catalog={pluginsApi.catalog} install={pluginsApi.install} uninstall={pluginsApi.uninstall} setEnabled={pluginsApi.setEnabled} refresh={pluginsApi.refresh} installExample={pluginsApi.installExample} installError={pluginsApi.installError} creds={pluginsApi.creds} setCred={pluginsApi.setCred} />
          case 'keybindings': return settings ? <KeybindingsPane keybindings={settings.keybindings} onChange={(kb) => update({ keybindings: kb })} globalFailed={globalFailed} /> : null
          case 'sessions': return <SessionImportPane />
          case 'debug': return <DebugLogPane perfStallToast={settings?.perfStallToast ?? false} onTogglePerfToast={(v) => update({ perfStallToast: v })} />
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
        />
      )}
    </div>
  )
}
