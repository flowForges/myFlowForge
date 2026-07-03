export interface AgentRef { runId: string; stageKey: string; agentId: string; name: string }

export type MessageType =
  | 'task' | 'result' | 'handoff' | 'question' | 'answer' | 'confirm' | 'input' | 'status' | 'read' | 'error'

export interface ArtifactRef { path: string; kind: string }

export interface AgentMessage {
  id: string
  runId: string
  from: AgentRef | 'orchestrator' | 'user'
  to: AgentRef | 'orchestrator' | 'broadcast'
  type: MessageType
  payload: unknown
  artifacts: ArtifactRef[]
  ts: string
}
