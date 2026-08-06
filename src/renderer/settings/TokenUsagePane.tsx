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
type SortKey = 'label' | 'input' | 'output' | 'total' | 'turns'
type SortDir = 'asc' | 'desc'

// 每页行数。按天分组时行数随时间线性增长(一年 365 行、两年 730),不分页迟早变成一条滚不到底的长列表。
export const TU_PAGE_SIZE = 25

export interface TuGroup {
  label: string
  /** 该组覆盖到的其它维度(去重后拼接)。按天分组时一天可能跨多个工作区/provider。 */
  sub: string
  input: number
  output: number
  turns: number
  estimated: boolean
}

// 纯排序,便于单测。label 用 localeCompare(日期字符串同样按字典序=时间序),数值列按数值。
export function sortGroups(rows: TuGroup[], key: SortKey, dir: SortDir): TuGroup[] {
  const sign = dir === 'asc' ? 1 : -1
  const val = (g: TuGroup): number => key === 'input' ? g.input : key === 'output' ? g.output
    : key === 'turns' ? g.turns : g.input + g.output
  return [...rows].sort((a, b) => key === 'label'
    ? sign * a.label.localeCompare(b.label)
    : sign * (val(a) - val(b)))
}

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
  // 修:副标题原先取「合并进来的第一条」的 workspace·provider,可一个分组通常横跨多条 —— 按天分组时
  // 那天明明用了 3 个工作区,却只显示其中一个,是纯粹的错误信息。改成收集全部去重后再拼。
  const grouped = useMemo<TuGroup[]>(() => {
    const m = new Map<string, TuGroup & { subSet: Set<string> }>()
    for (const r of filtered) {
      const key = group === 'day' ? r.day : group === 'workspace' ? r.workspace : r.provider
      const subPart = group === 'day' ? `${r.workspace} · ${r.provider}`
        : group === 'workspace' ? `${r.day} · ${r.provider}`
        : `${r.day} · ${r.workspace}`
      const cur = m.get(key) ?? { label: key, sub: '', input: 0, output: 0, turns: 0, estimated: false, subSet: new Set<string>() }
      cur.input += r.input; cur.output += r.output; cur.turns += r.turns
      if (r.estimated) cur.estimated = true
      cur.subSet.add(subPart)
      m.set(key, cur)
    }
    // 副标题最多列 3 条,再多用「等 N 项」收尾,避免一行撑爆。
    return [...m.values()].map(({ subSet, ...g }) => {
      const parts = [...subSet].sort()
      return { ...g, sub: parts.length <= 3 ? parts.join('，') : `${parts.slice(0, 3).join('，')} 等 ${parts.length} 项` }
    })
  }, [filtered, group])

  // 排序:默认按天=日期倒序(最近在前),其它维度=合计降序 —— 与改动前的行为一致,只是现在可点表头改。
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null)
  const effSort = sort ?? (group === 'day'
    ? { key: 'label' as SortKey, dir: 'desc' as SortDir }
    : { key: 'total' as SortKey, dir: 'desc' as SortDir })
  const sorted = useMemo(() => sortGroups(grouped, effSort.key, effSort.dir), [grouped, effSort.key, effSort.dir])

  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(sorted.length / TU_PAGE_SIZE))
  // 筛选/分组/排序一变,行集就变了,停在第 7 页会看到空白。回到第一页。
  useEffect(() => { setPage(0) }, [ws, prov, group, effSort.key, effSort.dir])
  const pageSafe = Math.min(page, pageCount - 1)
  const pageRows = useMemo(
    () => sorted.slice(pageSafe * TU_PAGE_SIZE, pageSafe * TU_PAGE_SIZE + TU_PAGE_SIZE),
    [sorted, pageSafe])

  // 点表头:同一列再点=反向,换列=用该列最有用的默认方向(标签升序、数值降序)。
  const toggleSort = (key: SortKey) => setSort(s => {
    const cur = s ?? effSort
    if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
    return { key, dir: key === 'label' ? 'asc' : 'desc' }
  })
  const sortMark = (key: SortKey) => effSort.key === key ? (effSort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  const anyEstimated = useMemo(() => filtered.some((r) => r.estimated), [filtered])

  return (
    <div className="tu-pane">
      <div className="tu-head">
        <div>
          <h2>Token 用量</h2>
          <p className="tu-note">按工作区 × provider × 每天统计每轮对话的输入/输出 token(输入≈喂给模型的上下文)。优先用 provider 真实上报的用量;未上报时(qoder/codex/cursor 等)按对话内容估算,标 <span className="tu-est-tag">≈估算</span>。仅统计本功能上线后记录的消息。</p>
        </div>
        <button className="tu-refresh" onClick={load}>刷新</button>
      </div>

      <div className="tu-totals">
        <div className="tu-stat"><span className="tu-stat-v">{fmt(total.input)}</span><span className="tu-stat-l">输入</span></div>
        <div className="tu-stat"><span className="tu-stat-v">{fmt(total.output)}</span><span className="tu-stat-l">输出</span></div>
        <div className="tu-stat"><span className="tu-stat-v">{anyEstimated ? '≈' : ''}{fmt(total.input + total.output)}</span><span className="tu-stat-l">合计</span></div>
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
              <button className="tu-sort" onClick={() => toggleSort('label')}>
                {group === 'day' ? '日期' : group === 'workspace' ? '工作区' : 'Provider'}{sortMark('label')}
              </button>
              <button className="tu-sort tu-num" onClick={() => toggleSort('input')}>输入{sortMark('input')}</button>
              <button className="tu-sort tu-num" onClick={() => toggleSort('output')}>输出{sortMark('output')}</button>
              <button className="tu-sort tu-num" onClick={() => toggleSort('total')}>合计{sortMark('total')}</button>
              <button className="tu-sort tu-num" onClick={() => toggleSort('turns')}>轮次{sortMark('turns')}</button>
            </div>
            {pageRows.map((g) => (
              <div className="tu-row" key={g.label}>
                <span className="tu-lbl"><b>{g.label}{g.estimated ? <span className="tu-est-tag" title="含按内容估算的轮次(该 provider 未上报真实用量)">≈估算</span> : null}</b><i>{g.sub}</i></span>
                <span className="tu-num">{fmt(g.input)}</span>
                <span className="tu-num">{fmt(g.output)}</span>
                <span className="tu-num tu-strong">{fmt(g.input + g.output)}</span>
                <span className="tu-num">{g.turns}</span>
              </div>
            ))}
            {pageCount > 1 && (
              <div className="tu-pager">
                <button disabled={pageSafe === 0} onClick={() => setPage(0)} title="第一页">«</button>
                <button disabled={pageSafe === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>上一页</button>
                <span className="tu-pager-at">
                  第 {pageSafe + 1} / {pageCount} 页 · 共 {sorted.length} 行
                </span>
                <button disabled={pageSafe >= pageCount - 1} onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}>下一页</button>
                <button disabled={pageSafe >= pageCount - 1} onClick={() => setPage(pageCount - 1)} title="最后一页">»</button>
              </div>
            )}
          </div>
        )}
    </div>
  )
}
