import { useEffect, useState } from 'react'
import type { AccountState, AccountView, PresetView, Quota } from '@mffai/protocol'
import { AddAccount } from './AddAccount'
import { useModels } from './useModels'

const STATE_LABEL: Record<AccountState, string> = {
  ok: '可用', needs_login: '需要重新登录', not_authorized: '未授权套餐使用', quota_exhausted: '额度用尽', error: '出错',
}

function QuotaView({ quota }: { quota: Quota }) {
  const open = (link: string) => void window.forge.mffai.openExternal(link).catch((e) => console.error('mffai', e))
  if ('link' in quota) return <button className="set-btn" onClick={() => open(quota.link)}>用量</button>
  return <>{quota.windows.map(w => <span key={w.label} className="mffai-quota">{`${w.label} ${w.usedPercent}%`}</span>)}</>
}

function AccountRow({ account, preset, modelId, isDefault, onChanged }: {
  account: AccountView; preset?: PresetView; modelId?: string; isDefault: boolean; onChanged: () => void
}) {
  const [quota, setQuota] = useState<Quota | null>(null)
  const [failed, setFailed] = useState(false)
  const m = window.forge.mffai.models
  useEffect(() => {
    let alive = true
    void m.quota(account.id).then(q => { if (alive) setQuota(q) }).catch((e) => console.error('mffai quota', e))
    return () => { alive = false }
  }, [m, account.id, account.state])
  const act = (p: Promise<unknown>, reload: boolean) => {
    setFailed(false)
    void p.then(() => { if (reload) onChanged() }).catch((e) => { console.error('mffai', e); setFailed(true) })
  }
  return (
    <div className="mffai-row">
      <span>{account.label}</span>
      <span className="mffai-k">{preset?.label}</span>
      <span>{STATE_LABEL[account.state]}</span>
      {preset?.restriction === 'coding-tools-only' && <span className="mffai-badge">限编程工具</span>}
      {quota && <QuotaView quota={quota} />}
      <button className="set-btn" onClick={() => act(m.testAccount(account.id), true)}>测试</button>
      <button className="set-btn" onClick={() => act(m.removeAccount(account.id), true)}>删除</button>
      <button className="set-btn" disabled={isDefault || !modelId} onClick={() => act(m.setDefault(account.id, modelId!), true)}>设为默认</button>
      {failed && <span className="mffai-fail">失败</span>}
    </div>
  )
}

export function Connections() {
  const { catalog, accounts, backend, reload } = useModels()
  return (
    <div className="mffai-conn">
      {backend === 'plaintext-file' && <span className="mffai-badge">明文存储</span>}
      {accounts.map(a => (
        <AccountRow key={a.id} account={a} preset={catalog?.presets.find(p => p.id === a.presetId)}
          modelId={(catalog?.models[a.presetId] ?? a.models)?.[0]?.id}
          isDefault={catalog?.default?.accountId === a.id} onChanged={reload} />
      ))}
      <AddAccount presets={catalog?.presets ?? []} onDone={reload} />
    </div>
  )
}
