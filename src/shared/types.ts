import type { AgentState, LogLine } from '../main/agents/types'
import type { Plugin } from './plugin'

export type { AgentState, LogLine }
export type { Plugin }

export interface AgentRuntime {
  id: string; name: string; role: string; provider: string; model: string
  state: AgentState; logs: LogLine[]
  context?: AgentContextMeta
  // ms epoch of the most recent activity (stdout/MCP/handoff/heartbeat); undefined until first beat
  lastBeat?: number
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
export interface CreateWorkspaceProject { repoId: string; branch: string; provider?: string; model?: string }
export interface CreateWorkspaceStage { key: string; provider: string; model: string; review?: ReviewConfig; prompt?: string }
export interface CreateWorkspaceOpts {
  name: string
  path: string                       // the workspace folder
  workflowId: string
  stages: CreateWorkspaceStage[]      // ordered enabled stages with chosen provider+model
  projects: CreateWorkspaceProject[]  // selected git projects (repoId + branch + optional per-project develop model)
  plugins?: Plugin[]                  // workspace-level plugins
  stepPlugins?: Plugin[]              // stage-scoped plugins
  runProjHooks?: boolean              // edit-only: re-run __proj hooks against a newly added project
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

export interface ChatMessage {
  id: string
  who: 'user' | 'ai'
  text: string
  model?: string
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
export interface ChatQueueEvent { workspacePath: string; busy: boolean; queue: { id: string; text: string; source: string }[]; running: { id: string; text: string } | null }
export type ChatEvent = { workspacePath: string; sessionId: string } & (
  | { type: 'user'; message: ChatMessage }
  | { type: 'assistant-start'; id: string; model: string; context?: AgentContextMeta }
  | { type: 'assistant-delta'; id: string; text: string }
  | { type: 'think-delta'; id: string; text: string; context?: AgentContextMeta }
  | { type: 'confirm-request'; id: string; title: string; where?: string }
  | { type: 'confirm-resolved'; id: string }
  | { type: 'done'; message: ChatMessage }
  | { type: 'subagent'; id: string; sub: SubagentCard }
  | { type: 'plan-request'; id: string; approach: string; stages: { name: string; agents: number }[]; task?: string }
  | { type: 'plan-resolved'; id: string }
  | { type: 'mode-changed'; mode: 'chat' | 'workflow'; runId?: string }
  | { type: 'error'; id: string; error: string }
)

export type { Settings, Appearance, Pet, PetState, Anim, Accent, PetStateConfig, AgentsConfig, CustomAgent, CustomPetCfg, Terminal, CloseAction, AppIcon, DockIcon, Notifications, Keybindings } from '../main/config/schema'
export type { AppLogEntry, LogLevel } from '../main/log/appLog'

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
  | { type: 'hook:state'; pluginId: string; state: 'ok' | 'err' }
  | { type: 'provision'; project: string; index: number; total: number }
  | { type: 'provision:start'; project: string; index: number; total: number }
  | { type: 'provision:error'; project: string; index: number; total: number; message: string }
  | { type: 'setup:done'; workspacePath: string }

export interface WorkspaceMeta { name: string; path: string; projectCount: number; workflowId: string; status: 'idle' | 'run' | 'ok' | 'err'; pinned: boolean; imported?: boolean; archived: boolean; archivedAt: number | null; createdAt: number; description: string }

// Full persisted workspace config (mirrors src/main/config/schema.ts WorkspaceSchema). Renderer-facing
// contract for editing (SP-B); the main schema's zod-inferred type is structurally assignable to this.
export interface WsStage { key: string; provider: string; model: string; review?: ReviewConfig; prompt?: string }
export interface WsProject { repoId: string; name: string; branch: string; provider: string; model: string }
export interface Workspace {
  name: string
  path: string
  workflowId: string
  stages: WsStage[]
  projects: WsProject[]
  status: 'idle' | 'run' | 'ok' | 'err'
  plugins: Plugin[]
  stepPlugins: Plugin[]
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
