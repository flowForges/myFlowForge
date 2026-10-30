// 统一模型接口(spec §5):各协议适配器与调用方之间只用这些类型
import type { AccountState, AccountView, CatalogView, ModelEntry, ModelRef, Quota } from '../../protocol/models'

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
  /** test() 回退探测用的模型 id(目录首项或手填首项) */
  testModel?: string
}

/** 只有收到 done 才算结束;错误永远以 done{error} 结束,不抛给调用方 */
export interface ModelAdapter {
  stream(account: Account, req: ModelRequest): AsyncIterable<ModelEvent>
  quota?(account: Account): Promise<Quota | null>
  test(account: Account): Promise<void>
  /** models: 'list' 预设的模型清单 */
  listModels?(account: Account): Promise<{ id: string; name?: string }[]>
}

export interface AddAccountInput {
  presetId: string
  label?: string
  apiKey?: string // 只进 SecretStore
  baseUrl?: string
  protocol?: ModelProtocol
  restrictionAck?: boolean
  models?: ModelEntry[] // 自定义预设的手填清单
}

/** models-registry 提供的服务(spec §6.1);账号视图不含密钥 */
export interface ModelsService {
  registerAdapter(protocol: ModelProtocol, a: ModelAdapter): () => void
  /** 删除账号前调用(如 ChatGPT 注销令牌);失败只记日志 */
  registerRemoveHook(protocol: ModelProtocol, fn: (account: Account) => void | Promise<void>): () => void
  catalog(): CatalogView
  accounts(): AccountView[]
  addAccount(input: AddAccountInput): Promise<AccountView>
  removeAccount(id: string): Promise<void>
  testAccount(id: string): Promise<{ ok: boolean; error?: ModelError }>
  setDefault(ref: ModelRef): void
  /** 适配器上报账号状态(如 needs_login / not_authorized);有变化才发 account.updated */
  setState(id: string, state: AccountState): void
  /** 重新发 account.updated(如重新登录成功但状态未变) */
  announce(id: string): void
  stream(ref: ModelRef | 'default', req: Omit<ModelRequest, 'model'>): AsyncIterable<ModelEvent>
  quota(accountId: string): Promise<Quota | null>
}
