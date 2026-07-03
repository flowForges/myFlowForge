import { useEffect, useState } from 'react'
import type { InstalledSkill } from '@shared/types'

const SKILL_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
  </svg>
)

// Read-only list of the skills actually installed under the user's home agent dirs. There is no
// enable/disable toggle — agents auto-discover skills from disk, so this pane just reflects reality.
export function SkillPane() {
  const [skills, setSkills] = useState<InstalledSkill[] | null>(null)

  useEffect(() => {
    let live = true
    window.forge.listSkills().then(s => { if (live) setSkills(s) }).catch(() => { if (live) setSkills([]) })
    return () => { live = false }
  }, [])

  const groups = (skills ?? []).reduce<Record<string, InstalledSkill[]>>((acc, s) => {
    (acc[s.source] ??= []).push(s)
    return acc
  }, {})
  const sources = Object.keys(groups)

  return (
    <div className="set-group">
      <h4>已安装的 Skill</h4>
      {skills === null ? (
        <div className="proj-empty">扫描中…</div>
      ) : sources.length === 0 ? (
        <div className="proj-empty">未发现已安装的 skill(在 ~/.claude/skills、~/.codex/skills 等下)</div>
      ) : (
        sources.map(source => (
          <div key={source}>
            <div className="skill-src-h">{source} · {groups[source].length}</div>
            {groups[source].map(s => (
              <div className="skill-item" key={s.path}>
                <div className="skill-ic">{SKILL_ICON}</div>
                <div className="skill-meta">
                  <div className="t">{s.name}</div>
                  {s.description && <div className="d">{s.description}</div>}
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  )
}
