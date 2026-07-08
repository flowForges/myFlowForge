import type { ChatTask } from './types'

export type ChatStreamAction =
  | { kind: 'session'; id: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'think'; text: string }
  | { kind: 'tool'; text: string }
  | { kind: 'file'; text: string }
  | { kind: 'result'; text?: string }
  | { kind: 'ignore' }

// Map one parsed stream-json object to a chat action. Mirrors the shape claude.ts run() already
// assumes (assistant/result carry a flat `text`), plus thinking + session_id.
export function parseChatStreamObj(obj: any): ChatStreamAction {
  if (obj && typeof obj.session_id === 'string') return { kind: 'session', id: obj.session_id }
  if (obj?.type === 'assistant' && typeof obj.text === 'string') return { kind: 'assistant', text: obj.text }
  if (obj?.type === 'thinking' && typeof obj.text === 'string') return { kind: 'think', text: obj.text }
  if (obj?.type === 'result') return { kind: 'result', text: typeof obj.text === 'string' ? obj.text : undefined }
  return { kind: 'ignore' }
}

// A short, human-readable label for a tool call: "调用 Read package.json" / "调用 Bash: go build".
function toolStep(name: string, input: any): string {
  const clip = (v: unknown) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > 200 ? s.slice(0, 200) + '…' : s }
  if (input?.file_path) return `调用 ${name} ${clip(input.file_path)}`
  if (input?.path) return `调用 ${name} ${clip(input.path)}`
  if (input?.command != null) return `调用 ${name}: ${clip(input.command)}`
  if (input?.pattern != null) return `调用 ${name}: ${clip(input.pattern)}`
  if (input?.url != null) return `调用 ${name} ${clip(input.url)}`
  return `调用 ${name}`
}

// Providers that stream reasoning via `--include-partial-messages` (qoder) emit `thinking_delta`
// at word/token granularity — one `think` action per word. Downstream, every think delta becomes a
// separate line (chatService joins them with '\n'; the chat panel renders one step per line), so raw
// word-deltas show up as one-word-per-line. Coalesce them: buffer the running text and only surface
// COMPLETE lines (split on real newlines), carrying the trailing partial forward until the next
// chunk or an explicit flush. `rest` is the still-incomplete tail.
export function splitThinkLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.filter(l => l.trim()), rest }
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])
function toolAction(name: string, input: any): ChatStreamAction {
  return { kind: FILE_TOOLS.has(name) ? 'file' : 'tool', text: toolStep(name, input) }
}

// One stream-json line can carry a session id AND several content blocks (the *real*
// `claude --output-format stream-json` nests text/thinking under `message.content[]`),
// so a single object maps to zero-or-more actions. Handles both the real nested shape
// and the flat `{ type, text }` shape used by test fixtures / simplified providers.
export function parseChatStreamActions(obj: any): ChatStreamAction[] {
  if (!obj || typeof obj !== 'object') return []
  const out: ChatStreamAction[] = []
  if (typeof obj.session_id === 'string') out.push({ kind: 'session', id: obj.session_id })

  if (obj.type === 'stream_event' && obj.event) {
    const ev = obj.event
    if (ev.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string' && ev.delta.text) out.push({ kind: 'assistant', text: ev.delta.text })
      else if (ev.delta.type === 'thinking_delta' && typeof ev.delta.thinking === 'string' && ev.delta.thinking) out.push({ kind: 'think', text: ev.delta.thinking })
    } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && typeof ev.content_block.name === 'string') {
      out.push(toolAction(ev.content_block.name, ev.content_block.input))
    }
    return out
  }

  const content = obj.message?.content
  if (obj.type === 'assistant' && Array.isArray(content)) {
    // A message that also makes tool calls is the model "working" — its prose is narration,
    // so route that text to the thinking trace (like the CLI). A tool-less message is the
    // final answer, so its text goes to the reply body.
    const working = content.some((b: any) => b?.type === 'tool_use')
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text) out.push({ kind: working ? 'think' : 'assistant', text: b.text })
      else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) out.push({ kind: 'think', text: b.thinking })
      // Surface tool calls as visible process steps (so the user sees activity, not just a spinner).
      else if (b?.type === 'tool_use' && typeof b.name === 'string') out.push(toolAction(b.name, b.input))
    }
    return out
  }
  if (obj.type === 'assistant' && typeof obj.text === 'string') { out.push({ kind: 'assistant', text: obj.text }); return out }
  if (obj.type === 'thinking' && typeof obj.text === 'string') { out.push({ kind: 'think', text: obj.text }); return out }
  if (obj.type === 'result') {
    const text = typeof obj.result === 'string' ? obj.result : (typeof obj.text === 'string' ? obj.text : undefined)
    out.push({ kind: 'result', text })
  }
  return out
}

// Live context occupancy in tokens, from a claude/qoder-compatible stream-json object carrying a
// per-turn `usage` object. Returns null when no usable usage is present.
//
// Two deliberate exclusions keep this a measure of *current* context size, not session cost:
//   1. The `result` event is skipped — its usage is CUMULATIVE across every internal tool-loop
//      model call in one run, so its cache_read tier alone can be many times the window. Counting
//      it made the bar saturate at 100% even on a tiny task. Per-turn assistant usage is the only
//      faithful snapshot of how full the context is right now.
//   2. output_tokens is excluded — generated text is not context occupancy (it only becomes input
//      on the next turn), and the result event's cumulative output is another large inflator.
export function extractContextTokens(obj: any): number | null {
  if (obj?.type === 'result') return null
  const u = obj?.message?.usage ?? obj?.usage
  if (!u || typeof u !== 'object') return null
  const n = (x: any) => (typeof x === 'number' && x > 0 ? x : 0)
  const total = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
  return total > 0 ? total : null
}

// Context-window size in tokens for a model id (claude/qoder default 200K; 1m variants 1M).
export function contextWindowFor(model: string): number {
  return /1m/i.test(model || '') ? 1_000_000 : 200_000
}

export function buildChatPrompt(task: ChatTask): string {
  if (!task.attachments || task.attachments.length === 0) return task.prompt
  const lines = task.attachments.map(a => `- ${a.path}`).join('\n')
  return `${task.prompt}\n\n附件:\n${lines}`
}
