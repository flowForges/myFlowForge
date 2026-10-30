import { useEffect, useMemo } from 'react'
import type { ModelRef } from '@mffai/protocol'
import { useModels } from './useModels'

const SEP = '\u0000'

/** 账号 × 模型下拉;无账号时隐藏并上报 undefined */
export function ModelPicker({ value, onChange }: { value: ModelRef | undefined; onChange: (m: ModelRef | undefined) => void }) {
  const { catalog, accounts } = useModels()
  const options = useMemo(() => accounts.flatMap(a =>
    (catalog?.models[a.presetId] ?? a.models ?? []).map(m => ({ key: a.id + SEP + m.id, ref: { accountId: a.id, modelId: m.id }, text: `${a.label} / ${m.name}` }))
  ), [catalog, accounts])

  useEffect(() => {
    if (!catalog) return
    const has = (r?: ModelRef) => !!r && options.some(o => o.key === r.accountId + SEP + r.modelId)
    if (has(value)) return
    onChange(has(catalog.default) ? catalog.default : options[0]?.ref)
  }, [catalog, options]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!options.length) return null
  return (
    <select className="mffai-picker" value={value ? value.accountId + SEP + value.modelId : ''}
      onChange={e => onChange(options.find(o => o.key === e.target.value)?.ref)}>
      {options.map(o => <option key={o.key} value={o.key}>{o.text}</option>)}
    </select>
  )
}
