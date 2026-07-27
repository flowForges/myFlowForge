// Claude Code stream-json CONTROL PROTOCOL framing. With `--input-format stream-json
// --permission-prompt-tool stdio`, the CLI: (a) takes the prompt as a stdin `user` message rather
// than an argv positional, and (b) emits a `can_use_tool` control_request for every tool call that
// would otherwise prompt — including native Task sub-agents (tagged with agent_id). We answer with a
// `control_response`. These flags/shapes are undocumented CLI internals (match the bundled Agent SDK
// v0.2.x); read defensively. Pure functions only — unit-tested; no I/O here.

export const CLAUDE_CONTROL_FLAGS: string[] = ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']

export function controlInitLine(): string {
  return JSON.stringify({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })
}

export function userMessageLine(prompt: string): string {
  return JSON.stringify({
    type: 'user', session_id: '',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    parent_tool_use_id: null,
  })
}

export interface CanUseTool { requestId: string; toolName: string; input: any; toolUseId?: string; agentId?: string }

export function parseCanUseTool(obj: any): CanUseTool | null {
  if (obj?.type !== 'control_request') return null
  const r = obj.request
  if (r?.subtype !== 'can_use_tool') return null
  return {
    requestId: obj.request_id,
    toolName: r.tool_name,
    input: r.input,
    toolUseId: typeof r.tool_use_id === 'string' ? r.tool_use_id : undefined,
    agentId: typeof r.agent_id === 'string' ? r.agent_id : undefined,
  }
}

// Best-effort human-facing target for the gate label (file path or command).
export function toolTarget(input: any): string | undefined {
  return input?.file_path ?? input?.path ?? input?.command ?? undefined
}

export function controlAllowLine(req: CanUseTool): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: req.requestId, response: { behavior: 'allow', updatedInput: req.input, toolUseID: req.toolUseId } },
  })
}

export function controlDenyLine(req: CanUseTool, message = '用户拒绝了该操作'): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: req.requestId, response: { behavior: 'deny', message, toolUseID: req.toolUseId } },
  })
}
