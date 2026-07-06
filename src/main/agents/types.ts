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
  // Context-window usage (raw tokens): used = total context tokens consumed so far, window =
  // model's context window size. Fired when the running max usage increases.
  onUsage?(u: { used: number; window: number }): void
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
