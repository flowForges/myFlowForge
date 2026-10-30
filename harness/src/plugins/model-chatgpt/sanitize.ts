// ChatGPT 套餐共享的请求清洗与压缩(spec §6.4)
import { zstdCompressSync } from 'node:zlib'

/** 该线路不接受的字段;previous_response_id 也不发(store:false,每次带完整历史) */
const DROPPED = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt',
  'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id',
]
/** OpenAI 托管执行的工具:该线路整单拒绝 */
const HOSTED_TOOLS = new Set(['image_generation', 'file_search', 'code_interpreter', 'computer_use', 'computer_use_preview', 'computer', 'mcp', 'tool_search'])
const ZSTD_OVER = 1024 * 1024

/**
 * 工具写法集中在这里:当前按 Task 1 裁定用顶层 function 工具;
 * 若线上要求 namespace / additional_tools,只改这个函数。
 */
export function chatgptTools(tools: unknown[]): unknown[] {
  return tools.filter(t => !HOSTED_TOOLS.has(String((t as { type?: unknown } | null)?.type)))
}

export function sanitizeChatgptBody(body: object): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body }
  for (const k of DROPPED) delete out[k]
  out.store = false
  out.stream = true
  const input = out.input
  if (typeof input === 'string') out.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }]
  else if (Array.isArray(input))
    out.input = input.map(it => ((it as { role?: unknown } | null)?.role === 'system' ? { ...(it as object), role: 'developer' } : it))
  else out.input = []
  if (Array.isArray(out.tools)) {
    const tools = chatgptTools(out.tools)
    if (tools.length) out.tools = tools
    else delete out.tools
  }
  if (!Array.isArray(out.tools)) delete out.tool_choice // tool_choice 只在有工具时才能发(线上会 400)
  return out
}

/** 序列化;超过 1 MiB 用 zstd 压缩(服务端拒收更大的未压缩体) */
export function encodeChatgptBody(body: object): { body: string | Uint8Array; headers: Record<string, string> } {
  const json = JSON.stringify(body)
  const bytes = Buffer.from(json, 'utf8')
  if (bytes.length > ZSTD_OVER) return { body: zstdCompressSync(bytes), headers: { 'content-encoding': 'zstd' } }
  return { body: json, headers: {} }
}
