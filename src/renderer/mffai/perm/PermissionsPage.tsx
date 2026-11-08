// 权限页(08 §11、评审修订):规则/联网名单/三个开关是全局配置(kernel.ts permissions.get:config 不按
// sessionId,只有 defaults 和 sandbox 按会话),所以会话选择器只重取那两样,从不碰草稿——放在「默认规则」
// 块里,和它实际管的东西在一起;真正编辑的那一块标「全局规则」。规则按稳定的客户端 id 操作和标错,不按
// 下标,这样移动/增删后错误还跟着它的规则。联网名单的 reason:'network' 错误按下标标在联网名单自己身上。
// 保存前把每个标签框里还没点「添加」的文字强制收进来(flushAll),不依赖浏览器的 blur 顺序。保存中锁住
// 全部控件:一来防止编辑和成功后的整份重取互相打架,二来这次保存自己产生的 permissions.updated 原样忽略,
// 不会闪一下「已在别处修改」。重置(reset)套用和 permissions.updated 一样的脏检查。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PermissionsConfig, RuleError, RuleSpec, SandboxStatus } from '@mffai/protocol'
import { call, isUnsupported, retryable, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { useSessions } from '../chat/useSessions'
import { label as codeLabel } from '../labels'
import { AutoSwitch, UNSANDBOXED_AUTO_LABEL } from '../ui/AutoSwitch'
import { Chip, type ChipTone } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { RuleEditor, type RuleRow } from './RuleEditor'
import { TagInput } from './TagInput'

const LEVEL_TONE: Record<SandboxStatus['level'], ChipTone> = { full: 'ok', partial: 'warn', none: 'bad' }
type SaveFailure = 'unsupported' | 'failed'
type GetResult = { config: PermissionsConfig; defaults: string[]; errors: RuleError[]; sandbox: SandboxStatus }

const toRows = (rules: readonly RuleSpec[]): RuleRow[] => rules.map((r) => ({ id: crypto.randomUUID(), r }))

export default function PermissionsPage() {
  const [sessionId, setSessionId] = useState('')
  const { sessions } = useSessions()

  const [draft, setDraft] = useState<PermissionsConfig | null>(null)
  const draftRef = useRef<PermissionsConfig | null>(null)
  const [rows, setRows] = useState<RuleRow[]>([])
  const rowsRef = useRef<RuleRow[]>([])

  const [defaults, setDefaults] = useState<string[]>([])
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null)
  const [loadErrors, setLoadErrors] = useState<readonly RuleError[]>([])
  const [loadFailed, setLoadFailed] = useState<'unsupported' | 'failed' | null>(null)

  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, RuleError>>(new Map())
  const [networkErrors, setNetworkErrors] = useState<ReadonlyMap<number, RuleError>>(new Map())
  const [fieldErrors, setFieldErrors] = useState<readonly RuleError[]>([])
  const [busy, setBusy] = useState(false)
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null)

  const retry = useRef(retryable()).current
  const inflight = useRef(false)
  const alive = useRef(true)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const busyRef = useRef(false)
  busyRef.current = busy
  const fullGen = useRef(0)
  const scopedGen = useRef(0)
  const flushers = useRef(new Set<() => void>()).current
  const skipFirstSessionEffect = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const applyFull = (r: GetResult) => {
    draftRef.current = r.config
    setDraft(r.config)
    const rs = toRows(r.config.rules)
    rowsRef.current = rs
    setRows(rs)
    setDefaults(r.defaults)
    setSandbox(r.sandbox)
    setLoadErrors(r.errors)
    setLoadFailed(null)
    setDirty(false)
    setConflict(false)
    setRowErrors(new Map())
    setNetworkErrors(new Map())
    setFieldErrors([])
    setSaveFailure(null)
  }

  // 整份重取:草稿、defaults、sandbox 都换(挂载、保存成功、冲突后点「重新载入」、干净时的事件/重置)
  const loadFull = useCallback((sid: string) => {
    const g = ++fullGen.current
    void call('permissions.get', sid ? { sessionId: sid } : {}).then(
      (r) => { if (alive.current && g === fullGen.current) applyFull(r) },
      (e) => {
        if (!alive.current || g !== fullGen.current) return
        console.error('mffai permissions.get', toCallError(e).code)
        setLoadFailed(isUnsupported(e) ? 'unsupported' : 'failed')
      },
    )
  }, [])

  // 只重取 defaults/sandbox/errors:config 是全局的,会话选择器不该碰草稿(kernel.ts:575-579)。
  // 带序号守卫:快速切换只认最后一次请求的回答
  const loadScoped = useCallback((sid: string) => {
    const g = ++scopedGen.current
    void call('permissions.get', sid ? { sessionId: sid } : {}).then(
      (r) => {
        if (!alive.current || g !== scopedGen.current) return
        setDefaults(r.defaults)
        setSandbox(r.sandbox)
        setLoadErrors(r.errors)
        setLoadFailed(null)
      },
      (e) => {
        if (!alive.current || g !== scopedGen.current) return
        console.error('mffai permissions.get', toCallError(e).code)
        setLoadFailed(isUnsupported(e) ? 'unsupported' : 'failed')
      },
    )
  }, [])

  useEffect(() => { loadFull('') }, [loadFull])
  useEffect(() => {
    if (skipFirstSessionEffect.current) { skipFirstSessionEffect.current = false; return }
    loadScoped(sessionId)
  }, [sessionId, loadScoped])

  useMffaiEvent({ types: ['permissions.updated'] }, () => {
    if (busyRef.current) return // 这条事件可能是自己这次保存产生的,保存还没结束,别闪一下冲突
    if (dirtyRef.current) { setConflict(true); return }
    loadFull(sessionId)
  })
  useMffaiReset(() => {
    if (dirtyRef.current) { setConflict(true); return } // 和 permissions.updated 同一条脏检查
    loadFull(sessionId)
  })

  const registerFlush = useCallback((fn: () => void) => {
    flushers.add(fn)
    return () => { flushers.delete(fn) }
  }, [flushers])
  const flushAll = () => { for (const fn of [...flushers]) fn() }

  const touchDraft = (next: PermissionsConfig) => {
    draftRef.current = next
    setDraft(next)
    setDirty(true)
  }
  const editSandbox = (patch: Partial<PermissionsConfig['sandbox']>) => {
    const base = draftRef.current
    if (base) touchDraft({ ...base, sandbox: { ...base.sandbox, ...patch } })
  }
  const editAuto = (v: boolean) => {
    const base = draftRef.current
    if (base) touchDraft({ ...base, allowUnsandboxedAuto: v })
  }
  const editNetwork = (allow: string[]) => {
    const base = draftRef.current
    if (base) touchDraft({ ...base, network: { allow } })
  }
  // rowsRef 总是先更新再读:同一个事件循环里连着调几次(比如 flushAll 命中了两行)不会互相用对方的旧快照
  const applyRows = (updater: (rs: RuleRow[]) => RuleRow[]) => {
    const next = updater(rowsRef.current)
    rowsRef.current = next
    setRows(next)
    const base = draftRef.current
    if (base) touchDraft({ ...base, rules: next.map((x) => x.r) })
  }
  const editRule = (id: string, patch: Partial<RuleSpec>) =>
    applyRows((rs) => rs.map((x) => (x.id === id ? { ...x, r: { ...x.r, ...patch } } : x)))
  const moveRule = (id: string, dir: -1 | 1) =>
    applyRows((rs) => {
      const i = rs.findIndex((x) => x.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= rs.length) return rs
      const next = rs.slice()
      const tmp = next[i]
      next[i] = next[j]
      next[j] = tmp
      return next
    })
  const removeRule = (id: string) => applyRows((rs) => rs.filter((x) => x.id !== id))
  const addRule = () => applyRows((rs) => [...rs, { id: crypto.randomUUID(), r: { effect: 'ask', rule: '', match: [], noMatch: [] } }])

  const save = async () => {
    if (!draftRef.current || inflight.current) return
    flushAll() // 还没点「添加」的标签文字,先一次性收进 draftRef(评审修订 5)
    const config = draftRef.current
    const sentRows = rowsRef.current
    const key = JSON.stringify(config)
    inflight.current = true
    setBusy(true)
    setSaveFailure(null)
    setRowErrors(new Map())
    setNetworkErrors(new Map())
    setFieldErrors([])
    try {
      await call('permissions.set', { commandId: retry.id(key), config })
      retry.done(key)
      if (!alive.current) return
      setDirty(false)
      loadFull(sessionId)
    } catch (e) {
      const c = toCallError(e)
      console.error('mffai permissions.set', c.code)
      if (!alive.current) return
      if (isUnsupported(c)) { setSaveFailure('unsupported'); return }
      if (Array.isArray(c.data)) {
        const rowMap = new Map<string, RuleError>()
        const netMap = new Map<number, RuleError>()
        const fields: RuleError[] = []
        for (const err of c.data as RuleError[]) {
          // reason:'network':index 是联网名单里的位置,不是规则表的行(kernel/permissions.ts analyze())
          if (err.reason === 'network') netMap.set(err.index, err)
          else if (err.index >= 0) { const row = sentRows[err.index]; if (row) rowMap.set(row.id, err) }
          else fields.push(err)
        }
        setRowErrors(rowMap)
        setNetworkErrors(netMap)
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
      {loadFailed === 'failed' && <span className="mffai-fail">失败</span>}
      <div className="mffai-group">
        <div className="mffai-grouphead"><span>默认规则</span></div>
        <div className="mffai-row">
          <span className="mffai-k">会话</span>
          <select aria-label="会话" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            <option value="">默认</option>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || s.id}</option>)}
          </select>
        </div>
        {sandbox && (
          <div className="mffai-row">
            <Chip tone={LEVEL_TONE[sandbox.level] ?? 'muted'}>{codeLabel('level', sandbox.level)}</Chip>
            {sandbox.missing.map((m) => <CodeChip key={m} code={m} />)}
          </div>
        )}
        <ul className="mffai-defaults" data-testid="mffai-perm-defaults">
          {defaults.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
        {loadErrors.length > 0 && (
          <div className="mffai-row" data-testid="mffai-perm-load-errors">
            {loadErrors.map((e, i) => (
              <span key={i} className="mffai-rule-error">
                <CodeChip code={e.reason} />
                <code className="mffai-badge mffai-code">{e.rule}</code>
              </span>
            ))}
          </div>
        )}
      </div>
      {draft && (
        <>
          <div className="mffai-grouphead"><span>全局规则</span></div>
          <div className="mffai-row">
            <label className="mffai-switch">
              <input type="checkbox" role="switch" checked={draft.sandbox.enabled} disabled={busy}
                onChange={(e) => editSandbox({ enabled: e.target.checked })} />
              沙箱
            </label>
            <label className="mffai-switch">
              <input type="checkbox" role="switch" checked={draft.sandbox.allowLoopback} disabled={busy}
                onChange={(e) => editSandbox({ allowLoopback: e.target.checked })} />
              允许本机回环
            </label>
            <AutoSwitch checked={draft.allowUnsandboxedAuto} disabled={busy} label={UNSANDBOXED_AUTO_LABEL} onChange={editAuto} />
          </div>
          <div className="mffai-group">
            <RuleEditor rows={rows} errors={rowErrors} disabled={busy} registerFlush={registerFlush}
              onEdit={editRule} onMove={moveRule} onRemove={removeRule} onAdd={addRule} />
          </div>
          <div className="mffai-group">
            <div className="mffai-grouphead"><span>联网名单</span></div>
            <TagInput label="联网名单" value={draft.network.allow} disabled={busy} errors={networkErrors}
              registerFlush={registerFlush} onChange={editNetwork} />
          </div>
          <div className="mffai-actions">
            {conflict ? (
              <button className="set-btn" onClick={() => loadFull(sessionId)}>已在别处修改 · 重新载入</button>
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
