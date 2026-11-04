// 后台模型、预算、额度和单并发队列(06 spec §13)。这里管用户账号上的花费:
// 拿不准就不调用,任何一道闸判不了都按"不花钱"处理
import type { MemoryConfig } from '../../lib/memory/types'
import type { ModelsService } from '../../lib/models/types'
import type { AccountView, ModelEntry, ModelRef, PresetView } from '../../protocol/models'

const MIN_CONTEXT = 16_000
// 前面不能是字母:否则 gemini 算 mini,elite 算 lite
const CHEAP_ID = /(?:^|[^a-z])(?:mini|lite|flash|haiku|nano|small|spark)/i

type ModelsView = Pick<ModelsService, 'catalog' | 'accounts'>
export type BackgroundNone = 'no_model' | 'restricted' | 'unknown_subscription'

function accountOf(models: ModelsView, accountId: string): { preset: PresetView; list: ModelEntry[] } | undefined {
  const account: AccountView | undefined = models.accounts().find(a => a.id === accountId)
  if (!account) return undefined
  const catalog = models.catalog()
  const preset = catalog.presets.find(p => p.id === account.presetId)
  if (!preset) return undefined
  // 和 registry 的 modelsOf 同样的优先级
  const listed = catalog.models[account.presetId]
  return { preset, list: listed?.length ? listed : (account.models ?? []) }
}

export function pickBackground(models: ModelsView, cfg: MemoryConfig, sessionRef?: ModelRef): { ref: ModelRef } | { none: BackgroundNone } {
  if (cfg.backgroundModel) {
    const explicit = accountOf(models, cfg.backgroundModel.accountId)
    if (!explicit) return { none: 'no_model' }
    if (explicit.preset.restriction === 'coding-tools-only') return { none: 'restricted' }
    return { ref: cfg.backgroundModel }
  }
  // 不跨账号:对话不悄悄发给另一家
  const base = sessionRef ?? models.catalog().default
  if (!base) return { none: 'no_model' }
  const account = accountOf(models, base.accountId)
  if (!account) return { none: 'no_model' }
  const { preset, list } = account
  if (preset.restriction === 'coding-tools-only') return { none: 'restricted' }
  if (preset.restriction === 'unknown' && preset.billing !== 'metered') return { none: 'unknown_subscription' }

  const usable = (m: ModelEntry) => !m.deprecated && m.context >= MIN_CONTEXT
  const candidates = list.filter(usable)
  const costOf = (m: ModelEntry) => m.cost?.input ?? Infinity
  const cheapest = candidates.filter(m => m.cost).sort((a, b) => costOf(a) - costOf(b))[0]
  const chosen = cheapest ?? candidates.find(m => CHEAP_ID.test(m.id))
  if (chosen) return { ref: { accountId: base.accountId, modelId: chosen.id } }
  const current = list.find(m => m.id === base.modelId)
  return current && !usable(current) ? { none: 'no_model' } : { ref: base }
}
