import { useCallback, useEffect, useMemo, useState } from 'react'
import { ADDON_KIND_LABEL, type Addon, type AddonKind } from '@shared/addons'
import { BUILTIN_PROVIDERS } from '@shared/providerCatalog'
import './loadPane.css'

/**
 * 系统级加载项:各 CLI **全局**装了哪些 skill / rule / MCP,能筛,能删。
 *
 * ★★2026-09-05 按用户的三条重做(原来只是个只读清单):
 *  ①「加载项里好像有 skill,所以 skill 是不是多余?」—— 设置里那一页删了,这里是唯一入口。
 *  ②「根据当前支持的 provider 扫描 …… 然后进行筛选」—— 按 provider / 类型 / 关键词三个维度筛。
 *  ③「加个操作,能不能删除?」—— skill/rule 走废纸篓,MCP 走 CLI 自己的 `mcp remove`。
 *  ④「一个 skill 既在 claude 装了又在 codex 装了,都应该展示出来」—— **不跨 provider 去重**。
 * ★项目级的加载项不在这儿:那是工作区右侧面板的事。
 */

const KINDS: AddonKind[] = ['skill', 'rule', 'mcp']
const LABEL: Record<string, string> = Object.fromEntries(BUILTIN_PROVIDERS.map(p => [p.id, p.displayName]))
const providerLabel = (id: string) => LABEL[id] ?? id

export function LoadPane() {
  const [addons, setAddons] = useState<Addon[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<AddonKind | 'all'>('all')
  const [provider, setProvider] = useState<string>('all')
  const [q, setQ] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const scan = useCallback(() => {
    setLoading(true)
    setError(null)
    window.forge.addonsScan()
      .then(res => setAddons(res.addons))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { scan() }, [scan])

  const all = addons ?? []
  // provider 下拉里只出现**真的扫到东西的**那些 —— 列一堆空 provider 是噪音。
  const providers = useMemo(() => [...new Set(all.map(a => a.provider))].sort(), [all])
  const shown = all.filter(a =>
    (kind === 'all' || a.kind === kind)
    && (provider === 'all' || a.provider === provider)
    && (!q.trim() || `${a.name} ${a.pack ?? ''} ${a.description ?? ''} ${a.path}`.toLowerCase().includes(q.trim().toLowerCase())))

  const groups = useMemo(() => {
    const m = new Map<string, Addon[]>()
    for (const a of shown) (m.get(a.provider) ?? m.set(a.provider, []).get(a.provider)!).push(a)
    return [...m.entries()]
  }, [shown])

  const remove = async (a: Addon) => {
    const what = a.removeVia === 'cli'
      ? `把 MCP 服务器「${a.name}」从 ${providerLabel(a.provider)} 的配置里删掉?`
      // ★文案里写清是**移到废纸篓**。真删和可回收是两件事,用户有权在点之前知道是哪一种。
      //  (无头主机上没有废纸篓 —— 那种情况下删完的回执会说明,见下面的 msg。)
      : `把「${a.name}」移到废纸篓?\n${a.path}`
    if (!window.confirm(what)) return
    setBusyId(a.id)
    setMsg(null)
    try {
      const r = await window.forge.addonsRemove(a.id)
      setMsg(r.via === 'cli' ? `已从 ${providerLabel(a.provider)} 删掉「${a.name}」`
        : r.trashed ? `已把「${a.name}」移到废纸篓` : `已删除「${a.name}」(这台主机没有废纸篓,是直接删的)`)
      scan()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const countOf = (k: AddonKind) => all.filter(a => a.kind === k).length

  return (
    <div className="set-group load-pane">
      <div className="load-head">
        <div>
          <h4>系统级加载项</h4>
          <p>各编码 CLI 全局装了哪些 skill、rule、MCP。项目级的在对应工作区右侧看。</p>
        </div>
        <button className={'set-btn load-rescan' + (loading ? ' busy' : '')} onClick={scan} disabled={loading}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" /></svg>
          {loading ? '扫描中…' : '重新扫描'}
        </button>
      </div>

      <div className="load-filters">
        <div className="load-chips">
          <button className={'load-chip' + (kind === 'all' ? ' on' : '')} onClick={() => setKind('all')}>全部 {all.length}</button>
          {KINDS.map(k => (
            <button key={k} className={'load-chip' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>
              {ADDON_KIND_LABEL[k]} {countOf(k)}
            </button>
          ))}
        </div>
        <div className="load-chips">
          <button className={'load-chip' + (provider === 'all' ? ' on' : '')} onClick={() => setProvider('all')}>全部代理</button>
          {providers.map(p => (
            <button key={p} className={'load-chip' + (provider === p ? ' on' : '')} onClick={() => setProvider(p)}>{providerLabel(p)}</button>
          ))}
        </div>
        <input className="load-search" value={q} onChange={e => setQ(e.target.value)} placeholder="搜名字、技能包、说明或路径" spellCheck={false} />
      </div>

      {error && <div className="load-error">{error}</div>}
      {msg && <div className="load-msg">{msg}</div>}

      {addons === null ? (
        <div className="proj-empty">扫描中…</div>
      ) : shown.length === 0 ? (
        <div className="proj-empty">{all.length === 0 ? '未发现系统级加载项' : '没有符合条件的'}</div>
      ) : (
        groups.map(([pid, items]) => (
          <div className="load-group" key={pid}>
            <div className="load-group-h">
              <span>{providerLabel(pid)}</span>
              {/* ★卸载了的 CLI 留下的东西照样列,标一句 —— 「我卸了它,东西还在磁盘上」正是该看见的事。 */}
              {items[0] && !items[0].installed && <em>未检测到这个 CLI</em>}
              <span className="load-group-n">{items.length}</span>
            </div>
            {items.map(a => (
              <div className="load-item" key={a.id}>
                <span className={`load-kind k-${a.kind}`}>{ADDON_KIND_LABEL[a.kind]}</span>
                <div className="load-meta">
                  <div className="t">
                    {/* 包名在前、灰的:178 个技能里绝大多数来自几个包,不标的话认不出是谁带来的。 */}
                    {a.pack ? <span className="pack">{a.pack} /</span> : null}{a.name}
                  </div>
                  {a.description ? <div className="d">{a.description}</div> : null}
                  <div className="p" title={a.path}>{a.path}</div>
                </div>
                {a.removable ? (
                  <button className="load-del" onClick={() => void remove(a)} disabled={busyId === a.id}>
                    {busyId === a.id ? '…' : '删除'}
                  </button>
                ) : (
                  // 不给按钮就得给理由。一个光秃秃删不掉的条目,人只会以为是坏了。
                  <span className="load-note" title={a.note}>{a.note || '不可删除'}</span>
                )}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  )
}
