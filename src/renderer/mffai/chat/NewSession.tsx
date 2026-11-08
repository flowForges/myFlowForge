// 新会话表单(08 §7.3),就在对话区里。模型:ModelPicker,没有账号就是 AddAccount;工作目录:PathField;
// 编辑工具和 auto 开关只在填了目录时出现;沙箱 none 且不许无沙箱自动放行时,开关旁一个 需审批。
// session.create 从不带 origin(宿主也会剥掉,这里不给)。
import { useEffect, useRef, useState } from 'react'
import type { ModelRef, Toolset } from '@mffai/protocol'
import { ModelPicker } from '../ModelPicker'
import { AddAccount } from '../AddAccount'
import { useModels } from '../useModels'
import { call, retryable } from '../rpc'
import { PathField } from '../ui/PathField'
import { AutoSwitch } from '../ui/AutoSwitch'
import { Chip } from '../ui/Chip'

const TOOLSETS: readonly { value: '' | Toolset; text: string }[] = [
  { value: '', text: '自动' },
  { value: 'patch', text: 'apply_patch' },
  { value: 'edit', text: 'edit' },
]

export function NewSession({ onCreated, initial }: { onCreated: (sessionId: string) => void; initial?: { cwd?: string } }) {
  const { catalog, accounts, reload } = useModels()
  const [model, setModel] = useState<ModelRef | undefined>()
  const [cwd, setCwd] = useState(initial?.cwd ?? '')
  const [toolset, setToolset] = useState<'' | Toolset>('')
  const [auto, setAuto] = useState(false)
  const [mustAsk, setMustAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const retry = useRef(retryable()).current
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    void call('permissions.get', {}).then(
      (r) => { if (alive.current) setMustAsk(r.sandbox.level === 'none' && !r.config.allowUnsandboxedAuto) },
      () => {},
    )
  }, [])

  const dir = cwd.trim()
  const noAccounts = !!catalog && accounts.length === 0

  const start = async () => {
    if (!model || busy) return
    const params = {
      model,
      ...(dir && { cwd: dir, approvalMode: auto ? ('auto' as const) : ('ask' as const), ...(toolset && { toolset }) }),
    }
    const key = JSON.stringify(params)
    setBusy(true)
    setFailed(false)
    try {
      const r = await call('session.create', { commandId: retry.id(key), ...params })
      retry.done(key)
      if (alive.current) onCreated(r.sessionId)
    } catch (e) {
      console.error('mffai session.create', e)
      if (alive.current) setFailed(true)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <div className="mffai-card mffai-newsess">
      <div className="mffai-row">
        <span className="mffai-k">模型</span>
        {noAccounts ? <AddAccount presets={catalog.presets} onDone={reload} /> : <ModelPicker value={model} onChange={setModel} />}
      </div>
      <div className="mffai-row">
        <span className="mffai-k">工作目录</span>
        <PathField value={cwd} onChange={setCwd} kind="directory" label="工作目录" />
      </div>
      {dir && (
        <>
          <div className="mffai-row">
            <span className="mffai-k">编辑工具</span>
            <select className="mffai-picker" aria-label="编辑工具" value={toolset} onChange={(e) => setToolset(e.target.value as '' | Toolset)}>
              {TOOLSETS.map((t) => <option key={t.value} value={t.value}>{t.text}</option>)}
            </select>
          </div>
          <div className="mffai-row">
            <span className="mffai-k">审批</span>
            <AutoSwitch checked={auto} onChange={setAuto} />
            {mustAsk && <Chip tone="warn">需审批</Chip>}
          </div>
        </>
      )}
      <div className="mffai-actions">
        <button className="set-btn mffai-primary" disabled={!model || busy} onClick={() => void start()}>开始</button>
        {failed && <span className="mffai-fail">失败</span>}
      </div>
    </div>
  )
}
