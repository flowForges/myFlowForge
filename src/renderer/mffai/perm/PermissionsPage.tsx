// 权限页(08 §11):本地草稿(规则、联网名单、三个开关),保存前不发。permissions.updated 到了,草稿干净就
// 重取;脏草稿不覆盖,换成「已在别处修改 · 重新载入」按钮。permissions.set 的 invalid rules 按 index 标红
// 对应行,其余行的文字不受影响(草稿本身没变,只是多了一份错误表)。会话选择器重取带 sessionId 的默认规则和
// 沙箱状态。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PermissionsConfig, RuleError, SandboxStatus } from '@mffai/protocol'
import { call, isUnsupported, retryable, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { useSessions } from '../chat/useSessions'
import { label as codeLabel } from '../labels'
import { AutoSwitch, UNSANDBOXED_AUTO_LABEL } from '../ui/AutoSwitch'
import { Chip, type ChipTone } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { RuleEditor } from './RuleEditor'
import { TagInput } from './TagInput'

const LEVEL_TONE: Record<SandboxStatus['level'], ChipTone> = { full: 'ok', partial: 'warn', none: 'bad' }
type SaveFailure = 'unsupported' | 'failed'

export default function PermissionsPage() {
  const [sessionId, setSessionId] = useState('')
  const { sessions } = useSessions()
  const [draft, setDraft] = useState<PermissionsConfig | null>(null)
  const [defaults, setDefaults] = useState<string[]>([])
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState<'unsupported' | 'failed' | null>(null)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<number, RuleError>>(new Map())
  const [fieldErrors, setFieldErrors] = useState<readonly RuleError[]>([])
  const [busy, setBusy] = useState(false)
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null)
  const retry = useRef(retryable()).current
  const inflight = useRef(false)
  const alive = useRef(true)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(() => {
    void call('permissions.get', sessionId ? { sessionId } : {}).then(
      (r) => {
        if (!alive.current) return
        setDraft(r.config)
        setDefaults(r.defaults)
        setSandbox(r.sandbox)
        setLoadFailed(null)
        setDirty(false)
        setConflict(false)
        setRowErrors(new Map())
        setFieldErrors([])
        setSaveFailure(null)
      },
      (e) => {
        if (!alive.current) return
        console.error('mffai permissions.get', toCallError(e).code)
        setLoadFailed(isUnsupported(e) ? 'unsupported' : 'failed')
      },
    )
  }, [sessionId])
  useEffect(load, [load])

  useMffaiEvent({ types: ['permissions.updated'] }, () => {
    if (dirtyRef.current) setConflict(true)
    else load()
  })
  useMffaiReset(load)

  const edit = (patch: Partial<PermissionsConfig>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d))
    setDirty(true)
  }

  const save = async () => {
    if (!draft || inflight.current) return
    const key = JSON.stringify(draft)
    inflight.current = true
    setBusy(true)
    setSaveFailure(null)
    setRowErrors(new Map())
    setFieldErrors([])
    try {
      await call('permissions.set', { commandId: retry.id(key), config: draft })
      retry.done(key)
      if (!alive.current) return
      setDirty(false)
      load()
    } catch (e) {
      const c = toCallError(e)
      console.error('mffai permissions.set', c.code)
      if (!alive.current) return
      if (isUnsupported(c)) { setSaveFailure('unsupported'); return }
      if (Array.isArray(c.data)) {
        const rowMap = new Map<number, RuleError>()
        const fields: RuleError[] = []
        for (const err of c.data as RuleError[]) (err.index >= 0 ? rowMap.set(err.index, err) : fields.push(err))
        setRowErrors(rowMap)
        setFieldErrors(fields)
        return
      }
      setSaveFailure('failed')
    } finally {
      inflight.current = false
      if (alive.current) setBusy(false)
    }
  }

  if (loadFailed === 'unsupported') return <div className="mffai-pane mffai-perm"><Chip tone="bad">不支持</Chip></div>

  return (
    <div className="mffai-pane mffai-perm">
      <div className="mffai-row">
        <span className="mffai-k">会话</span>
        <select aria-label="会话" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
          <option value="">默认</option>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || s.id}</option>)}
        </select>
      </div>
      {loadFailed === 'failed' && <span className="mffai-fail">失败</span>}
      {sandbox && (
        <div className="mffai-row">
          <Chip tone={LEVEL_TONE[sandbox.level] ?? 'muted'}>{codeLabel('level', sandbox.level)}</Chip>
          {sandbox.missing.map((m) => <CodeChip key={m} code={m} />)}
        </div>
      )}
      {draft && (
        <>
          <div className="mffai-row">
            <label className="mffai-switch">
              <input type="checkbox" role="switch" checked={draft.sandbox.enabled}
                onChange={(e) => edit({ sandbox: { ...draft.sandbox, enabled: e.target.checked } })} />
              沙箱
            </label>
            <label className="mffai-switch">
              <input type="checkbox" role="switch" checked={draft.sandbox.allowLoopback}
                onChange={(e) => edit({ sandbox: { ...draft.sandbox, allowLoopback: e.target.checked } })} />
              允许本机回环
            </label>
            <AutoSwitch checked={draft.allowUnsandboxedAuto} label={UNSANDBOXED_AUTO_LABEL}
              onChange={(v) => edit({ allowUnsandboxedAuto: v })} />
          </div>
          <div className="mffai-group">
            <div className="mffai-grouphead"><span>规则</span></div>
            <RuleEditor rules={draft.rules} errors={rowErrors} onChange={(rules) => edit({ rules })} />
          </div>
          <div className="mffai-group">
            <div className="mffai-grouphead"><span>默认规则</span></div>
            <ul className="mffai-defaults" data-testid="mffai-perm-defaults">
              {defaults.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          </div>
          <div className="mffai-group">
            <div className="mffai-grouphead"><span>联网名单</span></div>
            <TagInput label="联网名单" value={draft.network.allow} onChange={(allow) => edit({ network: { allow } })} />
          </div>
          <div className="mffai-actions">
            {conflict ? (
              <button className="set-btn" onClick={load}>已在别处修改 · 重新载入</button>
            ) : (
              <button className="set-btn mffai-primary" disabled={!dirty || busy} onClick={() => void save()}>保存</button>
            )}
            {fieldErrors.map((e, i) => <CodeChip key={i} code={e.reason} title={e.rule} />)}
            {saveFailure === 'unsupported' && <Chip tone="bad">不支持</Chip>}
            {saveFailure === 'failed' && <span className="mffai-fail">失败</span>}
          </div>
        </>
      )}
    </div>
  )
}
