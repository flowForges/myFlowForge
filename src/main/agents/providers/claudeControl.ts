// Claude Code stream-json CONTROL PROTOCOL framing. With `--input-format stream-json
// --permission-prompt-tool stdio`, the CLI: (a) takes the prompt as a stdin `user` message rather
// than an argv positional, and (b) emits a `can_use_tool` control_request for every tool call that
// would otherwise prompt — including native Task sub-agents (tagged with agent_id). We answer with a
// `control_response`. These flags/shapes are undocumented CLI internals (match the bundled Agent SDK
// v0.2.x); read defensively. Pure functions only — unit-tested; no I/O here.

import type { AskAnswers, AskQuestion } from '@shared/types'

export const CLAUDE_CONTROL_FLAGS: string[] =['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']

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

export interface CanUseTool {
  requestId: string; toolName: string; input: any; toolUseId?: string; agentId?: string
  // The CLI sets requires_user_interaction on tools that are a QUESTION for the human rather than an
  // operation to approve (AskUserQuestion). Such a request is answered, not merely allowed.
  requiresUserInteraction?: boolean
}

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
    requiresUserInteraction: r.requires_user_interaction === true,
  }
}

// AskUserQuestion's input → the questions/options we render as a pickable card. Returns null for
// anything that isn't a usable question set (a normal tool's input, or a malformed one) so the caller
// falls back to the plain permission card rather than showing an empty chooser.
export function parseAskQuestions(input: any): AskQuestion[] | null {
  const raw = input?.questions
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: AskQuestion[] = []
  for (const q of raw) {
    if (typeof q?.question !== 'string' || !q.question.trim()) return null
    if (!Array.isArray(q.options) || q.options.length === 0) return null
    const options: AskQuestion['options'] = []
    for (const o of q.options) {
      if (typeof o?.label !== 'string' || !o.label) return null
      options.push({ label: o.label, description: typeof o.description === 'string' ? o.description : undefined })
    }
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options,
    })
  }
  return out
}

// Card title for a question gate: a single question IS the title; a set gets a generic heading (each
// question then renders its own sub-heading in the card).
export function askGateTitle(questions: AskQuestion[]): string {
  return questions.length === 1 ? questions[0].question : '请回答以下问题'
}

// Answer an AskUserQuestion gate. This is NOT `controlAllowLine` with extra fields bolted on — the
// distinction is the whole bug: the CLI's AskUserQuestion implementation reads its answers straight
// out of the (possibly rewritten) tool input — `async call({questions, answers = {}, response})` — so
// the permission response's `updatedInput` IS the answer channel. Echo the input back unchanged (as
// controlAllowLine does) and `answers` stays `{}`, whereupon the CLI synthesises the tool_result
// "The user did not answer the questions." and the model stalls having asked into the void.
// Shapes (read off the CLI bundle): answers is keyed by the question's own text; a single-select
// answer is a bare label string, a multiSelect one an array of labels; `response` is free text for
// "none of these fit" and renders to the model as "The user responded: …".
export function controlAnswerLine(req: CanUseTool, answers: AskAnswers, response?: string): string {
  const multi = new Set<string>()
  for (const q of req.input?.questions ?? []) if (q?.multiSelect === true && typeof q.question === 'string') multi.add(q.question)
  const packed: Record<string, string | string[]> = {}
  for (const [question, labels] of Object.entries(answers)) {
    if (!labels?.length) continue   // an unanswered question is simply absent, never a blank pick
    packed[question] = multi.has(question) ? labels : labels[0]
  }
  const free = response?.trim()
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: req.requestId,
      response: {
        behavior: 'allow',
        updatedInput: { ...req.input, answers: packed, ...(free ? { response: free } : {}) },
        toolUseID: req.toolUseId,
      },
    },
  })
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

/**
 * 一条我们**不认识、但对面正等着回答**的控制请求。认出来才能回一句「不支持」。
 *
 * ★★和 codex 那个「回答形状错了就永远悬着」是同一类问题(commit 4c6423e)。这里原来更直接:
 *  非 `can_use_tool` 的 control_request 会一路掉过所有分支、**根本没人回答**,claude 就静静地等,
 *  这一轮挂住,用户看到的只是一个不动的光标 —— 直到 240 秒的空闲看门狗才说一句话。
 *
 * ★装好的 CLI(2.1.265)里除了 can_use_tool 还有 `hook_callback` 和 `mcp_message`。它们只在我们
 *  启用了 SDK 侧的钩子 / 进程内 MCP 时才会发 —— 我们现在都没用,所以**今天大概率不会触发**。
 *  但「不认识就不回答」这个形状本身就不该留着:哪天 CLI 多发一种,症状就是又一次静默挂住。
 *
 * ★`control_cancel_request` 是**撤销**,不是等回答的请求 —— 回它反而错,所以只认 `control_request`。
 */
export function unhandledControlRequest(obj: any): { requestId: string; subtype: string } | null {
  if (obj?.type !== 'control_request') return null
  const subtype = String(obj.request?.subtype ?? '')
  if (subtype === 'can_use_tool') return null      // 有正经处理路径
  const requestId = obj.request_id
  // 没有 request_id 就没法回答(回了也没人认领),放过它。
  if (typeof requestId !== 'string' || !requestId) return null
  return { requestId, subtype: subtype || '(未注明)' }
}

/** 按控制协议回一个 error 响应。这是「我不支持这个请求」的**正确**说法,比不回答强得多。 */
export function controlErrorLine(requestId: string, error: string): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error },
  })
}
