import type { Attachment } from '@shared/types'

export interface HandoffPayload { summary: string; artifacts?: { path: string; kind: string }[] }

export type AgentState = 'wait' | 'run' | 'stalled' | 'awaiting' | 'ok' | 'err'
export interface Model { id: string; label: string; description?: string }
export interface AgentCapabilities { structuredOutput: boolean; permissionHook: boolean; pty: boolean; mcpTools?: boolean; liveModels?: boolean }

export interface LogLine { ts: string; text: string; level: 'info' | 'ok' | 'accent' | 'run'; kind?: 'think' | 'tool' | 'file' | 'output' }
export interface ConfirmReq { title: string; where?: string }
export interface InputReq { title: string; placeholder?: string }
export interface AgentResult { ok: boolean; summary?: string }

export interface AgentTask {
  stageKey: string
  agentId: string
  name: string
  prompt: string
  cwd: string
  model: string
  allowedTools?: string[]
  skills?: string[]
  // Permission shield inherited from the initiating chat session (dual-path design). Absent →
  // provider default (treated as 'auto' = workspace-write/acceptEdits, the historical run behavior).
  permissionMode?: import('@shared/permissions').PermissionMode
}
export interface AgentCallbacks {
  onLog(line: LogLine): void
  onState(state: AgentState): void
  // Raw liveness signal: fired on ANY stdout traffic from the agent process, even traffic that
  // produces no log line (e.g. a long run of tool-input deltas while writing a large file). The
  // orchestrator uses it to keep the stall watchdog from killing a healthy but logless agent.
  onActivity?(): void
  // CLI session id from the provider (forwarded by run() when the stream emits a session event).
  // Optional: providers that don't emit a session id never call this; the run sidecar omits them.
  onSession?(id: string): void
  // Context-window usage (raw tokens): used = total context tokens consumed so far, window =
  // model's context window size. Fired (run() only) when the running max usage increases.
  onUsage?(u: { used: number; window: number }): void
  onConfirm(req: ConfirmReq): Promise<'allow' | 'deny'>
  onInput(req: InputReq): Promise<string>
  onDone(result: AgentResult): void
  onError(err: Error): void
  onHandoff?(p: HandoffPayload): void
  // A grand-agent: this sub-agent spawned its OWN built-in Task. Surfaced (best-effort) so the IDs
  // panel can show it at depth 2. No resumable session id — `id` is the tool_use id.
  onSubagent?(ev: { id: string; phase: 'start' | 'done'; subagentType?: string; description?: string; result?: string; isError?: boolean }): void
}
export interface AgentSession { id: string; cancel(): void; done: Promise<AgentResult> }

export interface ChatTask {
  id: string
  prompt: string
  model: string
  cwd: string
  sessionId?: string
  attachments?: Attachment[]
  permissionMode?: import('@shared/permissions').PermissionMode
}
export interface ChatCallbacks {
  onSession(id: string): void
  onAssistantDelta(text: string): void
  onThinkDelta(text: string): void
  onActivity?(): void
  // Raw startup/runtime log lines (CLI stderr, MCP-connect chatter, non-JSON stdout). Surfaced live in
  // the think block so a slow spawn / MCP handshake / model-load shows real activity — the long silent
  // gap before the first token was the "感觉像卡住" complaint.
  onStatus?(text: string): void
  // Context-window usage (raw tokens): used = total context tokens consumed so far, window =
  // model's context window size. Fired when the running max usage increases.
  onUsage?(u: { used: number; window: number }): void
  // A built-in Task sub-agent the main agent spawned. phase 'start' when the Task tool_use appears
  // (fields may be partial), 'update' to enrich once the full input is seen, 'done' on the tool_result.
  onSubagent?(ev: { id: string; phase: 'start' | 'update' | 'done'; subagentType?: string; description?: string; prompt?: string; result?: string; isError?: boolean }): void
  onDone(r: { elapsed: number }): void
  onError(err: Error): void
  onConfirm?(req: ConfirmReq): Promise<'allow' | 'deny'>
}

export interface AgentProvider {
  id: string
  displayName: string
  bin?: string   // the CLI bin this provider invokes (override or default), for display/resolution
  capabilities: AgentCapabilities
  detect(): Promise<boolean>
  listModels(env: NodeJS.ProcessEnv): Promise<Model[]>
  /** Query models live from the CLI (e.g. `--list-models`). Only present when capabilities.liveModels===true. */
  listModelsLive?(env: NodeJS.ProcessEnv): Promise<Model[]>
  run(task: AgentTask, cb: AgentCallbacks, env: NodeJS.ProcessEnv): AgentSession
  chat?(task: ChatTask, cb: ChatCallbacks, env: NodeJS.ProcessEnv): AgentSession
}
