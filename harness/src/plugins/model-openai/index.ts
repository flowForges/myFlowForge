// model-openai:openai-chat 与 openai-responses 两个协议适配器(spec §6.2)
import type { Plugin } from '../../kernel/pluginHost'
import { manifest } from './manifest'
import { buildChatBody, decodeChatStream, type ChatQuirks } from '../../lib/models/chat'
import { buildResponsesBody, decodeResponsesStream } from '../../lib/models/responses'
import type { Account, ModelAdapter, ModelsService } from '../../lib/models/types'
import { getJson, joinUrl, modelIds, openaiHeaders, streamWire } from '../../lib/models/wire'

const authOnly = (a: Account) => ({ ...(a.apiKey && { authorization: `Bearer ${a.apiKey}` }) })

const common = {
  async test(account: Account) {
    await getJson(joinUrl(account.baseUrl, '/models'), authOnly(account))
  },
  async listModels(account: Account) {
    return modelIds(await getJson(joinUrl(account.baseUrl, '/models'), authOnly(account)))
  },
}

const chat: ModelAdapter = {
  ...common,
  stream: (account, req) =>
    streamWire(
      joinUrl(account.baseUrl, '/chat/completions'),
      openaiHeaders(account),
      buildChatBody(req, (account.quirks?.chat ?? {}) as ChatQuirks),
      req,
      decodeChatStream,
    ),
}

const responses: ModelAdapter = {
  ...common,
  stream: (account, req) =>
    streamWire(
      joinUrl(account.baseUrl, '/responses'),
      openaiHeaders(account),
      buildResponsesBody(req, { store: false, includeEncryptedReasoning: true }),
      req,
      decodeResponsesStream,
    ),
}

const modelOpenai: Plugin = {
  manifest,
  activate(ctx) {
    const models = ctx.services.get<ModelsService>('models')!
    ctx.effect(models.registerAdapter('openai-chat', chat))
    ctx.effect(models.registerAdapter('openai-responses', responses))
  },
}

export default modelOpenai
