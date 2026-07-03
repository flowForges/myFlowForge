function fmt(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function ArchiveNote({ createdAt, archivedAt }: { createdAt: number; archivedAt: number | null }) {
  return (
    <div className="ws-archive-note">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
      <span>这个工作区已归档。历史会话、文件树、变更和 Session ID 可查看与复制；恢复前不能继续会话、置顶或运行 Agent。创建 {fmt(createdAt)} · 已归档 {fmt(archivedAt ?? 0)}</span>
    </div>
  )
}
