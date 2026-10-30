import { useEffect, useRef, useState } from 'react'
import type { PresetView } from '@mffai/protocol'

/** 添加账号内联表单;受限套餐先确认,key 提交后立即清空 */
export function AddAccount({ presets, onDone }: { presets: PresetView[]; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [presetId, setPresetId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [flowId, setFlowId] = useState<string | null>(null)
  const flowRef = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const api = window.forge.mffai
  const preset: PresetView | undefined = presets.find(p => p.id === presetId) ?? presets[0]
  const fail = (e: unknown) => { console.error('mffai', e); setFailed(true) }

  const setFlow = (id: string | null) => { flowRef.current = id; setFlowId(id) }
  // 释放挂起的登录流(回环回调监听);只会对同一 flow 取消一次
  const cancelFlow = () => {
    const id = flowRef.current
    if (!id) return
    setFlow(null)
    void api.chatgpt.cancel(id).catch(fail)
  }
  useEffect(() => () => {
    const id = flowRef.current
    if (id) void window.forge.mffai.chatgpt.cancel(id).catch((e) => console.error('mffai', e))
  }, [])
  // 登录完成:account.updated 到来时收起表单(流已结束,无需取消)
  useEffect(() => {
    if (!flowId) return
    return api.onEvent((e) => {
      if (e.type !== 'account.updated' || !flowRef.current) return
      setFlow(null); setOpen(false); onDone()
    })
  }, [flowId]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { cancelFlow(); setOpen(false); setApiKey(''); setBaseUrl(''); setConfirming(false) }
  const submit = (restrictionAck: boolean) => {
    if (!preset || busy) return
    const input = { presetId: preset.id, apiKey, ...(baseUrl && { baseUrl }), ...(restrictionAck && { restrictionAck: true }) }
    setApiKey('')
    setConfirming(false)
    setFailed(false)
    setBusy(true)
    void api.models.addAccount(input).then(() => { close(); onDone() }).catch(fail).finally(() => setBusy(false))
  }
  const login = () => {
    setFailed(false)
    void api.chatgpt.begin().then(r => setFlow(r.flowId)).catch(fail)
  }

  if (!open) return <button className="set-btn" onClick={() => setOpen(true)} disabled={!presets.length}>添加账号</button>
  if (confirming) {
    return (
      <div className="mffai-card" role="dialog" aria-labelledby="mffai-restrict-title">
        <div id="mffai-restrict-title">此套餐仅限编程工具内使用</div>
        <div className="mffai-actions">
          <button className="set-btn" disabled={busy} onClick={() => submit(true)}>继续</button>
          <button className="set-btn" onClick={() => setConfirming(false)}>取消</button>
        </div>
      </div>
    )
  }
  return (
    <div className="mffai-card">
      <select value={preset?.id ?? ''} onChange={e => { cancelFlow(); setPresetId(e.target.value) }}>
        {presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      {preset?.auth === 'chatgpt-oauth' ? (
        <div className="mffai-actions">
          {flowId
            ? <button className="set-btn" onClick={cancelFlow}>取消</button>
            : <button className="set-btn" onClick={login}>用 ChatGPT 登录</button>}
        </div>
      ) : (
        <>
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} />
          {preset?.id.startsWith('custom-') && <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />}
          <div className="mffai-actions">
            <button className="set-btn" disabled={!preset || busy} onClick={() => preset?.restriction === 'coding-tools-only' ? setConfirming(true) : submit(false)}>添加</button>
            <button className="set-btn" onClick={close}>取消</button>
          </div>
        </>
      )}
      {failed && <span className="mffai-fail">失败</span>}
    </div>
  )
}
