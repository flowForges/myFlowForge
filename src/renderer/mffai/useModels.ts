import { useCallback, useEffect, useState } from 'react'
import type { AccountView, CatalogView, ModelEntry, SecretsBackend } from '@mffai/protocol'

/** 账号可选的模型:目录(预设)清单非空时用它,否则用账号上列出 / 手填的清单 */
export function modelsOf(catalog: CatalogView | null, a: AccountView): ModelEntry[] {
  const c = catalog?.models[a.presetId]
  return c?.length ? c : a.models ?? []
}

export interface ModelsData { catalog: CatalogView | null; accounts: AccountView[]; backend: SecretsBackend | null }

/** 加载 catalog + accounts;挂载、account.updated、手动 reload 时刷新 */
export function useModels(): ModelsData & { reload: () => void } {
  const [data, setData] = useState<ModelsData>({ catalog: null, accounts: [], backend: null })
  const reload = useCallback(() => {
    const m = window.forge.mffai.models
    void Promise.all([m.catalog(), m.accounts()])
      .then(([catalog, a]) => setData({ catalog, accounts: a.accounts, backend: a.secretsBackend }))
      .catch((e) => console.error('mffai models', e))
  }, [])
  useEffect(() => {
    reload()
    return window.forge.mffai.onEvent((e) => { if (e.type === 'account.updated') reload() })
  }, [reload])
  return { ...data, reload }
}
