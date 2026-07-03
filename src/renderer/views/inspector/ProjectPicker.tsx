// 项目选择器 (project picker) — switches which worktree the inspector's 变更/文件树
// panes display. Offers "全部项目" (aggregate across every project worktree) plus each
// project. Styling lives in inspector.css (.insp-proj).

// Sentinel cwd meaning "aggregate across all project worktrees". The workspace ROOT dir
// is NOT a git repo (projects are separate worktrees), so we no longer offer it.
export const ALL_PROJECTS = '__ALL__'

export function ProjectPicker({
  projects,
  activeCwd,
  onSelect
}: {
  projects: { name: string; cwd: string }[]
  activeCwd: string | undefined
  onSelect: (cwd: string) => void
}) {
  // De-dupe by cwd.
  const seen = new Set<string>()
  const realProjects: { name: string; cwd: string }[] = []
  for (const p of projects) if (!seen.has(p.cwd)) { realProjects.push(p); seen.add(p.cwd) }

  // Only worth showing the picker when there's more than one project (otherwise "全部项目"
  // and the single project are equivalent).
  if (realProjects.length <= 1) return null

  const options = [{ name: '全部项目', cwd: ALL_PROJECTS }, ...realProjects]
  return (
    <div className="insp-proj">
      <select value={activeCwd ?? ''} onChange={(e) => onSelect(e.target.value)}>
        {options.map((o) => (
          <option key={o.cwd} value={o.cwd}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  )
}
