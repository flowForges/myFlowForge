// model-openai:openai-chat 与 openai-responses 两个协议适配器(spec §6.2)
import type { Plugin } from '../../kernel/pluginHost'
import { manifest } from './manifest'
import { buildChatBody, decodeChatStream, type ChatQuirks } from '../../lib/models/chat'
import { buildResponsesBody, decodeResponsesStream } from '../../lib/models/responses'
import type { Account, ModelAdapter, ModelsService } from '../../lib/models/types'
import { getJson, joinUrl, modelIds, openaiAuth, openaiHeaders, probeWithTinyStream, streamWire } from '../../lib/models/wire'

// 通用部分:test() 先走 GET /models,404 则按协议发 1 token 流式请求
const common = (probeTimeoutMs: number | undefined, path: string, probeBody: (model: string) => object) => ({
  async test(account: Account) {
    const r = await getJson(joinUrl(account.baseUrl, '/models'), openaiAuth(account), { tolerate404: true })
    if (r !== undefined) return
    await probeWithTinyStream(joinUrl(account.baseUrl, path), openaiHeaders(account), probeBody(account.testModel ?? 'gpt-4o-mini'), probeTimeoutMs)
  },
  async listModels(account: Account) {
    return modelIds(await getJson(joinUrl(account.baseUrl, '/models'), openaiAuth(account)))
  },
})

const chat = (t?: number): ModelAdapter => ({
  ...common(t, '/chat/completions', (model) => ({ model, stream: true, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })),
  stream: (account, req) =>
    streamWire(
      joinUrl(account.baseUrl, '/chat/completions'),
      openaiHeaders(account),
      buildChatBody(req, (account.quirks?.chat ?? {}) as ChatQuirks),
      req,
      decodeChatStream,
    ),
})

const responses = (t?: number): ModelAdapter => ({
  ...common(t, '/responses', (model) => ({ model, stream: true, store: false, max_output_tokens: 16, input: 'hi' })),
  stream: (account, req) =>
    streamWire(
      joinUrl(account.baseUrl, '/responses'),
      openaiHeaders(account),
      buildResponsesBody(req, { store: false, includeEncryptedReasoning: true }),
      req,
      decodeResponsesStream,
    ),
})

export function createModelOpenai(opts: { probeTimeoutMs?: number } = {}): Plugin {
  return {
    manifest,
    activate(ctx) {
      const models = ctx.services.get<ModelsService>('models')!
      ctx.effect(models.registerAdapter('openai-chat', chat(opts.probeTimeoutMs)))
      ctx.effect(models.registerAdapter('openai-responses', responses(opts.probeTimeoutMs)))
    },
  }
}

export default createModelOpenai()
