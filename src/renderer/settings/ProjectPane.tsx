import { useState } from 'react'
import type { CfgProject } from '../state/useConfig'
import { ImportModal, type ImportConfig } from '../components/ImportModal'
import { PROJ_SAMPLE, parseProjects, type ParsedProject } from '../components/importParsers'

const UPLOAD_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
)

interface ProjectPaneProps {
  projects: CfgProject[]
  onAdd: (repoUrl: string, branch: string) => void
  onDelete: (id: string) => void
}

function deriveName(url: string): string {
  if (!url) return ''
  const s = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  return (s.split(/[/:]/).pop() || '').trim()
}

const ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <circle cx="12" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="18" r="2.4" />
    <path d="M12 8.4v2.1a3.5 3.5 0 0 1-3.5 3.5H8M12 10.5a3.5 3.5 0 0 0 3.5 3.5H16" />
  </svg>
)

const BRANCH = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
)

const TRASH = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
)

export function ProjectPane({ projects, onAdd, onDelete }: ProjectPaneProps) {
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [importCfg, setImportCfg] = useState<ImportConfig | null>(null)

  const derived = deriveName(repo)
  const canAdd = !!derived

  const add = () => {
    if (!canAdd) return
    onAdd(repo.trim(), branch.trim() || 'main')
    setRepo(''); setBranch('')
  }

  const openImport = () => setImportCfg({
    mark: 'project', title: '批量导入项目', goLabel: '导入项目',
    desc: '一次性导入多个 Git 项目 —— 粘贴 JSON 数组,或上传一个文件。已存在的会自动跳过。',
    subTitle: '项目清单', sample: PROJ_SAMPLE,
    placeholder: '粘贴 JSON 数组,或每行「仓库地址, 分支」。也可点「上传文件」选择本地文件。',
    drop: '支持 .json / .txt。先「复制示例」编辑好再上传,或直接粘贴。',
    parse: (t) => parseProjects(t),
    onImport: (items) => {
      const list = items as ParsedProject[]
      const existing = new Set(projects.map(p => p.repoUrl))
      let added = 0, dup = 0
      for (const it of list) {
        if (existing.has(it.repo)) { dup++; continue }
        existing.add(it.repo)
        onAdd(it.repo, it.branch)
        added++
      }
      return `已导入 ${added} 个项目` + (dup ? `(${dup} 个已存在,跳过)` : '')
    },
  })

  return (
    <div className="set-group">
      <div className="set-group-h">
        <h4>Git 项目</h4>
        <button className="imp-btn" onClick={openImport}>{UPLOAD_SVG}批量导入</button>
      </div>
      <div className="proj-add">
        <div className="row">
          <div className="proj-field f-repo">
            <label htmlFor="projRepo">Git 仓库地址 / 本地路径</label>
            <input
              id="projRepo"
              placeholder="git@github.com:acme/design-system-v3.git"
              value={repo}
              onChange={e => setRepo(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
            />
          </div>
          <div className="proj-field f-branch">
            <label htmlFor="projBranch">分支名</label>
            <input
              id="projBranch"
              placeholder="main"
              value={branch}
              onChange={e => setBranch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
            />
          </div>
        </div>
        <div className="proj-add-foot">
          <div className="proj-derive" id="projDerive">
            {derived ? <>项目名将自动取自仓库 — <b>{derived}</b></> : '项目名将自动取自仓库 —'}
          </div>
          <button className="btn-add" id="projAdd" disabled={!canAdd} onClick={add}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            添加项目
          </button>
        </div>
      </div>
      <div className="proj-list" id="projList">
        {projects.length === 0 ? (
          <div className="proj-empty">还没有配置任何 Git 项目。在上方添加一个开始。</div>
        ) : (
          projects.map(p => (
            <div className="proj-row" data-pid={p.id} key={p.id}>
              <div className="proj-ic">{ICON}</div>
              <div className="proj-info">
                <div className="t">
                  {p.name}
                  <span className="branch">{BRANCH}{p.defaultBranch}</span>
                </div>
                <div className="repo">{p.repoUrl}</div>
              </div>
              <button className="proj-del" data-del={p.id} title="移除项目" onClick={() => onDelete(p.id)}>
                {TRASH}
              </button>
            </div>
          ))
        )}
      </div>
      <ImportModal config={importCfg} onClose={() => setImportCfg(null)} />
    </div>
  )
}
