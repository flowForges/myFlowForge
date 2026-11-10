// 账号卡片(08b spec §2.3):Connections.tsx 里的账号行搬来,逻辑和处理函数原样,外观换成卡片。
import { useEffect, useState } from 'react'
import type { AccountState, AccountView, ModelEntry, PresetView, Quota } from '@mffai/protocol'
import { Icon } from '../shell/icons'
import { Chip } from '../ui/Chip'
import { presetTint } from '../ui/tint'

export const STATE_LABEL: Record<AccountState, string> = {
  ok: '可用', needs_login: '需要重新登录', not_authorized: '未授权套餐使用', quota_exhausted: '额度用尽', error: '出错',
}
const STATE_TONE = { ok: 'ok', needs_login: 'warn', not_authorized: 'warn', quota_exhausted: 'bad', error: 'bad' } as const

/** 每个窗口一行:名称、条、百分比。文字 `5h 42%` 另放一份给读屏和测试;条按 usedPercent 画(夹在 0–100) */
function QuotaView({ quota }: { quota: Quota }) {
  const open = (link: string) => void window.forge.mffai.openExternal(link).catch((e) => console.error('mffai', e))
  if ('link' in quota) return <button className="set-btn" onClick={() => open(quota.link)}>用量</button>
  return (
    <div className="mffai-qlist">
      {quota.windows.map((w) => {
        const width = Math.max(0, Math.min(100, w.usedPercent))
        return (
          <div key={w.label} className={`mffai-qrow${w.usedPercent > 80 ? ' warn' : ''}`}>
            <span className="mffai-qlabel" aria-hidden="true">{w.label}</span>
            <span className="mffai-qbar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.usedPercent}>
              <span className="mffai-qfill" style={{ width: `${width}%` }} />
            </span>
            <span className="mffai-qpct" aria-hidden="true">{`${w.usedPercent}%`}</span>
            <span className="mffai-sr mffai-quota">{`${w.label} ${w.usedPercent}%`}</span>
          </div>
        )
      })}
    </div>
  )
}

export function AccountCard({ account, preset, models, defaultModelId, isDefault, onChanged }: {
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
    <div className={`mffai-row mffai-acard${isDefault ? ' default' : ''}`} data-account={account.id}>
      <div className="mffai-acard-top">
        <span className={`mffai-alogo ${presetTint(account.presetId)}`} aria-hidden="true">{(preset?.label ?? account.label).slice(0, 1).toUpperCase()}</span>
        <div className="mffai-aid">
          <div className="mffai-aname">
            <span>{account.label}</span>
            {isDefault && <Chip tone="acc"><Icon name="star" />默认</Chip>}
          </div>
          <div className="mffai-achips">
            {preset?.label && <Chip tone="line">{preset.label}</Chip>}
            <Chip tone={STATE_TONE[account.state]}>{STATE_LABEL[account.state]}</Chip>
            {restricted && <Chip tone="warn">限编程工具</Chip>}
          </div>
        </div>
        <div className="mffai-aact">
          <button className="set-btn" onClick={() => act(m.testAccount(account.id), true)}>测试</button>
          <button className="set-btn mffai-iconbtn mffai-danger" onClick={() => act(m.removeAccount(account.id), true)}>
            <Icon name="trash" size={14} /><span className="mffai-sr">删除</span>
          </button>
        </div>
      </div>
      {quota && <QuotaView quota={quota} />}
      <div className="mffai-amodel">
        <span className="mffai-k">默认模型</span>
        {models.length > 1 ? (
          <select aria-label="默认模型" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {models.map((mo) => <option key={mo.id} value={mo.id}>{mo.name}</option>)}
          </select>
        ) : models[0] && <span className="mffai-model">{models[0].name}</span>}
        <button className="set-btn" disabled={isDefault || !modelId} onClick={() => act(m.setDefault(account.id, modelId), true)}>设为默认</button>
        {failed && <span className="mffai-fail">失败</span>}
      </div>
    </div>
  )
}
