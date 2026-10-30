// 统一模型接口(spec §5):各协议适配器与调用方之间只用这些类型
import type { AccountState, Quota } from '../../protocol/models'

export type { Quota }

export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string } // base64
  | { type: 'tool_call'; id: string; name: string; args: string } // args 为原始 JSON 字符串
  | { type: 'tool_result'; callId: string; content: string; isError?: boolean }
  | { type: 'reasoning'; text?: string; replay?: unknown } // replay:供应商不透明数据,原样回传

export interface Message {
  role: 'user' | 'assistant' | 'tool'
  parts: Part[]
}

export interface ModelRequest {
  model: string // 目录中的模型 id
  system?: string
  messages: Message[]
  tools?: { name: string; description: string; parameters: object }[]
  reasoning?: 'off' | 'low' | 'medium' | 'high'
  maxOutput?: number
  interactive: boolean // 是否由用户当面发起;false 时拒绝 coding-tools-only 账号
  signal: AbortSignal
}

export interface ModelError {
  kind: 'auth' | 'quota' | 'rate_limit' | 'restricted' | 'bad_request' | 'unavailable' | 'network'
  message: string
  retryable: boolean
  retryAfterMs?: number
}

export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta?: string; replay?: unknown }
  | { type: 'tool_call'; id: string; name?: string; argsDelta: string }
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | { type: 'done'; reason: 'stop' | 'length' | 'tool_calls' | 'cancelled' | 'error'; error?: ModelError }

export type ModelProtocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'chatgpt'

/** 交给适配器的账号(运行时视图,由 models 服务组装;apiKey 只在内存里传递) */
export interface Account {
  id: string
  presetId: string
  label: string
  protocol: ModelProtocol
  baseUrl: string
  apiKey?: string
  state: AccountState
  quirks?: Record<string, unknown>
}

/** 只有收到 done 才算结束;错误永远以 done{error} 结束,不抛给调用方 */
export interface ModelAdapter {
  stream(account: Account, req: ModelRequest): AsyncIterable<ModelEvent>
  quota?(account: Account): Promise<Quota | null>
  test(account: Account): Promise<void>
}
