import { useCallback, useEffect, useState } from 'react'
import type { AccountView, CatalogView, SecretsBackend } from '@mffai/protocol'

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
