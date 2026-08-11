// Antigravity CLI (`agy`) 的 print 模式 stream-json 事件解析。纯函数,无 I/O,可单测。
//
// 形状不是猜的:官方 headless 文档 + 二进制里的 Go json tag + 真机跑一次 `agy -p … --output-format
// stream-json` 三方对齐过。信封长这样(NDJSON,一行一个):
//
//   {"event":"init",        "init":        { cwd, tools[], permission_mode, model?, agent?, json_schema? }}
//   {"event":"step_update", "step_update": { conversation_id, step_index, state, step_type, tool_name,
//                                            text_delta, duration_seconds, usage, tool_info, subagent_info }}
//   {"event":"result",      "result":      { conversation_id, status, response, error?, duration_seconds,
//                                            num_turns, usage, structured_output? }}
//
// ★判别字段是 `event`,载荷嵌在【与 event 同名】的字段里 —— 不是 claude 那种平铺的 `type`。写解析时别按
// claude 的直觉平铺取值。(真机证据:未登录时它也会吐一条完整的 result 事件。)
//
// state 取 ACTIVE|DONE;status 在失败时是 "ERROR"。两者都当作字符串宽松比较 —— 未来新增枚举值不该让
// 整轮解析失败,认不出来就当普通事件忽略。

export type AgyAction =
  | { kind: 'session'; id: string }        // conversation_id → 供 --conversation 续聊
  | { kind: 'assistant'; text: string }    // 正文增量
  | { kind: 'tool'; text: string; id?: string; name?: string }
  | { kind: 'tool-result'; id: string; result?: string; isError?: boolean }
  | { kind: 'result'; text?: string; ok: boolean; error?: string }
  | { kind: 'ignore' }

export interface AgyUsage { input: number; output: number }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** 取出信封的 (事件名, 载荷)。认不出来返回 null。 */
export function agyEnvelope(obj: any): { event: string; payload: any } | null {
  const event = str(obj?.event)
  if (!event) return null
  const payload = obj[event]
  return { event, payload: payload && typeof payload === 'object' ? payload : {} }
}

/** 本轮真实 token 用量(result/step_update 都可能带)。缺失返回 undefined,不要编。 */
export function agyTurnTokens(obj: any): AgyUsage | undefined {
  const u = agyEnvelope(obj)?.payload?.usage
  if (!u || typeof u !== 'object') return undefined
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0
  // thinking_tokens 也是模型吐出来的,计进 output;否则「本轮输出」会比实际少一大截。
  const think = typeof u.thinking_tokens === 'number' ? u.thinking_tokens : 0
  if (!input && !output && !think) return undefined
  return { input, output: output + think }
}

/** 上下文占用(累计输入 + 缓存读)。用于上下文条;拿不到就不显示,不估算。 */
export function agyContextTokens(obj: any): number | undefined {
  const u = agyEnvelope(obj)?.payload?.usage
  if (!u || typeof u !== 'object') return undefined
  const total = typeof u.total_tokens === 'number' ? u.total_tokens : undefined
  return total && total > 0 ? total : undefined
}

/**
 * 一行事件 → 若干动作。
 *
 * ★正文只认 step_update.text_delta。result.response 是【整轮正文的全量重述】,再当增量发一遍就会把回答
 * 打印两遍 —— 所以 result 只用来收尾(带上失败原因),正文一个字都不取。
 */
export function parseAgyActions(obj: any): AgyAction[] {
  const env = agyEnvelope(obj)
  if (!env) return [{ kind: 'ignore' }]
  const out: AgyAction[] = []
  const p = env.payload

  const convo = str(p.conversation_id)
  if (convo) out.push({ kind: 'session', id: convo })

  if (env.event === 'step_update') {
    const delta = str(p.text_delta)
    if (delta) out.push({ kind: 'assistant', text: delta })

    const info = p.tool_info && typeof p.tool_info === 'object' ? p.tool_info : undefined
    const name = str(info?.name) ?? str(p.tool_name)
    // 一个工具步会先 ACTIVE 后 DONE:ACTIVE 出标题,DONE 配输出。id 用 step_index 拼(CLI 没给工具调用 id),
    // 这样同一步的开始与结束能在「执行」块里配上对。
    const id = typeof p.step_index === 'number' ? `agy-${p.step_index}` : undefined
    if (name) {
      const state = str(p.state)
      if (state === 'DONE') {
        if (id) out.push({ kind: 'tool-result', id, result: str(info?.output), isError: !!str(info?.error) })
      } else {
        out.push({ kind: 'tool', text: toolTitle(name, info?.parameters), id, name })
      }
    }
  }

  if (env.event === 'result') {
    const status = str(p.status)
    const err = str(p.error)
    // status 只有明确是 ERROR 才算失败 —— 未来加了别的成功态(COMPLETED/OK…)不该被误判成错。
    const ok = status !== 'ERROR' && !err
    out.push({ kind: 'result', text: str(p.response), ok, error: err })
  }

  return out.length ? out : [{ kind: 'ignore' }]
}

/** 工具步的一行标题:尽量带上人看得懂的目标(路径/命令),没有就只给工具名。 */
export function toolTitle(name: string, params: unknown): string {
  const p = params && typeof params === 'object' ? params as Record<string, unknown> : undefined
  const target = str(p?.file_path) ?? str(p?.path) ?? str(p?.command) ?? str(p?.query)
  return target ? `${name} · ${target}` : name
}
