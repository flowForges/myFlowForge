import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { WorkspaceMeta, RunState, AgentState, HomeStats, HomeWsStat } from '@shared/types'
import { InstallBanner } from './InstallBanner'
import { QuickStart } from './QuickStart'

// Live local-time greeting: time-of-day salutation + a ticking clock (weekday · date · 时段) in the
// user's own timezone (new Date() is local). The seconds tick supplies the motion; the block also
// fades/slides in on mount (see .home-hi / .home-clock in home.css).
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function periodOf(h: number): { hi: string; tod: string } {
  if (h < 5) return { hi: '夜深了', tod: '凌晨' }
  if (h < 9) return { hi: '早上好', tod: '清晨' }
  if (h < 11) return { hi: '上午好', tod: '上午' }
  if (h < 13) return { hi: '中午好', tod: '中午' }
  if (h < 18) return { hi: '下午好', tod: '下午' }
  if (h < 23) return { hi: '晚上好', tod: '晚上' }
  return { hi: '夜深了', tod: '深夜' }
}
function HomeGreeting() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id) }, [])
  const p = periodOf(now.getHours())
  const p2 = (n: number) => String(n).padStart(2, '0')
  const time = `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`
  return (
    <div className="home-hi">
      <span className="home-hi-wave" aria-hidden="true">~</span> {p.hi}
      <span className="home-clock">
        <span className="hc-dot" aria-hidden="true" />
        <span className="hc-time">{time}</span>
        <span className="hc-sep">·</span>{WEEKDAYS[now.getDay()]}
        <span className="hc-sep">·</span>{now.getMonth() + 1}月{now.getDate()}日
        <span className="hc-sep">·</span>{p.tod}
      </span>
    </div>
  )
}

// ---- module-level SVG consts (1:1 with the prototype markup) ----
const PLUS_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
)
const LINES_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7h18M3 12h18M3 17h18" /></svg>
)
const ENTER_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
)
const GIT_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
)
const FOLDER_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
)

type Status = WorkspaceMeta['status']
function statusLabel(s: Status): string {
  switch (s) {
    case 'run': return '运行中'
    case 'ok': return '已完成'
    case 'err': return '失败'
    default: return '空闲'
  }
}
function tagClass(s: Status): string {
  switch (s) {
    case 'run': return 'tag-run'
    case 'ok': return 'tag-ok'
    case 'err': return 'tag-err'
    default: return 'tag-idle'
  }
}
const stageClass = (s: AgentState): string => (s === 'ok' ? 's-ok' : s === 'run' ? 's-run' : 's-wait')
const agentClass = (s: AgentState): string => (s === 'ok' ? 'a-ok' : s === 'run' ? 'a-run' : 'a-wait')

// Relative last-activity label (workspace.json mtime). 0 → unknown.
function relTime(ms: number): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const d = new Date(ms)
  return `${d.getMonth() + 1}-${d.getDate()}`
}

// Colored +added ~edited −deleted file counts (prototype colorChanges). Empty → 无改动.
function ChangeBits({ c }: { c?: HomeWsStat['changes'] }): ReactNode {
  const bits: ReactNode[] = []
  if (c?.a) bits.push(<span className="a" key="a">+{c.a}</span>)
  if (c?.e) bits.push(<span className="e" key="e">~{c.e}</span>)
  if (c?.d) bits.push(<span className="d" key="d">−{c.d}</span>)
  if (!bits.length) return <span style={{ color: 'var(--faint)' }}>无改动</span>
  return <>{bits.map((b, i) => <Fragment key={i}>{i > 0 ? ' ' : ''}{b}</Fragment>)}</>
}

interface Props {
  workspaces: WorkspaceMeta[]
  stats: HomeStats           // per-workspace branch / change counts / last-activity (keyed by path)
  activeRunPath?: string
  run?: RunState             // the live engine run, used to fill the focus card with real stages/agents
  onNew: () => void
  onOpenDir: () => void
  onQuickFolder: () => void  // 空态:选个文件夹建纯对话工作区
  onOpenWorkspace: (meta: WorkspaceMeta) => void
  onOpenSettings: () => void
}

export function HomeView({ workspaces, stats, activeRunPath, run, onNew, onOpenDir, onQuickFolder, onOpenWorkspace, onOpenSettings }: Props) {
  const eff = (w: WorkspaceMeta): Status => (activeRunPath === w.path ? 'run' : w.status)

  // Archived workspaces live only in the sidebar's archive dock — never on the home page.
  // Pinned workspaces sort to the top (stable), so a pinned one becomes the focus card when
  // nothing is running.
  const visible = workspaces.filter(w => !w.archived)
  const ordered = [...visible].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))

  // The focus workspace = the running one, else the first (pinned-first) workspace. Its live
  // stages/agents come from the engine run (only available for the workspace actually running).
  const focus = ordered.find(w => eff(w) === 'run') ?? ordered[0]
  const focusRun = run && focus && run.workspacePath === focus.path ? run : undefined
  const stages = (focusRun?.stages ?? []).filter(s => !s.key.startsWith('hook'))
  const agents = stages.flatMap(s => s.agents)
  const liveAgents = agents.filter(a => a.state === 'run').length
  const done = stages.filter(s => s.state === 'ok').length
  const inflight = stages.filter(s => s.state === 'run').length
  const pct = stages.length ? Math.round(((done + inflight * 0.5) / stages.length) * 100) : 0

  // Aggregate change counts across visible workspaces for the 今日改动 stat cell.
  const tot = visible.reduce(
    (acc, w) => { const c = stats[w.path]?.changes; return c ? { a: acc.a + c.a, e: acc.e + c.e, d: acc.d + c.d } : acc },
    { a: 0, e: 0, d: 0 }
  )
  const runningCount = visible.filter(w => eff(w) === 'run').length
  const statCells: [string, ReactNode][] = [
    ['工作区', visible.length],
    ['进行中', runningCount],
    ['代理在跑', liveAgents],
    ['今日改动', <><span className="a">+{tot.a}</span> <small><span className="e">~{tot.e}</span> <span className="d">−{tot.d}</span></small></>],
  ]

  const focusStat = focus ? stats[focus.path] : undefined
  const rest = ordered.filter(w => w !== focus)

  return (
    <section className="view on" id="view-home">
      <div className="home-wrap">
        {/* Aurora backdrop — a few color blobs drift independently behind the hero for motion + depth. */}
        <div className="home-aurora" aria-hidden="true"><span /><span /><span /></div>
        <InstallBanner onGoSettings={onOpenSettings} />
        <header className="home-head">
          <div className="home-head-l">
            <HomeGreeting />
            <h1 className="home-h1">继续构建</h1>
          </div>
          <div className="home-actions">
            <button className="home-cta" onClick={onNew}>{PLUS_SVG}新建工作区</button>
            <button className="home-cta ghost" onClick={onOpenDir}>{LINES_SVG}打开本地目录</button>
          </div>
        </header>

        <div className="home-stats">
          {statCells.map(([k, v]) => (
            <div className="hs-cell" key={k}><span className="hs-k">{k}</span><span className="hs-v">{v}</span></div>
          ))}
        </div>

        {/* 首次使用引导:仅空态(没有任何工作区)显示,可「不再显示」关闭并持久化。 */}
        {visible.length === 0 && <QuickStart onQuickFolder={onQuickFolder} onNew={onNew} />}

        {visible.length === 0 && (
          <div className="home-empty">
            <div className="he-title">从这里开始</div>
            <div className="he-sub">工作区是一个本地文件夹。你可以配置 Git 项目走完整工作流,也可以只选个文件夹直接对话。</div>
            <div className="he-cards">
              <button className="he-card" onClick={onNew}>
                <div className="he-ic">{PLUS_SVG}</div>
                <div className="he-c-t">配置项目工作区</div>
                <div className="he-c-d">选择一个或多个 Git 项目,配置阶段与代理,跑完整开发工作流。</div>
              </button>
              <button className="he-card" onClick={onQuickFolder}>
                <div className="he-ic">{FOLDER_SVG}</div>
                <div className="he-c-t">选个文件夹 · 直接对话</div>
                <div className="he-c-d">不需要项目。选一个位置(可新建文件夹),立即开始和代理对话。</div>
              </button>
            </div>
          </div>
        )}

        {focus && (
          <div className="home-focus">
            <button className="focus-card" data-ws={focus.path} onClick={() => onOpenWorkspace(focus)}>
              <div className="fc-top">
                {/* Only a live run gets a status indicator; idle/ok/err show nothing (per user). */}
                {eff(focus) === 'run' && <span className="ws-dot run" />}
                <span className="fc-name">{focus.name}</span>
                {focusStat && <span className="fc-branch">{GIT_SVG}{focusStat.branch}</span>}
                {eff(focus) === 'run' && <span className="fc-pill">{statusLabel('run')}</span>}
              </div>
              {stages.length > 0 && (
                <>
                  <div className="fc-sep" />
                  <div className="fc-flow">
                    {stages.map((st, i) => (
                      <Fragment key={st.key}>
                        {i > 0 && <span className="fc-arrow">›</span>}
                        <span className={`fc-stage ${stageClass(st.state)}`}><span className="sdot" />{st.name}</span>
                      </Fragment>
                    ))}
                  </div>
                  {agents.length > 0 && (
                    <div className="fc-agents">
                      {agents.map(a => (
                        <span className={`fc-ag ${agentClass(a.state)}`} key={a.id}><span className="agd" />{a.name}</span>
                      ))}
                    </div>
                  )}
                  <div className="fc-prog"><i style={{ width: `${pct}%` }} /></div>
                </>
              )}
              <div className="fc-foot">
                <span className="fc-changes"><ChangeBits c={focusStat?.changes} /></span>
                {focusStat && focusStat.updatedAt > 0 && <span>{relTime(focusStat.updatedAt)}</span>}
                <span className="fc-enter">进入工作区 {ENTER_SVG}</span>
              </div>
            </button>
          </div>
        )}

        {rest.length > 0 && (
          <>
            <div className="section-h">其他工作区</div>
            <div className="home-list">
              {rest.map(w => {
                const st = stats[w.path]
                return (
                  <button className="wl-row" data-ws={w.path} key={w.path} onClick={() => onOpenWorkspace(w)}>
                    {/* Only a live run gets a dot + tag; other states show no status (per user). */}
                    {eff(w) === 'run' && <span className="ws-dot run" />}
                    <span className="wl-name">{w.name}</span>
                    <span className="wl-path">{w.path}</span>
                    <span className="wl-changes"><ChangeBits c={st?.changes} /></span>
                    {eff(w) === 'run' && <span className={`wl-tag ${tagClass('run')}`}>{statusLabel('run')}</span>}
                    <span className="wl-time">{st ? relTime(st.updatedAt) : '—'}</span>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
