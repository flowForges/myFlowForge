import type { ProviderInfo } from '@shared/types'

// 解析「当前选中模型」的上下文窗口：模型自带 > provider 默认 > 200k。
export function resolveContextWindow(
  provider: ProviderInfo | undefined,
  modelId: string,
  providerDefaults: Record<string, number>,
): number {
  const m = provider?.models.find(x => x.id === modelId)
  if (m?.contextWindow && m.contextWindow > 0) return m.contextWindow
  if (provider && providerDefaults[provider.id]) return providerDefaults[provider.id]
  return 200_000
}
