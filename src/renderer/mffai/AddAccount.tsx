import { useEffect, useRef, useState } from 'react'
import type { ChatgptEndedPayload, PresetView } from '@mffai/protocol'

/** 添加账号内联表单;受限套餐先确认,key 提交后立即清空 */
export function AddAccount({ presets, onDone }: { presets: PresetView[]; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [presetId, setPresetId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [flowId, setFlowId] = useState<string | null>(null)
  const flowRef = useRef<string | null>(null)
  /** 每次开始登录 +1;取消 / 换套餐 / 卸载也 +1:晚到的 begin 结果对不上号 → 立即取消,不留回环监听 */
  const loginGen = useRef(0)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const api = window.forge.mffai
  const preset: PresetView | undefined = presets.find(p => p.id === presetId) ?? presets[0]
  const fail = (e: unknown) => { console.error('mffai', e); setFailed(true) }

  const setFlow = (id: string | null) => { flowRef.current = id; setFlowId(id) }
  // 释放挂起的登录流(回环回调监听);只会对同一 flow 取消一次
  const cancelFlow = () => {
    loginGen.current++
    const id = flowRef.current
    if (!id) return
    setFlow(null)
    void api.chatgpt.cancel(id).catch(fail)
  }
  useEffect(() => () => {
    loginGen.current++
    const id = flowRef.current
    if (id) void window.forge.mffai.chatgpt.cancel(id).catch((e) => console.error('mffai', e))
  }, [])
  // 只认本表单这个 flow 的 auth.chatgpt.ended:成功收起表单,失败留在表单上显示失败(流已结束,无需取消)
  useEffect(() => {
    if (!flowId) return
    return api.onEvent((e) => {
      if (e.type !== 'auth.chatgpt.ended') return
      const p = e.payload as Partial<ChatgptEndedPayload> | undefined
      if (!p || p.flowId !== flowRef.current) return
      setFlow(null)
      if (p.ok) { setOpen(false); onDone() } else setFailed(true)
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
    const gen = ++loginGen.current
    void api.chatgpt.begin().then(r => {
      if (gen === loginGen.current) return setFlow(r.flowId)
      void api.chatgpt.cancel(r.flowId).catch((e) => console.error('mffai', e))
    }).catch((e) => { if (gen === loginGen.current) fail(e) })
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
