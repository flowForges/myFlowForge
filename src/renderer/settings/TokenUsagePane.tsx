import { useEffect, useMemo, useState } from 'react'
import './tokenUsagePane.css'
import type { TokenUsageRow } from '../../main/ipc/tokenUsageHandlers'

// Token 用量汇总:工作区 × provider × 每天 的输入/输出 token。数据来自每个工作区会话里每条 AI 消息记录的
// 每轮 token 成本(input+output)。可按工作区/provider 筛选、按维度分组查看。历史消息(本功能上线前)没有
// token 记录,故越往后越全 —— 面板顶部有说明。
function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

type GroupBy = 'day' | 'workspace' | 'provider'

export function TokenUsagePane() {
  const [rows, setRows] = useState<TokenUsageRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ws, setWs] = useState<string>('all')
  const [prov, setProv] = useState<string>('all')
  const [group, setGroup] = useState<GroupBy>('day')

  const load = () => {
    setErr(null)
    void Promise.resolve(window.forge.tokenUsageAggregate?.())
      .then((r) => setRows(r ?? []))
      .catch((e) => setErr(String(e?.message ?? e)))
  }
  useEffect(load, [])

  const workspaces = useMemo(() => [...new Set((rows ?? []).map((r) => r.workspace))].sort(), [rows])
  const providers = useMemo(() => [...new Set((rows ?? []).map((r) => r.provider))].sort(), [rows])

  const filtered = useMemo(() => (rows ?? []).filter((r) =>
    (ws === 'all' || r.workspace === ws) && (prov === 'all' || r.provider === prov)), [rows, ws, prov])

  const total = useMemo(() => filtered.reduce((a, r) => ({ input: a.input + r.input, output: a.output + r.output, turns: a.turns + r.turns }), { input: 0, output: 0, turns: 0 }), [filtered])

  // 分组聚合:按选中的维度合并。
  const grouped = useMemo(() => {
    const m = new Map<string, { label: string; sub: string; input: number; output: number; turns: number }>()
    for (const r of filtered) {
      const key = group === 'day' ? r.day : group === 'workspace' ? r.workspace : r.provider
      const label = key
      const sub = group === 'day' ? `${r.workspace} · ${r.provider}` : group === 'workspace' ? `${r.day} · ${r.provider}` : `${r.day} · ${r.workspace}`
      const cur = m.get(key) ?? { label, sub, input: 0, output: 0, turns: 0 }
      cur.input += r.input; cur.output += r.output; cur.turns += r.turns
      m.set(key, cur)
    }
    return [...m.values()].sort((a, b) => (group === 'day' ? b.label.localeCompare(a.label) : (b.input + b.output) - (a.input + a.output)))
  }, [filtered, group])

  return (
    <div className="tu-pane">
      <div className="tu-head">
        <div>
          <h2>Token 用量</h2>
          <p className="tu-note">按工作区 × provider × 每天统计每轮对话的输入/输出 token。仅统计本功能上线后记录的消息;部分 provider 未上报用量时可能缺失。</p>
        </div>
        <button className="tu-refresh" onClick={load}>刷新</button>
      </div>

      <div className="tu-totals">
        <div className="tu-stat"><span className="tu-stat-v">{fmt(total.input)}</span><span className="tu-stat-l">输入</span></div>
        <div className="tu-stat"><span className="tu-stat-v">{fmt(total.output)}</span><span className="tu-stat-l">输出</span></div>
        <div className="tu-stat"><span className="tu-stat-v">{fmt(total.input + total.output)}</span><span className="tu-stat-l">合计</span></div>
        <div className="tu-stat"><span className="tu-stat-v">{total.turns}</span><span className="tu-stat-l">轮次</span></div>
      </div>

      <div className="tu-filters">
        <label>工作区
          <select value={ws} onChange={(e) => setWs(e.target.value)}>
            <option value="all">全部</option>
            {workspaces.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </label>
        <label>Provider
          <select value={prov} onChange={(e) => setProv(e.target.value)}>
            <option value="all">全部</option>
            {providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>分组
          <select value={group} onChange={(e) => setGroup(e.target.value as GroupBy)}>
            <option value="day">按天</option>
            <option value="workspace">按工作区</option>
            <option value="provider">按 Provider</option>
          </select>
        </label>
      </div>

      {err ? <div className="tu-empty">读取失败:{err}</div>
        : rows == null ? <div className="tu-empty">加载中…</div>
        : grouped.length === 0 ? <div className="tu-empty">暂无用量数据。开始几轮对话后再回来看(历史消息没有 token 记录)。</div>
        : (
          <div className="tu-table">
            <div className="tu-row tu-th">
              <span>{group === 'day' ? '日期' : group === 'workspace' ? '工作区' : 'Provider'}</span>
              <span className="tu-num">输入</span>
              <span className="tu-num">输出</span>
              <span className="tu-num">合计</span>
              <span className="tu-num">轮次</span>
            </div>
            {grouped.map((g) => (
              <div className="tu-row" key={g.label}>
                <span className="tu-lbl"><b>{g.label}</b><i>{g.sub}</i></span>
                <span className="tu-num">{fmt(g.input)}</span>
                <span className="tu-num">{fmt(g.output)}</span>
                <span className="tu-num tu-strong">{fmt(g.input + g.output)}</span>
                <span className="tu-num">{g.turns}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  )
}
