import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CliPlugin, CliPluginView } from '@shared/cliPlugins'
import './marketPane.css'

/**
 * 技能 / 插件市场:各 CLI 自己的市场里有什么,点一下装 / 卸。
 *
 * ★用户原话:「我们能不能接入技能市场?codex 的 app 里,有技能和插件,它的这些我们能不能支持点击安装?
 *  还有 claude 等,这个我不清楚,你可以探究探究」。探究结果:两边都有 `plugin` 子命令,
 *  实测 claude 302 个、codex 76 个可装(见 main/agents/pluginMarket.ts)。
 *
 * ★★装 / 卸的**动词两个 CLI 不一样**(install/add、uninstall/remove),那是主机侧探出来的;
 *  这一屏只管点。界面上不摆「安装」按钮的唯一情况是那个 CLI 根本没有这个动词。
 * ★这里的「插件」是 **CLI 的**插件,和设置里那个「插件」(这个 app 自己的定时任务插件)毫无关系。
 */

type Tab = 'all' | 'installed' | 'available'

export function MarketPane() {
  const [rows, setRows] = useState<CliPluginView[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pid, setPid] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('all')
  const [q, setQ] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    window.forge.cliPluginsList()
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const usable = useMemo(() => (rows ?? []).filter(r => r.caps.plugin), [rows])
  const active = usable.find(r => r.providerId === pid) ?? usable[0] ?? null
  const list = (active?.plugins ?? []).filter(p =>
    (tab === 'all' || (tab === 'installed' ? p.installed : !p.installed))
    && (!q.trim() || `${p.name} ${p.description} ${p.marketplace}`.toLowerCase().includes(q.trim().toLowerCase())))

  const act = async (p: CliPlugin, install: boolean) => {
    if (!active) return
    if (!install && !window.confirm(`卸载「${p.name}」?\n它带来的技能 / 命令会一起消失。`)) return
    setBusyId(p.id)
    setMsg(null)
    try {
      const out = install
        ? await window.forge.cliPluginsInstall({ providerId: active.providerId, id: p.id })
        : await window.forge.cliPluginsUninstall({ providerId: active.providerId, id: p.id })
      // ★把 CLI 那句回执**原样**摆出来(截前两行):装完通常要重启 CLI 才生效,
      //  那句提醒只有它自己知道,我们编不出来。
      setMsg(`${install ? '已安装' : '已卸载'}「${p.name}」${firstLines(out)}`)
      load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="set-group market-pane">
      <div className="load-head">
        <div>
          <h4>技能市场</h4>
          <p>各编码 CLI 自己的插件市场（技能、命令、agent 都在里面）。装在这台主机上，所有工作区共用。</p>
        </div>
        <button className={'set-btn load-rescan' + (loading ? ' busy' : '')} onClick={load} disabled={loading}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" /></svg>
          {loading ? '读取中…' : '刷新'}
        </button>
      </div>

      {error && <div className="load-error">{error}</div>}

      {rows !== null && usable.length === 0 && !error && (
        <div className="proj-empty">这台主机上装着的 CLI 都没有插件市场（claude / codex 才有）。</div>
      )}

      {usable.length > 0 && (
        <>
          <div className="load-filters">
            <div className="load-chips">
              {usable.map(r => (
                <button key={r.providerId} className={'load-chip' + (active?.providerId === r.providerId ? ' on' : '')} onClick={() => setPid(r.providerId)}>
                  {r.displayName} {r.plugins.length}
                </button>
              ))}
            </div>
            <div className="load-chips">
              {(['all', 'installed', 'available'] as Tab[]).map(t => (
                <button key={t} className={'load-chip' + (tab === t ? ' on' : '')} onClick={() => setTab(t)}>
                  {t === 'all' ? '全部' : t === 'installed' ? `已安装 ${active?.plugins.filter(p => p.installed).length ?? 0}` : '可安装'}
                </button>
              ))}
            </div>
            <input className="load-search" value={q} onChange={e => setQ(e.target.value)} placeholder="搜插件名或说明" spellCheck={false} />
          </div>

          {msg && <div className="load-msg">{msg}</div>}
          {active?.error && <div className="load-error">{active.error}</div>}

          {rows === null ? (
            <div className="proj-empty">读取中…</div>
          ) : list.length === 0 ? (
            <div className="proj-empty">没有符合条件的</div>
          ) : (
            list.map(p => (
              <div className="mk-item" key={p.id}>
                <div className="mk-meta">
                  <div className="t">
                    {p.name}
                    {p.installed && <span className="mk-on">已安装</span>}
                    {p.version && <span className="mk-ver">{p.version}</span>}
                  </div>
                  {/* codex 的条目没有说明 —— 少画这一行,别编一句出来。 */}
                  {p.description ? <div className="d">{p.description}</div> : null}
                  <div className="s">
                    {p.marketplace}
                    {typeof p.installs === 'number' ? ` · ${p.installs.toLocaleString()} 次安装` : ''}
                  </div>
                </div>
                {p.installed
                  ? active.caps.removeVerb
                    ? <button className="load-del" onClick={() => void act(p, false)} disabled={busyId === p.id}>{busyId === p.id ? '…' : '卸载'}</button>
                    : <span className="load-note">这个版本不支持卸载</span>
                  : active.caps.installVerb
                    ? <button className="mk-install" onClick={() => void act(p, true)} disabled={busyId === p.id}>{busyId === p.id ? '安装中…' : '安装'}</button>
                    : <span className="load-note">这个版本不支持安装</span>}
              </div>
            ))
          )}
        </>
      )}
    </div>
  )
}

/** CLI 回执常常好几十行,取前两行有用的(通常就是「装好了 / 重启后生效」)。 */
function firstLines(out: string): string {
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2)
  return lines.length ? ` · ${lines.join(' ')}` : ''
}
