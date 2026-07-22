import type { AgentState, LogLine } from '../main/agents/types'
import type { ArtifactRef } from '../main/run/runTypes'
import type { Plugin } from './plugin'

export type { AgentState, LogLine }
export type { Plugin }

export interface AgentRuntime {
  id: string; name: string; role: string; provider: string; model: string
  state: AgentState; logs: LogLine[]
  context?: AgentContextMeta
  // ms epoch of the most recent activity (stdout/MCP/handoff/heartbeat); undefined until first beat
  lastBeat?: number
  // Improvement ⑥: this lane's OWN execution timing (one work order = one project's agent, or the
  // single root agent for a root-scope stage) — ms epoch, from RunController.laneTimings (see its
  // doc in controller.ts). `startedAt` undefined until the lane's work order has actually begun
  // (e.g. a fan-out project card shown before its turn); `endedAt` undefined while still running —
  // AgentNode computes elapsed as `(endedAt ?? now) - startedAt` so a running lane's chip keeps
  // ticking on every re-render instead of freezing at the moment it started.
  laneStartedAt?: number
  laneEndedAt?: number
  // Context-window usage: ctxPct = used/window % (0..100), ctxMax = window size in K. Undefined
  // until the provider parses a usage object from the stream; the agent card omits the bar then.
  ctxPct?: number
  ctxMax?: number
  // Plugin hook fields (Task 5 runHook fills, Task 9 HookNode consumes)
  hook?: boolean
  hookSkills?: string[]
  hookTools?: string[]
}
export interface StageRuntime { key: string; name: string; state: AgentState; agents: AgentRuntime[]; docs?: DesignDocRef[] }

// A technical-design markdown file a design agent wrote, surfaced on the gate card so the user can
// open it in the in-app viewer. `path` is relative to `cwd` (the agent's worktree / workspace root).
export interface DesignDocRef { path: string; cwd: string; name: string }

export type PendingAction =
  // reworkable: 仅阶段评审门控为 true —— 允许「打回重做」(decision:'modify' 带修改方向)。forge_ask 的
  // confirm 卡不设此位,因它走另一条 resolve 通道、不认 'modify',避免误发。
  | { id: string; kind: 'confirm'; agentId: string; agentName: string; wsName: string; title: string; where?: string; provider?: string; model?: string; role?: string; sub?: string; body?: string; docs?: DesignDocRef[]; reworkable?: boolean; ts?: string; note?: string }
  | { id: string; kind: 'input'; agentId: string; agentName: string; wsName: string; title: string; placeholder?: string; provider?: string; model?: string; role?: string; sub?: string; ts?: string; note?: string }
  | { id: string; kind: 'select'; agentId: string; agentName: string; wsName: string; title: string; options: { t: string; d: string }[]; provider?: string; model?: string; role?: string; sub?: string; ts?: string; note?: string }

export interface RunState {
  id: string; workspaceName: string; workspacePath: string; status: AgentState
  // The chat session that OWNS this run (proposed/started it). The renderer shows the run + its gate
  // cards only in this session's tab; other tabs of the same workspace get an unread badge instead of
  // having their content stolen. Undefined for runs started outside a session (e.g. unit tests, legacy).
  sessionId?: string
  workflowId?: string; workflowName?: string   // 本次运行选中的命名工作流;ad-hoc 时缺省
  projects: { name: string; cwd: string }[]
  stages: StageRuntime[]; pending: PendingAction[]
}

export type ChangeType = 'A' | 'M' | 'D'
export interface ChangeItem { path: string; type: ChangeType; add: number; del: number }
export interface DiffLine { kind: 'add' | 'del' | 'ctx'; ln: number; text: string }
export interface FilePreview { text: string; lang: string }
export interface TreeNode { type: 'dir' | 'file'; name: string; path: string; children?: TreeNode[]; chg?: ChangeType; branch?: string }
export interface ChangesEvent { cwd: string; changes: ChangeItem[] }
// Full-text (content) search: one hit per matched line, path relative to the search root.
export interface ContentHit { file: string; line: number; preview: string }
export interface ContentSearchResult { hits: ContentHit[]; truncated: boolean }
// Aggregated changes across multiple project worktrees (one entry per cwd).
export interface MultiChanges {
  total: number; add: number; del: number
  byProject: { cwd: string; changes: ChangeItem[] }[]
}

// Per-workspace home-view enrichment (git branch, change counts by kind, last-activity time).
// Keyed by workspace path. Computed lazily (git status per worktree) so it stays off the cheap
// listWorkspaces path.
export interface HomeWsStat { branch: string; changes: { a: number; e: number; d: number }; updatedAt: number; lastMessageAt: number }
export type HomeStats = Record<string, HomeWsStat>

// A real skill installed under a home agent dir (~/.claude/skills, ~/.codex/skills, …). Read-only —
// Forge lists them; it doesn't enable/disable (agents auto-discover).
export interface InstalledSkill { name: string; description: string; source: string; path: string }

// main -> renderer
export type EngineEvent =
  | { type: 'run:update'; run: RunState }
  // A run was discarded ('终止退出'): the renderer drops its run/pending state entirely so a later
  // workflow starts fresh instead of offering to resume the abandoned one.
  | { type: 'run:cleared'; workspacePath: string }
  | { type: 'agent:log'; agentId: string; line: LogLine }
  | { type: 'agent:state'; agentId: string; state: AgentState }
  | { type: 'agent:stalled'; agentId: string; agentName: string; wsName: string; silentMs: number }
  | { type: 'agent:heartbeat'; agentId: string; at: number }
  | { type: 'pending:add'; action: PendingAction }
  | { type: 'pending:resolve'; id: string }
  | { type: 'pending:annotate'; id: string; note: string }

// renderer -> main
// 'modify' = 阶段评审门控上的「打回重做」:value 带用户填写的修改方向,编排器据此重跑当前阶段。
export interface ResolvePayload { id: string; decision: 'allow' | 'deny' | 'modify'; value?: string; choice?: number }

export interface ModelInfo { id: string; label: string; description?: string; contextWindow?: number }
export interface ProviderInfo { id: string; displayName: string; installed: boolean; models: ModelInfo[]; bin?: string; binPath?: string; custom?: boolean; liveModels?: boolean; version?: string; installCmd?: string; authCmd?: string; installHelp?: string }

export type ReviewLens = 'correctness' | 'security' | 'performance' | 'style'
export interface ReviewConfig {
  mode: 'single' | 'parallel'
  scope?: 'workspace' | 'per-project'
  reviewers?: number | ReviewLens[]
}
// ②多镜头CR: the ordered lens set + their display labels + one-line focus, shared by the renderer
// (StageConfigEditor's lens picker) and main (run2's reviewFanout: lane names + per-lens prompt
// directive). Single source of truth so the two sides never drift on which lenses exist or how
// they're labelled. Mirrors config/schema.ts's REVIEW_LENSES (kept for the orchestrator's own zod
// enum until it's deleted) — both list the same four in the same order.
export const REVIEW_LENSES: ReviewLens[] = ['correctness', 'security', 'performance', 'style']
export const REVIEW_LENS_LABELS: Record<ReviewLens, string> = {
  correctness: '正确性', security: '安全', performance: '性能', style: '规范',
}
export const REVIEW_LENS_FOCUS: Record<ReviewLens, string> = {
  correctness: '逻辑/边界/错误处理是否正确,有没有 bug、竞态、空值、回归',
  security: '注入/越权/敏感信息泄露/不安全依赖/输入校验等安全隐患',
  performance: '算法复杂度、N+1、无谓拷贝/重渲染、内存与 IO 热点',
  style: '命名/结构/可读性/是否遵循本仓既有约定与规范',
}
export interface CreateWorkspaceProject { repoId: string; branch: string; provider?: string; model?: string }
// Custom-stage fields (#3) — mirror WsStageSchema. name/prompt/behavior flags default (per built-in
// key) when absent, so a plain built-in stage needs none of them.
export interface StageCustomFields {
  name?: string
  scope?: 'root' | 'per-project'
  gate?: boolean
  summary?: boolean
  projectAgent?: boolean
  producesDoc?: boolean
}
export interface CreateWorkspaceStage extends StageCustomFields { key: string; provider: string; model: string; review?: ReviewConfig; prompt?: string }
export interface CreateWorkspaceWorkflow { id: string; name: string; stages: CreateWorkspaceStage[] }
export interface CreateWorkspaceOpts {
  name: string
  path: string                       // the workspace folder
  workflows: CreateWorkspaceWorkflow[]  // one or more named workflows, each with its own ordered enabled stages
  projects: CreateWorkspaceProject[]  // selected git projects (repoId + branch + optional per-project develop model)
  plugins?: Plugin[]                  // workspace-level plugins
  stepPlugins?: Plugin[]              // stage-scoped plugins
  runProjHooks?: boolean              // edit-only: re-run __proj hooks against a newly added project
  purpose?: string                    // optional 建区目的 — seeds the workspace memory `## 建区目的` section
}

export interface Attachment { name: string; path: string; size: number }
export interface ChatThink { label: string; elapsed?: number; steps: string[] }
export interface AgentContextRef { name: string; path: string; reason?: string; state?: 'run' | 'ok' | 'wait' | 'err' }
export interface AgentContextMeta { skills: AgentContextRef[]; rules: AgentContextRef[]; mcps?: AgentContextRef[] }
export interface AgentSessionInfo {
  provider: string
  providerLabel: string
  agentName: string
  role?: string
  sessionId: string
  status: 'ok' | 'run' | 'idle'
  lastActiveAt: string
  depth?: number   // 0/undefined = 顶层(主 Agent / 工作流 stage);1 = 委派子代理(面板缩进表达父子层级)
}
// A built-in Task sub-agent the main chat agent spawned this turn, surfaced as a card in the chat
// stream so the user can see it exist / run / finish (the sub-agent runs in a child process, so we
// only get its start + final result from the parent stream — not its live internal steps).
export interface SubagentCard {
  id: string                 // the Task tool_use id (correlates start ↔ result)
  state: 'running' | 'done' | 'error'
  subagentType?: string      // e.g. 'Explore', 'general-purpose'
  description?: string       // short label the model gave the task
  prompt?: string            // the full task prompt handed to the sub-agent
  result?: string            // the sub-agent's returned text (on done)
}

// One background sub-agent in a lightweight-delegation batch, surfaced live in the chat stream so the
// user sees progress without opening the IDs panel. status: 'run' = still working, 'ok' = finished,
// 'idle' = failed / timed-out (mirrors the delegateRegistry states).
export interface DelegateBatchAgent {
  agentId: string
  name: string          // project / workspace-root name the sub-agent runs in
  provider: string
  status: 'run' | 'ok' | 'idle'
  output?: string       // the sub-agent's captured result — streams live while running, final on finish
  activity?: string     // 最近一步动作(读某文件 / 跑某命令 / 最新一句),运行中实时刷新,让用户看得见「执行过程」
}
// A fire-and-forget delegation batch. The main turn ends immediately after dispatch, so this collapsible
// block (below the main agent's reply) is how the user watches the N sub-agents run. Live-only — it is
// NOT persisted to history; the aggregated result arrives afterwards as its own summary message.
export interface DelegateBatch {
  runId: string
  agents: DelegateBatchAgent[]
  done: boolean         // whole batch finished (onComplete fired)
  task: string          // the task delegated to the sub-agents (their 输入; shown when a row is expanded)
  brief?: string        // optional context brief the main agent prepared, prepended to each sub-agent's prompt
}

export interface ChatMessage {
  id: string
  who: 'user' | 'ai'
  text: string
  model?: string
  // Agent id (claude/codex/cursor/...) that produced this ai message. Used to detect provider
  // switches (timeline divider) and to attribute per-provider watermark progress.
  provider?: string
  think?: ChatThink
  // Built-in Task sub-agents this assistant turn spawned (persisted so cards survive reload).
  subagents?: SubagentCard[]
  context?: AgentContextMeta
  files?: Attachment[]
  ts: string
  // Aggregated worktree change totals across all run projects (set on the done narration).
  changes?: { total: number; add: number; del: number }
  // Chat-session context-window usage at the time this assistant message finished: used =
  // total context tokens consumed, window = model's context window. Set on the done message.
  usage?: { used: number; window: number }
  // Design docs a stage produced, carried onto the persisted stage-note message so they stay
  // openable in the timeline AFTER the (ephemeral) design-gate card is resolved and unmounts.
  docs?: DesignDocRef[]
  // A lightweight-delegation batch this (transient) message represents: a live, collapsible progress
  // block listing the background sub-agents. Present only on the delegate batch message.
  delegate?: DelegateBatch
  // P1-5: a confirmed launch-gate's frozen record, persisted onto a synthetic system ChatMessage (id ==
  // the in-chat LaunchGateCard's id, text left blank) so it survives reload/session-switch — same
  // append-only jsonl mechanism as `subagents`/`docs`, just a different field. buildTimeline (chat/
  // timeline.ts) skips this message's plain-text rendering; WorkspaceView reconstructs the frozen
  // LaunchGateCard from this field instead of relying on component-local-only state.
  launchGate?: { workflowName: string; projects: string[]; supplement: string; decidedAt: number; seed: string }
  // P3-4: a resolved run2 inbox event's (gate/auth/question/doubt/failure) frozen decision, persisted
  // onto a synthetic system ChatMessage — same append-only pattern as `launchGate` just above (id ==
  // the in-chat RunEventCard's event id, text left blank). buildTimeline (chat/timeline.ts) skips this
  // message's plain-text rendering; WorkspaceView reconstructs the frozen RunEventCard from this field
  // (mirrors chat/runCards.ts's FrozenRunCard shape — kept structurally inline here rather than imported,
  // same reasoning as every other shared/types.ts field: this module stays the renderer/main boundary).
  // 'aborted' (P4-3): a synthetic marker persisted when a run is ended via RunExecPanel's 终止
  // button, not a real run2 RunEvent kind — see FrozenRunCard's doc (chat/runCards.ts) for why.
  // 'summary' (①汇总): a synthetic marker persisted when a run reaches terminal 'ok', carrying the
  // run's "本次运行总结" in `body` — likewise not a real run2 RunEvent kind (see FrozenRunCard's doc).
  // `docs` (improvement ①): mirrors FrozenRunCard.docs (chat/runCards.ts) — a gate's artifact refs
  // (e.g. design.md), preserved so a resolved gate card can still open the full doc after reload.
  runCard?: { id: string; kind: 'auth' | 'question' | 'doubt' | 'failure' | 'gate' | 'aborted' | 'summary'; stageKey: string; title: string; body?: string; decision: string; at: number; ts: number; finalize?: boolean; docs?: ArtifactRef[] }
}
export interface ChatSession {
  id: string
  title: string
  mode: 'chat' | 'workflow'
  createdAt: number
  runId?: string
  summary?: string
  readonly?: true
  external?: { source: SourceId; externalId: string; filePaths: string[] }
  continuedFrom?: { source: SourceId; externalId: string }
  // Per-session agent permission (sandbox) scope, remembered across switches. Absent = default 'auto'.
  permissionMode?: import('./permissions').PermissionMode
  // The coding agent + model this session last used. Remembered PER SESSION so each session keeps its
  // own choice (and switching sessions restores it) instead of one workspace-wide selection leaking.
  agentId?: string
  modelId?: string
}
export interface SessionsFile { sessions: ChatSession[]; activeSessionId: string; dismissedImported?: string[] }
export interface ChatConfirm { id: string; title: string; where?: string; ts?: string }
export interface ChatSendPayload {
  workspacePath: string
  sessionId: string
  agent: string        // provider id, e.g. 'claude'
  agentLabel: string   // provider displayName, e.g. 'Claude Code' (used only for the stored model label)
  model: string
  text: string
  attachments: Attachment[]
  source?: string      // who sent it, default '你'
  permissionMode?: import('./permissions').PermissionMode   // agent sandbox scope (readonly/auto/full)
}
export interface ChatQueueEvent { workspacePath: string; busy: boolean; queue: { id: string; text: string; source: string; sessionId: string }[]; running: { id: string; text: string; sessionId: string } | null; runningTurns: { id: string; text: string; sessionId: string }[]; runningSessionId: string | null; runningSessionIds: string[] }
export type ChatEvent = { workspacePath: string; sessionId: string } & (
  | { type: 'user'; message: ChatMessage }
  | { type: 'assistant-start'; id: string; model: string; context?: AgentContextMeta }
  | { type: 'assistant-delta'; id: string; text: string }
  | { type: 'think-delta'; id: string; text: string; context?: AgentContextMeta }
  | { type: 'confirm-request'; id: string; title: string; where?: string }
  | { type: 'confirm-resolved'; id: string }
  // A delegate sub-agent's forge_ask, surfaced as a select (options) / input (no options) card.
  | { type: 'ask-request'; id: string; title: string; options?: { t: string; d: string }[]; agentName?: string }
  | { type: 'ask-resolved'; id: string }
  | { type: 'done'; message: ChatMessage }
  | { type: 'subagent'; id: string; sub: SubagentCard }
  | { type: 'plan-request'; id: string; approach: string; stages: { key: string; name: string; agents: number; perProject: boolean; projects: string[] }[]; hooks: { id: string; name: string; after: string }[]; allProjects: string[]; task?: string; workflowId?: string; workflowName?: string; workflowOptions?: { id: string; name: string }[]; recommendReason?: string }
  | { type: 'plan-resolved'; id: string }
  | { type: 'mode-changed'; mode: 'chat' | 'workflow'; runId?: string }
  // Fire-and-forget delegate batches keep running after the chat turn ends. This signals whether any
  // background delegate sub-agent is still in flight for this session, so the composer can show the
  // running/stop state (stopping cancels them) instead of looking idle while work continues.
  | { type: 'delegate-busy'; active: boolean }
  // Live delegate-batch progress surfaced in the chat stream (below the main reply). `delegate-start`
  // creates the collapsible block (all sub-agents 'run'); `delegate-progress` flips one sub-agent's
  // status; `delegate-done` marks the whole batch finished. Live-only (the block is not persisted).
  | { type: 'delegate-start'; id: string; batch: DelegateBatch }
  | { type: 'delegate-progress'; id: string; agentId: string; status: DelegateBatchAgent['status']; output?: string; activity?: string }
  | { type: 'delegate-done'; id: string }
  | { type: 'error'; id: string; error: string }
)

export type { Settings, Appearance, Pet, PetState, Anim, Accent, PetStateConfig, AgentsConfig, CustomAgent, CustomPetCfg, Terminal, CloseAction, AppIcon, DockIcon, Notifications, Keybindings } from '../main/config/schema'
export type { AppLogEntry, LogLevel } from '../main/log/appLog'
export type { DetectedRepo } from '../main/workspace/scanRepos'

export interface SessionImportCoverage {
  supported: { id: string; label: string }[]
  unsupported: { id: string; label: string; reason: string }[]
}

// Setup hook events streamed from main during workspace creation (when __basic/__proj stepPlugins exist).
// Defined here so both main (workspaceSetup.ts) and renderer (SetupProgress.tsx) share one canonical type.
export type SetupEvent =
  | { type: 'setup:start'; workspacePath: string; hooks: { basic: number; proj: number } }
  | { type: 'hook:start'; phase: '__basic' | '__proj'; plugin: { id: string; name: string; skills: string[]; tools: string[] } }
  | { type: 'hook:log'; pluginId: string; line: LogLine }
  // A setup hook (__basic/__proj) is asking the user to confirm a permission or supply input. The UI
  // renders an interaction card in SetupProgress and posts the answer back via workspace:setup-resolve,
  // which resolves the hook's blocked onConfirm/onInput (see setupInteractions.ts). Without this the
  // request was silently denied and the user saw no prompt at all.
  | { type: 'hook:interact'; id: string; pluginId: string; kind: 'confirm' | 'input'; title: string; where?: string; placeholder?: string }
  | { type: 'hook:state'; pluginId: string; state: 'ok' | 'err' }
  | { type: 'provision'; project: string; index: number; total: number }
  | { type: 'provision:start'; project: string; index: number; total: number }
  | { type: 'provision:error'; project: string; index: number; total: number; message: string }
  | { type: 'setup:done'; workspacePath: string }

export interface WorkspaceMeta { name: string; path: string; projectCount: number; workflowId: string; status: 'idle' | 'run' | 'ok' | 'err'; pinned: boolean; imported?: boolean; archived: boolean; archivedAt: number | null; createdAt: number; description: string }

// Full persisted workspace config (mirrors src/main/config/schema.ts WorkspaceSchema). Renderer-facing
// contract for editing (SP-B); the main schema's zod-inferred type is structurally assignable to this.
export interface WsStage extends StageCustomFields { key: string; provider: string; model: string; review?: ReviewConfig; prompt?: string }
export interface WsWorkflow { id: string; name: string; stages: WsStage[] }
export interface WsProject { repoId: string; name: string; branch: string; provider: string; model: string }
export interface Workspace {
  name: string
  path: string
  workflowId: string          // legacy 迁移种子
  stages: WsStage[]           // legacy 迁移种子
  workflows: WsWorkflow[]     // 一组命名工作流
  projects: WsProject[]
  status: 'idle' | 'run' | 'ok' | 'err'
  plugins: Plugin[]
  stepPlugins: Plugin[]
  purpose?: string            // 建区目的(可选) — seeds the workspace memory `## 建区目的` section
}

export interface UpdateInfo { version: string; notes: string; dmgUrl: string; dmgSize: number; dmgName: string }
export interface InstallProgress { stage: string; pct: number; log?: string }
export type UpdateEvent =
  | { type: 'available'; info: UpdateInfo }
  | { type: 'none' }
  | { type: 'checkfailed'; message: string }
  | { type: 'progress'; stage: string; pct: number; log?: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type SourceId = 'claude' | 'codex' | 'cursor' | 'qoder'
export interface GitRepoCandidate { cwd: string; repoUrl: string | null; branch: string }
export interface DiscoveredSession {
  source: SourceId
  externalId: string
  cwd: string
  title: string
  startedAt: number   // epoch ms
  lastTs: number      // epoch ms
  messageCount: number
  filePaths: string[]
  hasBody: boolean
}
export interface ImportedMessage { who: 'user' | 'ai'; text: string; ts: string }
export interface SessionGroup {
  cwd: string
  wsPath: string
  matched: boolean          // cwd 命中已有 workspace
  sessions: DiscoveredSession[]
}
export interface ScanResult { scannedAt: number; groups: SessionGroup[] }
export interface ScanCache { version: 1; scannedAt: number; groups: SessionGroup[] }
export interface ImportedIndex { version: 1; scannedAt: number; sessions: DiscoveredSession[] }
export interface ImportResult { index: ImportedIndex; gitRepos: GitRepoCandidate[] }
