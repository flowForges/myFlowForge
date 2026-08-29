import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import type { ProviderInfo, AgentsConfig, CustomAgent, ModelInfo } from '@shared/types'
import { BUILTIN_PROVIDERS } from '@shared/providerCatalog'
import { TIMEZONE_OPTIONS } from '@shared/timezones'
import { useSettings } from '../state/useSettings'
import { usePathPicker } from '../state/PathPicker'

// Built-in providers whose bin path can be overridden — derived from the shared catalog.
const BUILTINS = BUILTIN_PROVIDERS.map(p => ({ id: p.id, name: p.displayName, defaultBin: p.defaultBin }))

function copyText(t: string, after: (el: HTMLButtonElement) => void) {
  return (e: MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget
    void navigator.clipboard?.writeText(t)
    after(el)
  }
}
function CliCopyBtn({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <button className={`cli-copy${done ? ' done' : ''}`} onClick={copyText(text, () => { setDone(true); setTimeout(() => setDone(false), 1300) })}>
      {done ? '已复制' : label}
    </button>
  )
}
function CliGuide({ info }: { info?: ProviderInfo }) {
  if (!info || info.installed || info.custom || (!info.installCmd && !info.authCmd)) return null
  return (
    <div className="cli-guide">
      <div className="cli-guide-h">
        <span className="cli-guide-title">本机未检测到 {info.displayName}</span>
        <span className="cli-guide-note">用户自行安装并登录后，回到这里重新检测。</span>
      </div>
      <div className="cli-cmd-row"><code>{info.installCmd || '请按官方文档安装'}</code><CliCopyBtn text={info.installCmd || ''} label="复制安装命令" /></div>
      {/* ★★备选安装命令。用户报过「引导里那些命令不一定好使」——
          实测下来最可能的原因是那几条 `curl | bash` 指向 claude.ai / chatgpt.com,
          国内不挂代理连不上,而 npm(或它的镜像)那条路通得多。
          ★只在**真的有官方 npm 包**的那几个上出现;没有的一个都不编(见 providerCatalog)。 */}
      {info.installAltCmd && (
        <div className="cli-cmd-row">
          <code>{info.installAltCmd}</code>
          <CliCopyBtn text={info.installAltCmd} label="复制备选命令" />
        </div>
      )}
      <div className="cli-cmd-row"><code>{info.authCmd || info.displayName}</code><CliCopyBtn text={info.authCmd || ''} label="复制登录命令" /></div>
      {info.installHelp && <div className="cli-guide-note" style={{ marginTop: 8 }}>{info.installHelp}</div>}
    </div>
  )
}

const EMPTY_CUSTOM = { id: '', displayName: '', bin: '', argsTemplate: '{prompt}' }

// A model row in the editable list — mirrors ModelInfo but mutable
interface ModelRow { id: string; label: string; description?: string }

// A compact 启用/已禁用 toggle. Disabling hides the provider from every "选择编码代理" list
// (its CLI is untouched); this settings pane keeps listing it so it can be re-enabled.
function EnableToggle({ id, disabled, onToggle }: { id: string; disabled: boolean; onToggle: (id: string, next: boolean) => void }) {
  return (
    <button
      className={`agent-enable-toggle${disabled ? ' off' : ''}`}
      role="switch"
      aria-checked={!disabled}
      title={disabled ? '已禁用 — 点击启用' : '已启用 — 点击禁用'}
      onClick={() => onToggle(id, disabled)}
    >
      <span className="agent-enable-knob" />
      <span className="agent-enable-label">{disabled ? '已禁用' : '已启用'}</span>
    </button>
  )
}

export function AgentsPane({ onChanged }: { onChanged?: () => void }) {
  const { settings, update } = useSettings()
  // CLI 装在**那台机器**上,连着远程时要浏览的是它的文件系统。
  const { pick: pickPath } = usePathPicker()
  const disabledProviders = settings?.disabledProviders ?? []
  const isDisabled = (id: string) => disabledProviders.includes(id)
  const toggleDisabled = useCallback((id: string, currentlyDisabled: boolean) => {
    const next = currentlyDisabled
      ? disabledProviders.filter(p => p !== id)
      : [...disabledProviders, id]
    update({ disabledProviders: next })
  }, [disabledProviders, update])

  const [config, setConfig] = useState<AgentsConfig | null>(null)
  const [detected, setDetected] = useState<ProviderInfo[]>([])
  // True until the first detectProviders() round-trip lands — rows show 检测中… meanwhile.
  const [detecting, setDetecting] = useState(true)
  const [binDrafts, setBinDrafts] = useState<Record<string, string>>({})
  const [nc, setNc] = useState(EMPTY_CUSTOM)
  // 全局忙(只给「重新检测」这类真·全局操作用)。单个 provider 的保存/删除走下面的 rowBusy。
  const [busy, setBusy] = useState(false)
  // Per-provider busy + 「已保存」闪现,让一行的操作只影响那一行(见 apply 的注释)。
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({})
  const [rowSaved, setRowSaved] = useState<Record<string, boolean>>({})
  const savedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const flashRowSaved = useCallback((id: string) => {
    setRowSaved(s => ({ ...s, [id]: true }))
    if (savedTimers.current[id]) clearTimeout(savedTimers.current[id])
    savedTimers.current[id] = setTimeout(() => setRowSaved(s => ({ ...s, [id]: false })), 1800)
  }, [])
  useEffect(() => () => { Object.values(savedTimers.current).forEach(clearTimeout) }, [])
  // Per-provider refresh state: { [id]: 'idle' | 'loading' | error-string }
  const [refreshState, setRefreshState] = useState<Record<string, string | 'loading'>>({})
  // Per-provider editable model rows: { [providerId]: ModelRow[] }
  const [modelDrafts, setModelDrafts] = useState<Record<string, ModelRow[]>>({})
  // Per-provider save state: { [id]: 'idle' | 'saving' | error-string }
  const [modelSaveState, setModelSaveState] = useState<Record<string, string | 'saving'>>({})
  // CLI 有新版提示(只提示):{ [id]: { latest, npmPackage } }，仅收录 hasUpdate 的。查不到/无 npm 包的略过。
  const [cliUpdates, setCliUpdates] = useState<Record<string, { latest: string; npmPackage: string }>>({})
  // Per-provider timezone selection, seeded from detection and updated optimistically on change.
  const [tzByProvider, setTzByProvider] = useState<Record<string, string>>({})

  // Query each installed CLI's latest npm version and keep only the ones with an update. Best-effort:
  // any failure just leaves the map empty (no pill), never blocks the pane.
  const checkUpdates = useCallback(async (det: ProviderInfo[]) => {
    const installedWithVer = det.filter(d => d.installed && d.version).map(d => ({ id: d.id, version: d.version }))
    if (!installedWithVer.length || !window.forge.checkCliUpdates) return
    try {
      const res = await window.forge.checkCliUpdates(installedWithVer)
      const map: Record<string, { latest: string; npmPackage: string }> = {}
      for (const u of res) if (u.hasUpdate) map[u.id] = { latest: u.latest, npmPackage: u.npmPackage }
      setCliUpdates(map)
    } catch { /* courtesy hint — ignore failures */ }
  }, [])


  const load = useCallback(async () => {
    // Fire both IPCs in parallel and render progressively: the pane shows up as soon as the
    // (fast) config read returns — detection spawns real CLIs and can take seconds, so rows
    // show a 检测中… placeholder until it lands instead of blanking the whole pane.
    const detP = (window.forge.detectProviders() as Promise<ProviderInfo[]>)
      .then(det => {
        setDetected(det)
        void checkUpdates(det)
        // Initialise model drafts from detected models
        const mDrafts: Record<string, ModelRow[]> = {}
        const tz: Record<string, string> = {}
        for (const d of det) {
          if (BUILTINS.some(b => b.id === d.id)) {
            mDrafts[d.id] = d.models.map(m => ({ id: m.id, label: m.label, description: m.description }))
            tz[d.id] = d.timezone ?? ''
          }
        }
        setModelDrafts(mDrafts)
        setTzByProvider(tz)
      })
      .finally(() => setDetecting(false))
    const cfg = await window.forge.getAgentsConfig() as AgentsConfig
    setConfig(cfg)
    const drafts: Record<string, string> = {}
    for (const b of BUILTINS) drafts[b.id] = cfg.providers.find(p => p.id === b.id)?.binOverride ?? ''
    setBinDrafts(drafts)
    await detP
    // Self-heal against out-of-band CLI changes the cached detect can't see — most importantly a
    // `npm i -g <cli>@latest` the user just ran, which otherwise leaves a stale "有新版" pill for up to
    // DETECT_CACHE_TTL_MS (the cached probe keeps serving the pre-update version). Force ONE fresh
    // re-probe in the background and refresh only the detected version + update state — NOT the model
    // drafts, so it never clobbers rows the user may already be editing.
    void (window.forge.detectProviders({ force: true }) as Promise<ProviderInfo[]>)
      .then(det => { setDetected(det); void checkUpdates(det) })
      .catch(() => {})
  }, [checkUpdates])
  useEffect(() => { void load() }, [load])

  const info = (id: string) => detected.find(d => d.id === id)
  const installed = (id: string) => info(id)?.installed ?? false
  // While the first detection round-trip is pending show a lightweight placeholder
  // instead of prematurely stamping 未检测.
  const badge = (id: string) => {
    if (detecting && !info(id)) return <span className="agent-badge off">检测中…</span>
    if (!installed(id)) return <span className="agent-badge off">未检测</span>
    // ★★「装了」不等于「登录了」。远程/无头那台机器你看不见,不说的话流程是
    //  「建会话 → 发消息 → 等半天 → 才发现没登录」(设计文档第九节)。
    // ★只有拿到**否定证据**(auth === 'missing')才画这一枚;`unknown` 照旧画「已检测」——
    //  一半 CLI 我们根本没有判断依据,把不知道说成没登录同样是在浪费人的时间。
    if (info(id)?.auth === 'missing') return <span className="agent-badge warn">没登录</span>
    return <span className="agent-badge ok">已检测</span>
  }
  const browse = async (id: string) => {
    const p = await pickPath('file', '选择 CLI 可执行文件')
    if (p) setBinDrafts(d => ({ ...d, [id]: p }))
  }
  /**
   * 用户反馈:「点击任意一个保存,好像所有的都在保存」。成因就是这里 —— 原先只有一个全局 `busy`,
   * 每个 provider 行的「选择…」「保存」都写 `disabled={busy}`,于是点一个,整页按钮一起变灰;
   * 而且 bin 保存**完全没有成功反馈**,两件事叠起来就像"全都在保存"。
   *
   * 现在 scope 传入发起这次操作的 provider id:只有那一行进入 busy,并在那一行给一枚「已保存」。
   * 不带 scope(全局操作,如重新检测)时仍然锁全局 —— 那本来就是全局动作。
   */
  const apply = async (fn: () => Promise<ProviderInfo[]>, scope?: string) => {
    if (scope) setRowBusy(s => ({ ...s, [scope]: true })); else setBusy(true)
    try {
      const det = await fn(); setDetected(det); void checkUpdates(det)
      setConfig(await window.forge.getAgentsConfig()); onChanged?.()
      if (scope) flashRowSaved(scope)
    }
    finally { if (scope) setRowBusy(s => ({ ...s, [scope]: false })); else setBusy(false) }
  }

  const handleRefreshModels = useCallback(async (providerId: string) => {
    setRefreshState(s => ({ ...s, [providerId]: 'loading' }))
    try {
      const result = await window.forge.refreshModels(providerId)
      if (result.error) {
        setRefreshState(s => ({ ...s, [providerId]: result.error! }))
      } else {
        setRefreshState(s => ({ ...s, [providerId]: 'idle' }))
        // Re-detect so updated models propagate
        const det = await window.forge.detectProviders() as ProviderInfo[]
        setDetected(det)
        // Sync model drafts from refreshed detection
        setModelDrafts(prev => ({ ...prev, [providerId]: det.find(d => d.id === providerId)?.models.map(m => ({ id: m.id, label: m.label, description: m.description })) ?? prev[providerId] ?? [] }))
      }
    } catch (err) {
      setRefreshState(s => ({ ...s, [providerId]: String(err) }))
    }
  }, [])

  // Model draft helpers
  const setModelRow = (providerId: string, idx: number, field: keyof ModelRow, value: string) => {
    setModelDrafts(prev => {
      const rows = [...(prev[providerId] ?? [])]
      rows[idx] = { ...rows[idx], [field]: value }
      return { ...prev, [providerId]: rows }
    })
  }
  const addModelRow = (providerId: string) => {
    setModelDrafts(prev => ({ ...prev, [providerId]: [...(prev[providerId] ?? []), { id: '', label: '' }] }))
  }
  const removeModelRow = (providerId: string, idx: number) => {
    const rows = [...(modelDrafts[providerId] ?? [])]
    rows.splice(idx, 1)
    setModelDrafts(prev => ({ ...prev, [providerId]: rows }))
    // Persist the deletion right away — like custom-agent delete. Previously × only mutated local
    // state, so the model came back on reopen (its customModels/modelsCache entry was never cleared).
    // We DON'T re-detect here: the splice already reflects the removal in the UI, and setModels
    // invalidates the main-process detect cache so the next mount re-probes the truthful list.
    const valid = rows
      .filter(r => r.id.trim() !== '')
      .map(r => ({ id: r.id.trim(), label: r.label.trim() || r.id.trim(), description: r.description?.trim() || undefined }))
    void window.forge.setModels(providerId, valid).catch(() => {})
  }
  const saveModels = useCallback(async (providerId: string) => {
    const rows = modelDrafts[providerId] ?? []
    const valid = rows.filter(r => r.id.trim() !== '').map(r => ({ id: r.id.trim(), label: r.label.trim() || r.id.trim(), description: r.description?.trim() || undefined }))
    setModelSaveState(s => ({ ...s, [providerId]: 'saving' }))
    try {
      await window.forge.setModels(providerId, valid)
      setModelSaveState(s => ({ ...s, [providerId]: 'idle' }))
      // Re-detect so detect.ts picks up the new cache
      const det = await window.forge.detectProviders() as ProviderInfo[]
      setDetected(det)
      setModelDrafts(prev => ({ ...prev, [providerId]: det.find(d => d.id === providerId)?.models.map(m => ({ id: m.id, label: m.label, description: m.description })) ?? valid }))
    } catch (err) {
      setModelSaveState(s => ({ ...s, [providerId]: String(err) }))
    }
  }, [modelDrafts])
  const resetModels = useCallback(async (providerId: string) => {
    setModelSaveState(s => ({ ...s, [providerId]: 'saving' }))
    try {
      await window.forge.setModels(providerId, [])
      setModelSaveState(s => ({ ...s, [providerId]: 'idle' }))
      const det = await window.forge.detectProviders() as ProviderInfo[]
      setDetected(det)
      setModelDrafts(prev => ({ ...prev, [providerId]: det.find(d => d.id === providerId)?.models.map(m => ({ id: m.id, label: m.label, description: m.description })) ?? [] }))
    } catch (err) {
      setModelSaveState(s => ({ ...s, [providerId]: String(err) }))
    }
  }, [])

  // Timezone change → optimistic local update + immediate persist (like the other per-provider settings).
  const changeTimezone = (providerId: string, tz: string) => {
    setTzByProvider(prev => ({ ...prev, [providerId]: tz }))
    void window.forge.setTimezone(providerId, tz).catch(() => {})
  }

  if (!config) return null
  return (
    <div className="agents-pane">
      <div className="set-row">
        <div className="info"><div className="t">编码代理</div><div className="d">检测本机安装的代理；可覆盖各自的 bin 路径</div></div>
        <button className="set-btn" disabled={busy || detecting} onClick={() => apply(() => window.forge.detectProviders({ force: true }))}>{detecting ? '检测中…' : '重新检测'}</button>
      </div>

      {BUILTINS.map(b => (
        <div className="agent-row" key={b.id}>
          <div className="agent-row-h">
            <div className="agent-row-title">
              {badge(b.id)}
              <span className="agent-row-name">{b.name}</span>
              <EnableToggle id={b.id} disabled={isDisabled(b.id)} onToggle={toggleDisabled} />
            </div>
            <div className="agent-row-meta">
              {info(b.id)?.version && <span className="agent-ver" title="检测到的 CLI 版本">v{info(b.id)!.version}</span>}
              {cliUpdates[b.id] && (
                <span
                  className="agent-ver-new"
                  title={`有新版 v${cliUpdates[b.id].latest} · 更新命令:npm i -g ${cliUpdates[b.id].npmPackage}@latest`}
                >有新版 v{cliUpdates[b.id].latest}</span>
              )}
              {info(b.id)?.binPath && <span className="agent-path" title={info(b.id)!.binPath}>{info(b.id)!.binPath}</span>}
            </div>
            {info(b.id)?.liveModels && (() => {
              const rs = refreshState[b.id]
              const loading = rs === 'loading'
              const errMsg = rs && rs !== 'loading' && rs !== 'idle' ? rs : null
              return (
                <div className="agent-row-actions">
                  <button
                    className="ghost agent-refresh-models"
                    disabled={loading}
                    onClick={() => void handleRefreshModels(b.id)}
                  >{loading ? '刷新中…' : '刷新模型'}</button>
                  {errMsg && <span className="agent-refresh-err">{errMsg}</span>}
                </div>
              )
            })()}
          </div>
          <div className="agent-row-bin">
            <input
              placeholder={`默认 PATH 里的 ${b.defaultBin}（留空即用默认）`}
              value={binDrafts[b.id] ?? ''}
              onChange={e => setBinDrafts(d => ({ ...d, [b.id]: e.target.value }))}
            />
            <button className="ghost" disabled={!!rowBusy[b.id]} onClick={() => browse(b.id)}>选择…</button>
            <button
              disabled={!!rowBusy[b.id]}
              onClick={() => apply(() => window.forge.setAgentBin(b.id, binDrafts[b.id] ?? ''), b.id)}
            >{rowBusy[b.id] ? '保存中…' : '保存'}</button>
            {/* 只在本行给反馈 —— 以前保存 bin 没有任何成功提示,加上全局变灰,就成了"好像全都在保存"。 */}
            {rowSaved[b.id] && <span className="agent-row-saved">已保存</span>}
          </div>
          {/* Per-provider timezone — injected as TZ when this provider spawns; 跟随系统 = no injection */}
          <div className="agent-tz">
            <label className="agent-tz-label" htmlFor={`tz-${b.id}`}>时区</label>
            <select
              id={`tz-${b.id}`}
              className="agent-tz-select"
              value={tzByProvider[b.id] ?? ''}
              onChange={e => changeTimezone(b.id, e.target.value)}
            >
              {TIMEZONE_OPTIONS.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
            </select>
            <span className="agent-tz-hint">运行此代理时设为该时区（留空跟随系统）</span>
          </div>
          {/* Editable model list */}
          <div className="agent-models">
            <div className="agent-models-label">
              可用模型
              {info(b.id)?.liveModels && <span className="agent-models-hint">本机自动检测 · 可「刷新模型」更新</span>}
            </div>
            {(modelDrafts[b.id] ?? []).map((row, idx) => (
              <div className="agent-model-row" key={idx}>
                <input
                  className="agent-model-id"
                  placeholder="model id"
                  value={row.id}
                  onChange={e => setModelRow(b.id, idx, 'id', e.target.value)}
                />
                <input
                  className="agent-model-label"
                  placeholder="显示名（空则用 id）"
                  value={row.label}
                  onChange={e => setModelRow(b.id, idx, 'label', e.target.value)}
                />
                <button className="agent-model-del" onClick={() => removeModelRow(b.id, idx)} title="删除">×</button>
              </div>
            ))}
            <p className="agent-models-hint" style={{ fontSize: 11, color: 'var(--faint)', margin: '2px 0 4px' }}>
              自动检测读不到的模型(如 qoder 的自定义模型 —— 用 modelID 填 ID)可在此手动添加;手动添加的模型会被保留,不会被后续自动刷新覆盖掉。
            </p>
            <div className="agent-models-actions">
              <button className="ghost agent-models-add" onClick={() => addModelRow(b.id)}>添加模型</button>
              <button
                className="ghost"
                disabled={modelSaveState[b.id] === 'saving'}
                onClick={() => void saveModels(b.id)}
              >{modelSaveState[b.id] === 'saving' ? '保存中…' : '保存模型'}</button>
              <button
                className="ghost agent-models-reset"
                disabled={modelSaveState[b.id] === 'saving'}
                onClick={() => void resetModels(b.id)}
              >恢复默认</button>
              {modelSaveState[b.id] && modelSaveState[b.id] !== 'saving' && modelSaveState[b.id] !== 'idle' && (
                <span className="agent-refresh-err">{modelSaveState[b.id]}</span>
              )}
            </div>
          </div>
          <CliGuide info={info(b.id)} />
        </div>
      ))}

      <div className="set-row" style={{ marginTop: 18 }}>
        <div className="info"><div className="t">自定义代理</div><div className="d">添加本地安装的其他 CLI：bin 路径 + 参数模板（{'{prompt}'} {'{model}'} {'{cwd}'}）</div></div>
      </div>
      {config.custom.map(c => (
        <div className="agent-row" key={c.id}>
          <div className="agent-row-h">
            {badge(c.id)}
            <span className="agent-row-name">{c.displayName}</span>
            <div className="agent-row-actions">
              <EnableToggle id={c.id} disabled={isDisabled(c.id)} onToggle={toggleDisabled} />
              <button className="agent-del" disabled={!!rowBusy[c.id]} onClick={() => apply(() => window.forge.removeCustomAgent(c.id), c.id)}>删除</button>
            </div>
          </div>
          <div className="agent-row-bin"><code>{c.bin} {c.argsTemplate}</code></div>
        </div>
      ))}
      <div className="agent-add">
        <input placeholder="id (如 my-agent)" value={nc.id} onChange={e => setNc({ ...nc, id: e.target.value })} />
        <input placeholder="显示名" value={nc.displayName} onChange={e => setNc({ ...nc, displayName: e.target.value })} />
        <input placeholder="bin 绝对路径" value={nc.bin} onChange={e => setNc({ ...nc, bin: e.target.value })} />
        <button className="ghost" disabled={busy} onClick={async () => { const p = await pickPath('file', '选择 CLI 可执行文件'); if (p) setNc(s => ({ ...s, bin: p })) }}>选择…</button>
        <input placeholder="参数模板，如 chat --json {prompt}" value={nc.argsTemplate} onChange={e => setNc({ ...nc, argsTemplate: e.target.value })} />
        <button
          disabled={busy || !nc.id.trim() || !nc.bin.trim()}
          onClick={() => {
            const agent: CustomAgent = {
              id: nc.id.trim(), displayName: nc.displayName.trim() || nc.id.trim(),
              bin: nc.bin.trim(), argsTemplate: nc.argsTemplate.trim() || '{prompt}', models: [],
            }
            void apply(() => window.forge.addCustomAgent(agent)).then(() => setNc(EMPTY_CUSTOM))
          }}
        >添加</button>
      </div>
    </div>
  )
}
