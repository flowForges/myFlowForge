// 模型的上下文窗口:两个循环都要,插件之间又不能互相 import
import type { ModelRef } from '../../protocol/models'
import type { ModelsService } from './types'

export const DEFAULT_CONTEXT = 128_000

/** 模型上下文:账号自己的模型清单优先,其次目录里该预设的模型,缺省 128 000 */
export function contextWindow(models: Pick<ModelsService, 'catalog' | 'accounts'>, ref: ModelRef | 'default'): number {
  const concrete = ref === 'default' ? models.catalog().default : ref
  if (!concrete) return DEFAULT_CONTEXT
  const acc = models.accounts().find(a => a.id === concrete.accountId)
  if (!acc) return DEFAULT_CONTEXT
  const entry = acc.models?.find(m => m.id === concrete.modelId) ?? models.catalog().models[acc.presetId]?.find(m => m.id === concrete.modelId)
  return entry && entry.context > 0 ? entry.context : DEFAULT_CONTEXT
}
