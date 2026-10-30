// model-anthropic:anthropic 协议适配器(spec §6.3);兼容厂商的 baseUrl 一律追加 /v1/messages
import type { Plugin } from '../../kernel/pluginHost'
import { manifest } from './manifest'
import { buildAnthropicBody, decodeAnthropicStream, type AnthropicQuirks } from '../../lib/models/anthropic'
import { postStream } from '../../lib/models/http'
import type { Account, ModelAdapter, ModelsService } from '../../lib/models/types'
import { anthropicHeaders, getJson, joinUrl, modelIds, streamWire } from '../../lib/models/wire'

const keyOnly = (a: Account): Record<string, string> => ({ 'anthropic-version': '2023-06-01', ...(a.apiKey && { 'x-api-key': a.apiKey }) })
const modelsUrl = (a: Account) => joinUrl(a.baseUrl, '/v1/models')

const adapter: ModelAdapter = {
  stream: (account, req) =>
    streamWire(
      joinUrl(account.baseUrl, '/v1/messages'),
      anthropicHeaders(account),
      buildAnthropicBody(req, (account.quirks?.anthropic ?? {}) as AnthropicQuirks),
      req,
      decodeAnthropicStream,
    ),

  async test(account) {
    const r = await getJson(modelsUrl(account), keyOnly(account), { tolerate404: true })
    if (r !== undefined) return
    // 许多兼容厂商没有 /v1/models:退回 1 token 的流式请求,读到首块就中止
    const ac = new AbortController()
    const body = { model: 'test', max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'hi' }] }
    const res = await postStream(joinUrl(account.baseUrl, '/v1/messages'), {
      headers: anthropicHeaders(account),
      body: JSON.stringify(body),
      signal: ac.signal,
      timeoutMs: 30_000,
    })
    try { await res.body?.getReader().read() } catch { /* 已拿到 2xx */ }
    ac.abort()
    res.body?.cancel().catch(() => {})
  },

  async listModels(account) {
    return modelIds(await getJson(modelsUrl(account), keyOnly(account)))
  },
}

const modelAnthropic: Plugin = {
  manifest,
  activate(ctx) {
    ctx.effect(ctx.services.get<ModelsService>('models')!.registerAdapter('anthropic', adapter))
  },
}

export default modelAnthropic
