import type { ContextUsage } from '@shared/types'
import type { ChatTask } from './types'

export type ChatStreamAction =
  | { kind: 'session'; id: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'think'; text: string }
  // `id`/`name` carry the tool_use id + raw tool name when the stream exposes them (claude/qoder), so the
  // adapter can surface a correlated "执行" activity (title now, output paired by id on the tool_result).
  | { kind: 'tool'; text: string; id?: string; name?: string }
  | { kind: 'file'; text: string; id?: string; name?: string }
  | { kind: 'result'; text?: string }
  // A built-in Task sub-agent: the tool_use starts it, the matching tool_result finishes it.
  | { kind: 'subagent-start'; id: string; subagentType?: string; description?: string; prompt?: string }
  | { kind: 'subagent-result'; id: string; result?: string; isError?: boolean }
  | { kind: 'ignore' }

// 内置的「派生子 agent」工具。它的 tool_use 带着 { subagent_type, description, prompt }。
//
// ★★**两个名字都要认**:Claude Code 把它从 `Task` 改名成了 `Agent`。
//  2026-09-17 真机报的症状是「子 agent 呼不出来了」—— 而它一直在正常跑,只是我们不认识了,
//  于是三个子 agent 被画成三行普通的「调用 Agent」:没有卡片、没有进度、没有执行过程。
//  ★这类失败没有任何错误信息,功能只是**看起来不见了**,所以它能活很久没人发现。
//  ★老名字保留:旧版本 CLI 仍然发 `Task`,只认新名字等于把老用户换个方向摔一次。
const SUBAGENT_TOOLS = new Set(['Task', 'Agent'])
/** ★必须是**全等**匹配,不是包含 —— `ListAgents` / `AgentTool` 这些不是它。 */
const isSubagentTool = (name: unknown): boolean => typeof name === 'string' && SUBAGENT_TOOLS.has(name)

// Flatten a tool_result block's `content` (string, or an array of {type:'text',text} parts) to text.
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (typeof c === 'string' ? c : (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))).filter(Boolean).join('\n')
  return ''
}

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
function toolAction(name: string, input: any, id?: string): ChatStreamAction {
  return { kind: FILE_TOOLS.has(name) ? 'file' : 'tool', text: toolStep(name, input), id, name }
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
      const cb = ev.content_block
      // Task sub-agent: emit a subagent-start (input is usually empty at content_block_start — it
      // streams later; the full assistant message enriches it via 'update').
      if (isSubagentTool(cb.name) && typeof cb.id === 'string') {
        out.push({ kind: 'subagent-start', id: cb.id, subagentType: cb.input?.subagent_type, description: cb.input?.description, prompt: cb.input?.prompt })
      } else {
        out.push(toolAction(cb.name, cb.input, typeof cb.id === 'string' ? cb.id : undefined))
      }
    }
    return out
  }

  // Tool results come back as a `user` message; correlate a Task's result by tool_use_id. (Downstream
  // filters to ids it saw as subagent-start, so non-Task results are harmless no-ops.)
  if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
    for (const b of obj.message.content) {
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        out.push({ kind: 'subagent-result', id: b.tool_use_id, result: toolResultText(b.content), isError: b.is_error === true })
      }
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
      // A Task sub-agent gets its own card (this full message carries the complete input); every other
      // tool call is surfaced as a visible process step (so the user sees activity, not just a spinner).
      else if (b?.type === 'tool_use' && isSubagentTool(b.name) && typeof b.id === 'string') out.push({ kind: 'subagent-start', id: b.id, subagentType: b.input?.subagent_type, description: b.input?.description, prompt: b.input?.prompt })
      else if (b?.type === 'tool_use' && typeof b.name === 'string') out.push(toolAction(b.name, b.input, typeof b.id === 'string' ? b.id : undefined))
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

// Per-TURN token cost (input + output), for the token-usage ledger (工作区×provider×每天 汇总).
// Unlike extractContextTokens (a live context-size snapshot), this reads the `result` event's
// CUMULATIVE usage across the whole turn's tool loop — which is exactly "what this turn cost". Returns
// null when there's no result-event usage (most providers only emit it on the terminal result line).
// input = fresh input + cache tiers (what we paid to feed the model); output = generated tokens.
export function extractTurnTokens(obj: any): { input: number; output: number } | null {
  if (obj?.type !== 'result') return null
  const u = obj?.usage ?? obj?.message?.usage
  if (!u || typeof u !== 'object') return null
  const n = (x: any) => (typeof x === 'number' && x > 0 ? x : 0)
  const input = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
  const output = n(u.output_tokens)
  return input > 0 || output > 0 ? { input, output } : null
}

/**
 * 模型的上下文窗口 —— **只从 CLI 自己报的地方取**,取不到就是 null(不知道),绝不回落到猜测值。
 *
 * ★★这里原来是 `contextWindowFor(model)`:模型名里带 "1m" 就算 1M,否则一律 200K。那个数字
 *  从来没人核对过,却被拿去算百分比画进度条 —— 用户看到的是一个「看着很像回事的假数」。
 *  2026-09-14 用户点名要求:「上下文要真实,从官方自己的能力里取的,不能是你自己计算的」。
 *
 * claude 把它放在 `result` 事件的 `modelUsage[模型].contextWindow`(2.1.265 实测)。
 * ★只有 window 从 result 取。`used` 仍然必须避开 result —— 那里的 usage 是整轮累计,
 *  拿它当占用量会让进度条虚高到 100%(见 extractContextTokens 上面那段注释)。
 *  窗口不一样:它是跟模型走的静态值,不随累计变化,从哪个事件读都一样。
 *
 * ★多个模型时取**最大**的:一轮里可能夹着小模型分身(haiku 之类),它们的小窗口不能拿来
 *  代表主模型。
 */
export function extractContextWindow(obj: any): number | null {
  if (obj?.type !== 'result') return null
  const mu = obj.modelUsage
  if (!mu || typeof mu !== 'object') return null
  let best = 0
  for (const v of Object.values(mu as Record<string, any>)) {
    const w = v?.contextWindow
    if (typeof w === 'number' && w > best) best = w
  }
  return best > 0 ? best : null
}

export function buildChatPrompt(task: ChatTask): string {
  if (!task.attachments || task.attachments.length === 0) return task.prompt
  const lines = task.attachments.map(a => `- ${a.path}`).join('\n')
  return `${task.prompt}\n\n附件:\n${lines}`
}

/**
 * 一轮对话里跟踪「已用上下文 + 官方窗口」,并在有变化时上报。
 *
 * ★★抽成一个跟踪器,是因为原来这段在**八个调用点**各抄了一遍(claude/codex/qoder 各两处、
 *  opencode 两处、antigravity 一处)。这正是 [[trap-two-call-sites-run-vs-chat]] 那类坑的温床:
 *  改其中几处、漏掉另几处,表现出来就是「工作流里对、聊天里不对」。
 *
 * ★`used` 取**见过的最大值**而不是最后一个:CLI 一轮里会发很多条 usage,中间态可能偏小。
 * ★`window` 只在 CLI 明确上报时才有。窗口通常跟在轮末的 `result` 事件里,比 used 晚到 ——
 *  所以拿到窗口时要**补发一次**,否则这一轮直到结束都显示不出占比。
 */
export function makeUsageTracker(
  emit: (u: ContextUsage) => void,
  usedOf: (obj: any) => number | null | undefined = extractContextTokens,
) {
  let used = 0
  let window: number | undefined
  return {
    feed(obj: any): void {
      const w = extractContextWindow(obj)
      if (w != null && w !== window) {
        window = w
        if (used > 0) emit({ used, window })   // 窗口后到:补发一次,让占比当轮就能显示
      }
      const u = usedOf(obj)
      if (u != null && u > used) {
        used = u
        emit({ used, window })
      }
    },
  }
}
