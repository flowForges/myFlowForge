// model-anthropic:anthropic 协议适配器(spec §6.3);兼容厂商的 baseUrl 一律追加 /v1/messages
import type { Plugin } from '../../kernel/pluginHost'
import { manifest } from './manifest'
import { buildAnthropicBody, decodeAnthropicStream, type AnthropicQuirks } from '../../lib/models/anthropic'
import type { Account, ModelAdapter, ModelsService } from '../../lib/models/types'
import { anthropicAuth, anthropicHeaders, getJson, joinUrl, modelIds, probeWithTinyStream, streamWire } from '../../lib/models/wire'

const modelsUrl = (a: Account) => joinUrl(a.baseUrl, '/v1/models')

const makeAdapter = (probeTimeoutMs?: number): ModelAdapter => ({
  stream: (account, req) =>
    streamWire(
      joinUrl(account.baseUrl, '/v1/messages'),
      anthropicHeaders(account),
      buildAnthropicBody(req, (account.quirks?.anthropic ?? {}) as AnthropicQuirks),
      req,
      decodeAnthropicStream,
    ),

  async test(account) {
    const r = await getJson(modelsUrl(account), anthropicAuth(account), { tolerate404: true })
    if (r !== undefined) return
    // 许多兼容厂商没有 /v1/models:退回 1 token 的流式请求
    const body = { model: account.testModel ?? 'claude-haiku-4-5', max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'hi' }] }
    await probeWithTinyStream(joinUrl(account.baseUrl, '/v1/messages'), anthropicHeaders(account), body, probeTimeoutMs)
  },

  async listModels(account) {
    return modelIds(await getJson(modelsUrl(account), anthropicAuth(account)))
  },
})

export function createModelAnthropic(opts: { probeTimeoutMs?: number } = {}): Plugin {
  return {
    manifest,
    activate(ctx) {
      ctx.effect(ctx.services.get<ModelsService>('models')!.registerAdapter('anthropic', makeAdapter(opts.probeTimeoutMs)))
    },
  }
}

export default createModelAnthropic()
