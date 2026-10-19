import type { McpServer, PermissionOption, RequestPermissionResponse, ToolCallContent, ToolCallUpdate, ToolKind } from '@agentclientprotocol/sdk'
import type { ConfirmReq } from '../types'
import type { ForgeServerSpec } from '../mcpConfig'

// ACP 报文 ↔ 我们的回调形状之间的纯映射。不碰进程、不碰连接,所以全部可以单测。

/** Forge MCP → ACP 的 stdio MCP 声明。★env 在 ACP 里是 `{name,value}[]`,不是对象。 */
export function forgeAcpMcpServers(spec: ForgeServerSpec | null): McpServer[] {
  if (!spec) return []
  return [{ name: 'forge', command: spec.command, args: spec.args, env: Object.entries(spec.env).map(([name, value]) => ({ name, value })) }]
}

/** 一个工具调用到目前为止我们知道的样子(tool_call 先到,tool_call_update 逐步补字段)。 */
export interface AcpToolState {
  title?: string; kind?: ToolKind | null; name?: string | null; rawInput?: unknown; locations?: { path: string }[] | null
  /** 输出可能在中间某条 update 里先到、收尾那条只带 status,所以要记着。 */
  content?: ToolCallContent[] | null; rawOutput?: unknown
}

export function mergeToolState(prev: AcpToolState | undefined, u: Partial<ToolCallUpdate>): AcpToolState {
  return {
    title: u.title ?? prev?.title,
    kind: u.kind ?? prev?.kind,
    name: u.name ?? prev?.name,
    rawInput: u.rawInput ?? prev?.rawInput,
    locations: u.locations ?? prev?.locations,
    content: u.content ?? prev?.content,
    rawOutput: u.rawOutput ?? prev?.rawOutput,
  }
}

/** 工具卡的输出正文。优先 content 里的文本,其次 rawOutput。拿不到就 undefined(卡片只变状态)。 */
export function toolOutputText(content: ToolCallContent[] | null | undefined, rawOutput: unknown): string | undefined {
  const parts: string[] = []
  for (const c of content ?? []) {
    if (c.type === 'content' && c.content.type === 'text') parts.push(c.content.text)
    else if (c.type === 'diff') parts.push(`✎ ${c.path}`)
    // terminal:我们没声明 terminal 能力,正常不会出现;出现了也读不到内容,略过。
  }
  if (parts.length) return parts.join('\n')
  if (typeof rawOutput === 'string') return rawOutput
  if (rawOutput != null) { try { return JSON.stringify(rawOutput) } catch { return undefined } }
  return undefined
}

/** 门上「在做什么」那一行:有命令给命令,否则给涉及的路径。 */
function gateWhere(t: AcpToolState): string | undefined {
  const input = t.rawInput as { command?: unknown } | null | undefined
  const cmd = input && typeof input === 'object' ? input.command : undefined
  if (typeof cmd === 'string' && cmd) return cmd
  if (Array.isArray(cmd) && cmd.every((x) => typeof x === 'string')) return cmd.join(' ')
  const paths = (t.locations ?? []).map((l) => l.path).filter(Boolean)
  return paths.length ? paths.join(', ') : undefined
}

/**
 * ★`readOnly` 只认 agent **自己**给工具标的 kind(`read` / `search`),和 codex 用它自己解析出的
 *  commandActions 是同一个信任模型 —— 我们不去猜命令字符串。`fetch` 会联网,不算只读;
 *  没标 kind / 标了别的 = 不是只读,照常升门(失败即拦)。
 */
const READ_ONLY_KINDS = new Set<ToolKind>(['read', 'search'])

export function acpGateReq(toolCallId: string, t: AcpToolState): ConfirmReq {
  return {
    title: t.title || t.name || '工具调用',
    where: gateWhere(t),
    toolName: t.name ?? t.kind ?? undefined,
    toolUseId: toolCallId,
    readOnly: !!t.kind && READ_ONLY_KINDS.has(t.kind),
  }
}

/**
 * 用户的「允许 / 拒绝」→ agent 给的某个选项。
 *
 * ★我们的门是**逐次**的,所以放行优先选 allow_once,绝不在有 once 的时候替用户点「总是允许」——
 *  那会把一次点头变成 agent 侧永久的授权,而这件事在 Forge 里根本看不见、也撤不回。
 *  只有 agent 只给了 allow_always 时才用它(否则就没法放行了)。拒绝同理优先 reject_once。
 * ★一个能用的选项都没有 → 回 cancelled:协议里唯一不依赖选项的回答,对面一定认得。
 */
export function permissionResponse(options: PermissionOption[], allow: boolean): RequestPermissionResponse {
  const order = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const kind of order) {
    const o = options.find((x) => x.kind === kind)
    if (o) return { outcome: { outcome: 'selected', optionId: o.optionId } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

export const CANCELLED_PERMISSION: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
