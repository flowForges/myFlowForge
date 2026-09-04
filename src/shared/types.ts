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
/**
 * `auth`:这台机器上这个 provider **登录了没有**(第三期:远程/无头场景)。
 *
 * ★★三态。`'unknown'` 不是「大概没登录」,是**我们没有判断依据** —— 界面上必须什么都不说。
 *  只查 bin 在不在的年代,流程是「建会话 → 发消息 → 等半天 → 才发现没登录」;
 *  而把「不知道」画成「没登录」会让人去重登一个本来好好的 provider,同样是浪费时间。
 *  判据见 `src/main/agents/credProbe.ts`(每一条都在真机上跑过)。
 */
export type ProviderAuth = 'ok' | 'missing' | 'unknown'
export interface ProviderInfo { id: string; displayName: string; installed: boolean; models: ModelInfo[]; bin?: string; binPath?: string; custom?: boolean; liveModels?: boolean; version?: string; installCmd?: string; installAltCmd?: string; authCmd?: string; installHelp?: string; timezone?: string; auth?: ProviderAuth }

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
// `inPlace`: the repo is an already-detected on-disk repo (Task 3's DetectedRepo) whose worktree dir
// already exists at `<wsPath>/<repoId>` — repoId is set to the repo's path RELATIVE to the workspace
// folder (e.g. `api`, or `packages/lib` for a nested repo) so the derived cwd is correct either way.
// runWorkspaceSetup skips clone/branch provisioning for it entirely; it is registered workspace-local,
// never written to the global projects.json.
export interface CreateWorkspaceProject { repoId: string; branch: string; provider?: string; model?: string; inPlace?: boolean }
// Custom-stage fields (#3) — mirror WsStageSchema. name/prompt/behavior flags default (per built-in
// key) when absent, so a plain built-in stage needs none of them.
export interface StageCustomFields {
  name?: string
  scope?: 'root' | 'per-project'
  gate?: boolean
  summary?: boolean
  projectAgent?: boolean
  producesDoc?: boolean
  // 阶段级项目代理:本阶段为某个项目单独指定的编码代理(「按项目 CR」用与「代码开发」不同的 provider)。
  // 不填 = 该项目跟自己的编码代理走(旧行为)。
  projectAgents?: { name: string; provider: string; model: string }[]
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
  // The sub-agent's OWN tool calls as it runs (Read/Bash/Grep…), attributed via the stream's
  // parent_tool_use_id. Lets the card show WHAT each sub-agent is doing live, not just running/done —
  // so multiple探查 sub-agents don't look like a frozen cursor. Titles only (claude streams subagent
  // tool_use by default; text/thinking需 --forward-subagent-text which we don't enable).
  steps?: string[]
}

// One of the MAIN agent's OWN tool calls this turn (Read/Bash/Edit/…), surfaced live so the user sees
// what the current CLI is actually executing — the title while it runs, the raw output (collapsible) on
// completion — instead of a silent spinner. Correlated start↔result by `id` (the tool_use id, where the
// provider exposes one). Not every provider streams tool structure: claude gives title+output; codex/
// qoder/cursor give at least titles; gemini/qwen/copilot expose nothing (plain-text run only).
export interface ToolActivity {
  id: string
  title: string              // human label, e.g. "调用 Read package.json" / "调用 Bash: npm test"
  name?: string              // raw tool name (Read/Bash/Edit/…) when known
  output?: string            // the tool's result/stdout (on done), where the provider streams it
  /**
   * `output` 被服务端截断过时,这里是**原始**行数(见 `main/chat/toolOutputCap.ts`)。
   *
   * ★没有它的话,截断之后界面会理直气壮地说「共 200 行」,而真相可能是五千行 ——
   *  静默截断是这套渲染最不能犯的错。有它,工具卡那句「还有 N 行没显示」数字仍然是真的。
   * ★只在**真的截过**时出现:没截断的消息一个字节都不多带。
   */
  outputLines?: number
  status: 'run' | 'ok' | 'error'
  /**
   * 这次调用是被「完全访问」档**自动放行**的(没有弹门问人)。
   *
   * ★★为什么挂在工具卡上而不是往对话里发一条消息:原来是 `emitNote` 发一条 `who:'ai'` 的
   *  ChatMessage,于是它顶着「系统」头像和「回答」标签,长得**和模型的回答一模一样**,还夹在
   *  工具卡和真正的回答中间。用户原话:「bash 的结果应该在 bash 的那个折叠里,不应该出现在
   *  LLM 输出的内容界面啊」。对的 —— 它是那次工具调用的属性,不是一句回答。
   * ★能精确对上是因为两边是**同一个 id**:权限门收到的 `can_use_tool` 带 `tool_use_id`
   *  (`claudeControl.ts`),而工具卡的 id 就是那个 `tool_use` 块的 id(`chatStream.ts`)。
   *  不是靠命令文本猜的。
   */
  autoAllowed?: boolean
  /**
   * 这条的 `output` **没跟着历史一起下发**,要点开时单独去取(`chat:tool-output`)。
   *
   * ★★2026-09-04 实测的浪费:手机上工具卡**默认是折叠的**,而一条消息里能有 **54 次**工具调用。
   *  也就是说整份输出下载下来**只为了立刻藏起来**。截断(上一轮)之后最大的会话仍有 389KB,
   *  其中 324KB 是工具输出 —— 因为二十几次调用每次都顶到 16KB 的上限。
   *  改成按需取之后同一个会话 **85KB**,而且**不再随工具调用次数增长**。
   * ★`outputLines` 仍然是**原始行数**,所以卡片上「共 N 行」照旧说真话,不会因为没下载就变成 0。
   * ★小输出不走这条路(默认 1KB 以内照旧内联):实测那样最大会话一样是 85KB,
   *  但三分之一的工具点开就有、不用等一次往返。
   */
  outputOmitted?: boolean
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
  /**
   * 这条**用户消息**是从哪台设备发过来的(`iPhone` / `Android 手机` / 另一台电脑的机器名)。
   *
   * ★★**只在不是本机窗口发的时候才有**。本机发的一律不带这个字段 —— 于是「没有标记 = 就在
   *  这台机器上敲的」,常见情况下一个字节、一个像素都不多。
   * ★★★**纯展示,绝不进上下文**。它是 `ChatMessage` 上一个独立字段,而喂给 agent 的地方
   *  (`contextRebuild.ts` 的 `${who}：${m.text}`、`estimateContextTokens(m.text)`)读的
   *  **只有 `text`** —— 所以它进不了提示词,不是靠谁记得去删。复制按钮复制的也是 `text`。
   *  这条约束有测试钉着(见 `chatVia.test.ts`),别改成拼进 text 里。
   */
  via?: string
  model?: string
  // Agent id (claude/codex/cursor/...) that produced this ai message. Used to detect provider
  // switches (timeline divider) and to attribute per-provider watermark progress.
  provider?: string
  think?: ChatThink
  // Built-in Task sub-agents this assistant turn spawned (persisted so cards survive reload).
  subagents?: SubagentCard[]
  // The main agent's OWN tool calls this turn (Read/Bash/Edit/…) — the "执行" block. Persisted so the
  // execution trace survives reload. See ToolActivity.
  tools?: ToolActivity[]
  context?: AgentContextMeta
  files?: Attachment[]
  ts: string
  // Aggregated worktree change totals across all run projects (set on the done narration).
  changes?: { total: number; add: number; del: number }
  // Chat-session context-window usage at the time this assistant message finished: used =
  // total context tokens consumed, window = model's context window. Set on the done message.
  usage?: { used: number; window: number }
  // Per-TURN token cost of this assistant turn (input incl. cache + output). Preferred source is the
  // provider's cumulative `result` usage (see extractTurnTokens). When the provider doesn't report it
  // (qoder/codex/cursor/gemini/…), we fall back to a CJK-aware ESTIMATE over the context fed + the reply
  // (estimated:true) so the (workspace × provider × day) usage ledger still moves for every provider.
  // Distinct from `usage` (a context-size snapshot): `tokens` is additive and safe to SUM. Absent only
  // for older messages recorded before this existed.
  tokens?: { input: number; output: number; estimated?: boolean }
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
  runCard?: { id: string; kind: 'auth' | 'question' | 'doubt' | 'failure' | 'gate' | 'aborted' | 'summary' | 'review' | 'hook'; stageKey: string; title: string; body?: string; decision: string; at: number; ts: number; finalize?: boolean; docs?: ArtifactRef[] }
  // Whole-turn wall-clock (epoch ms): stamped by the renderer's chat event loop — startedAt on
  // assistant-start (≈ when the LLM begins thinking), endedAt on done/error. Drives the live turn
  // timer in the message header (counts up every second while streaming) and the frozen 用时 total
  // once the turn finishes. Distinct from ChatThink.elapsed, which covers only the thinking phase.
  startedAt?: number
  endedAt?: number
}
export interface ChatSession {
  id: string
  title: string
  mode: 'chat' | 'workflow'
  createdAt: number
  // 「最后一次对话时间」(会话消息文件 mtime)。派生字段,不落盘,由 CH.sessionList 处理器按需附加(见
  // sessionLastMessageMtime)。会话列表显示的时间用它而非 createdAt —— 用户关心最近聊的时间,不是首次开始。
  lastMessageAt?: number
  runId?: string
  summary?: string
  // 已提炼进 workspace 记忆的消息数水位:promoteToWorkspace 只处理 [memPromotedAt, len) 这段增量,
  // 且每 WORKSPACE_PROMOTE_EVERY_K 条才跑一次 —— 避免每轮把整段历史重发给模型(蒸馏 token 大头)。
  memPromotedAt?: number
  readonly?: true
  external?: { source: SourceId; externalId: string; filePaths: string[] }
  continuedFrom?: { source: SourceId; externalId: string }
  // Per-session agent permission (sandbox) scope, remembered across switches. Absent = default 'auto'.
  permissionMode?: import('./permissions').PermissionMode
  // 对话式工作流(2026-07-30):本 session 若在某个工作流里,记下轻量 WorkflowSessionState(阶段/进度/
  // provider 配置/执行尾段 runId)。缺省=普通会话,不在工作流里。见 shared/workflowSession.ts。
  workflowSession?: import('./workflowSession').WorkflowSessionState
  // The coding agent + model this session last used. Remembered PER SESSION so each session keeps its
  // own choice (and switching sessions restores it) instead of one workspace-wide selection leaking.
  agentId?: string
  modelId?: string
}
export interface SessionsFile { sessions: ChatSession[]; activeSessionId: string; dismissedImported?: string[] }

// Bot bridge (钉钉/Telegram/飞书) live connection status — pushed to the settings pane over
// CH.botStatusEvent. Persisted bot config (creds/bindings) rides in Settings.botBridge instead.
export type BotPlatform = 'dingtalk' | 'telegram' | 'feishu'
export type BotStatus =
  | { state: 'offline' }
  | { state: 'connecting' }
  | { state: 'online' }
  | { state: 'error'; reason: string }
export interface BotStatusEvent { platform: BotPlatform; status: BotStatus }
/**
 * claude 的 AskUserQuestion:模型抛出 1–4 个问题、每题 2–4 个选项让人来选。
 * 它不是普通的权限请求 —— CLI 把它伪装成 `can_use_tool`(带 requires_user_interaction)发出来,而
 * 答案必须塞回权限响应的 `updatedInput.answers` 里(见 claudeControl.ts 的 controlAnswerLine)。
 * 只回一个 allow 而不带 answers,CLI 会拿空 answers 把工具跑完并合成
 * "The user did not answer the questions.",于是模型当场停在「没等到回复」。
 */
export interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}
/** 每题选中的 option label(多选题可多个)。key 是问题原文 —— CLI 就是按原文回查答案的。 */
export type AskAnswers = Record<string, string[]>
export interface ChatConfirm { id: string; title: string; where?: string; questions?: AskQuestion[]; ts?: string }
/**
 * 主进程里【还没被回答】的聊天门快照(chat:gate-state)。
 * 为什么需要:门是主进程的 Promise,一直阻塞着 provider;而卡片是渲染进程 useChat 的 state。切会话 / 离开
 * 再回来 / 刷新都会把那份 state 清空,门却还在 —— 于是侧栏和宠物一直喊「待确认」,聊天里却没有可点的卡片,
 * 那一轮就永远挂着。挂载时拉一次这个快照即可把卡片重建出来(与 chat:queue-state 同一套思路)。
 */
export interface ChatGateSnapshot {
  confirms: { id: string; sessionId: string; title: string; where?: string; questions?: AskQuestion[]; ts: string }[]
  asks: { id: string; sessionId: string; title: string; options?: { t: string; d: string }[]; agentName?: string; ts: string }[]
}
export interface ChatSendPayload {
  workspacePath: string
  sessionId: string
  agent: string        // provider id, e.g. 'claude'
  agentLabel: string   // provider displayName, e.g. 'Claude Code' (used only for the stored model label)
  model: string
  text: string
  attachments: Attachment[]
  source?: string      // who sent it, default '你'
  /**
   * 发起这一轮的设备名。★**由主进程从 `InvokeCtx.client` 填**,不信客户端在 payload 里自报 ——
   * 自报的话任何一个连上来的客户端都能把自己写成别人。
   */
  via?: string
  permissionMode?: import('./permissions').PermissionMode   // agent sandbox scope (readonly/auto/full)
}
export interface ChatQueueEvent { workspacePath: string; busy: boolean; queue: { id: string; text: string; source: string; sessionId: string }[]; running: { id: string; text: string; sessionId: string } | null; runningTurns: { id: string; text: string; sessionId: string }[]; runningSessionId: string | null; runningSessionIds: string[] }
export type ChatEvent = { workspacePath: string; sessionId: string } & (
  | { type: 'user'; message: ChatMessage }
  | { type: 'assistant-start'; id: string; model: string; context?: AgentContextMeta }
  | { type: 'assistant-delta'; id: string; text: string }
  // Replace (not append) the reply body with an authoritative full text — see ChatCallbacks.onAssistantReplace.
  | { type: 'assistant-replace'; id: string; text: string }
  | { type: 'think-delta'; id: string; text: string; context?: AgentContextMeta }
  // questions 非空 = 这不是「批准执行」而是「请回答」(claude AskUserQuestion),渲染成可点的选项卡片。
  | { type: 'confirm-request'; id: string; title: string; where?: string; questions?: AskQuestion[] }
  | { type: 'confirm-resolved'; id: string }
  // A delegate sub-agent's forge_ask, surfaced as a select (options) / input (no options) card.
  | { type: 'ask-request'; id: string; title: string; options?: { t: string; d: string }[]; agentName?: string }
  | { type: 'ask-resolved'; id: string }
  | { type: 'done'; message: ChatMessage }
  | { type: 'subagent'; id: string; sub: SubagentCard }
  // A main-agent tool call's live state (the "执行" block). `id` = the assistant message id; `tool`
  // carries the per-tool activity keyed by its own tool id. phase 'start' when the tool_use appears
  // (title known), 'done' on its result (output/status known).
  | { type: 'tool-activity'; id: string; tool: ToolActivity }
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
  // `message` 是这一轮实际落档的回复。错误路径下它常常**是有正文的** —— provider 先流出了答案、再以非零
  // 退出/stderr 收尾(见 chatService.finishErr 的 `text || 错误: …`)。带上它,消费方才分得清「彻底失败」和
  // 「答完了但收尾有告警」:app 一直显示的是正文,机器人过去只看 error 就打 ❌,同一轮两种观感。
  | { type: 'error'; id: string; error: string; message?: ChatMessage }
)

export type { Settings, Appearance, Pet, PetState, Anim, Accent, PetStateConfig, AgentsConfig, CustomAgent, CustomPetCfg, Terminal, CloseAction, AppIcon, DockIcon, Notifications, NotifyEvents, Keybindings } from '../main/config/schema'
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
export interface WsProject { repoId: string; name: string; branch: string; provider: string; model: string; inPlace?: boolean }
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

// The release artifact this machine should download: a .dmg on macOS, an NSIS .exe on Windows.
// (Named `asset*`, not `dmg*`, since 1.1.2 — the field is platform-neutral.)
export interface UpdateInfo { version: string; notes: string; assetUrl: string; assetSize: number; assetName: string }
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
