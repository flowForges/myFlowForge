import { useState } from 'react'
import type { PresetView } from '@mffai/protocol'

/** 添加账号内联表单;受限套餐先确认,key 提交后立即清空 */
export function AddAccount({ presets, onDone }: { presets: PresetView[]; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [presetId, setPresetId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [flowId, setFlowId] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const api = window.forge.mffai
  const preset = presets.find(p => p.id === presetId) ?? presets[0]
  const fail = (e: unknown) => { console.error('mffai', e); setFailed(true) }

  const close = () => { setOpen(false); setApiKey(''); setBaseUrl(''); setConfirming(false); setFlowId(null) }
  const submit = (restrictionAck: boolean) => {
    const input = { presetId: preset.id, apiKey, ...(baseUrl && { baseUrl }), ...(restrictionAck && { restrictionAck: true }) }
    setApiKey('')
    setConfirming(false)
    setFailed(false)
    void api.models.addAccount(input).then(() => { close(); onDone() }).catch(fail)
  }
  const login = () => {
    setFailed(false)
    void api.chatgpt.begin().then(r => setFlowId(r.flowId)).catch(fail)
  }
  const cancel = () => {
    const id = flowId
    setFlowId(null)
    if (id) void api.chatgpt.cancel(id).catch(fail)
  }

  if (!open) return <button className="set-btn" onClick={() => setOpen(true)} disabled={!presets.length}>添加账号</button>
  if (confirming) {
    return (
      <div className="mffai-card" role="dialog">
        <div>此套餐仅限编程工具内使用</div>
        <div className="mffai-actions">
          <button className="set-btn" onClick={() => submit(true)}>继续</button>
          <button className="set-btn" onClick={() => setConfirming(false)}>取消</button>
        </div>
      </div>
    )
  }
  return (
    <div className="mffai-card">
      <select value={preset.id} onChange={e => { setPresetId(e.target.value); setFlowId(null) }}>
        {presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      {preset.auth === 'chatgpt-oauth' ? (
        <div className="mffai-actions">
          {flowId
            ? <button className="set-btn" onClick={cancel}>取消</button>
            : <button className="set-btn" onClick={login}>用 ChatGPT 登录</button>}
        </div>
      ) : (
        <>
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} />
          {preset.id.startsWith('custom-') && <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />}
          <div className="mffai-actions">
            <button className="set-btn" onClick={() => preset.restriction === 'coding-tools-only' ? setConfirming(true) : submit(false)}>添加</button>
            <button className="set-btn" onClick={close}>取消</button>
          </div>
        </>
      )}
      {failed && <span className="mffai-fail">失败</span>}
    </div>
  )
}
