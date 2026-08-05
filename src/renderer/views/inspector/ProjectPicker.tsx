// 项目选择器 (project picker) — switches which worktree the inspector's 变更/文件树
// panes display. Offers "全部项目" (aggregate across every project worktree) plus each project.
// 自绘下拉(复用 .menu-item 样式),取代原生 <select> —— 原生下拉的展开列表由系统绘制(白底蓝条),
// 跟主题/皮肤完全不搭。样式见 inspector.css 的 .insp-proj / .ipk-*。
import { useEffect, useRef, useState } from 'react'

// Sentinel cwd meaning "aggregate across all project worktrees". The workspace ROOT dir
// is NOT a git repo (projects are separate worktrees), so we no longer offer it.
export const ALL_PROJECTS = '__ALL__'

const CHEV = (
  <svg className="ipk-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
)
const CHECK = (
  <svg className="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

export function ProjectPicker({
  projects,
  activeCwd,
  onSelect
}: {
  projects: { name: string; cwd: string }[]
  activeCwd: string | undefined
  onSelect: (cwd: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // De-dupe by cwd.
  const seen = new Set<string>()
  const realProjects: { name: string; cwd: string }[] = []
  for (const p of projects) if (!seen.has(p.cwd)) { realProjects.push(p); seen.add(p.cwd) }

  // 点外面 / Esc 关闭。仅在展开时挂监听。
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc) }
  }, [open])

  // Only worth showing the picker when there's more than one project (otherwise "全部项目"
  // and the single project are equivalent).
  if (realProjects.length <= 1) return null

  const options = [{ name: '全部项目', cwd: ALL_PROJECTS }, ...realProjects]
  const active = options.find(o => o.cwd === (activeCwd ?? ALL_PROJECTS)) ?? options[0]

  return (
    <div className={`insp-proj menu${open ? ' open' : ''}`} ref={ref}>
      <button className="ipk-trigger" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-haspopup="listbox">
        <span className="ipk-name">{active.name}</span>
        {CHEV}
      </button>
      <div className="menu-pop ipk-pop" role="listbox">
        {options.map(o => (
          <button
            key={o.cwd}
            className={`menu-item${o.cwd === active.cwd ? ' on' : ''}`}
            role="option"
            aria-selected={o.cwd === active.cwd}
            onClick={() => { onSelect(o.cwd); setOpen(false) }}
          >
            {o.name}{CHECK}
          </button>
        ))}
      </div>
    </div>
  )
}
