import { useEffect, useRef, useState } from 'react'
import type { AccountState, AccountView, ModelEntry, PresetView, Quota } from '@mffai/protocol'
import { AddAccount } from './AddAccount'
import { modelsOf, useModels } from './useModels'

const STATE_LABEL: Record<AccountState, string> = {
  ok: '可用', needs_login: '需要重新登录', not_authorized: '未授权套餐使用', quota_exhausted: '额度用尽', error: '出错',
}

function QuotaView({ quota }: { quota: Quota }) {
  const open = (link: string) => void window.forge.mffai.openExternal(link).catch((e) => console.error('mffai', e))
  if ('link' in quota) return <button className="set-btn" onClick={() => open(quota.link)}>用量</button>
  return <>{quota.windows.map(w => <span key={w.label} className="mffai-quota">{`${w.label} ${w.usedPercent}%`}</span>)}</>
}

function AccountRow({ account, preset, models, defaultModelId, isDefault, onChanged }: {
  account: AccountView; preset?: PresetView; models: ModelEntry[]; defaultModelId?: string; isDefault: boolean; onChanged: () => void
}) {
  const [quota, setQuota] = useState<Quota | null>(null)
  const [failed, setFailed] = useState(false)
  // 02 Task 13:默认模型下拉不再固定用第一个模型;默认账号拿目录的默认模型,其余账号退到自己清单的第一个
  const [modelId, setModelId] = useState(() => (isDefault && defaultModelId) || models[0]?.id || '')
  const m = window.forge.mffai.models
  useEffect(() => {
    let alive = true
    void m.quota(account.id).then(q => { if (alive) setQuota(q) }).catch((e) => console.error('mffai quota', e))
    return () => { alive = false }
  }, [m, account.id, account.state])
  // 模型清单变了(账号重测、目录刷新)而当前选的模型没了:退回默认 / 第一个
  useEffect(() => {
    if (models.some((mo) => mo.id === modelId)) return
    setModelId((isDefault && defaultModelId) || models[0]?.id || '')
  }, [models]) // eslint-disable-line react-hooks/exhaustive-deps
  const act = (p: Promise<unknown>, reload: boolean) => {
    setFailed(false)
    void p.then(() => { if (reload) onChanged() }).catch((e) => { console.error('mffai', e); setFailed(true) })
  }
  // 账号自己标的限制(自定义预设)比预设的优先(08 §4.7,和后台 restrictionOf 同一条规则)
  const restricted = (account.restriction ?? preset?.restriction) === 'coding-tools-only'
  return (
    <div className="mffai-row">
      <span>{account.label}</span>
      <span className="mffai-k">{preset?.label}</span>
      <span>{STATE_LABEL[account.state]}</span>
      {restricted && <span className="mffai-badge">限编程工具</span>}
      {quota && <QuotaView quota={quota} />}
      <button className="set-btn" onClick={() => act(m.testAccount(account.id), true)}>测试</button>
      <button className="set-btn" onClick={() => act(m.removeAccount(account.id), true)}>删除</button>
      {models.length > 1 ? (
        <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
          {models.map((mo) => <option key={mo.id} value={mo.id}>{mo.name}</option>)}
        </select>
      ) : models[0] && <span className="mffai-model">{models[0].name}</span>}
      <button className="set-btn" disabled={isDefault || !modelId} onClick={() => act(m.setDefault(account.id, modelId), true)}>设为默认</button>
      {failed && <span className="mffai-fail">失败</span>}
    </div>
  )
}

/** auth.chatgpt.begin 不带账号 id,重登的是第一个坏掉的 ChatGPT 账号:只给一个按钮,在账号列表上面 */
function Relogin() {
  const [loggingIn, setLoggingIn] = useState(false)
  const [failed, setFailed] = useState(false)
  const loginRef = useRef(false)
  const relogin = () => {
    if (loginRef.current) return
    loginRef.current = true
    setFailed(false)
    setLoggingIn(true)
    void window.forge.mffai.chatgpt.begin()
      .catch((e) => { console.error('mffai', e); setFailed(true) })
      .finally(() => { loginRef.current = false; setLoggingIn(false) })
  }
  return (
    <div className="mffai-actions">
      <button className="set-btn" disabled={loggingIn} onClick={relogin}>重新登录</button>
      {failed && <span className="mffai-fail">失败</span>}
    </div>
  )
}

export function Connections() {
  const { catalog, accounts, backend, reload } = useModels()
  const needsLogin = accounts.some((a) => a.state === 'needs_login' && catalog?.presets.find((p) => p.id === a.presetId)?.auth === 'chatgpt-oauth')
  return (
    <div className="mffai-conn">
      {backend === 'plaintext-file' && <span className="mffai-badge">明文存储</span>}
      {(backend === 'unavailable' || backend === 'unreadable') && <span className="mffai-badge">钥匙串不可用</span>}
      {needsLogin && <Relogin />}
      {accounts.map((a) => {
        const isDefault = catalog?.default?.accountId === a.id
        return (
          <AccountRow key={a.id} account={a} preset={catalog?.presets.find((p) => p.id === a.presetId)}
            models={modelsOf(catalog, a)} defaultModelId={isDefault ? catalog?.default?.modelId : undefined}
            isDefault={isDefault} onChanged={reload} />
        )
      })}
      <AddAccount presets={catalog?.presets ?? []} onDone={reload} />
    </div>
  )
}
