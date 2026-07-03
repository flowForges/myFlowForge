import { useEffect, useMemo, useState } from 'react'
import type { ScanResult, DiscoveredSession, ImportedMessage, ChatMessage, GitRepoCandidate, SessionImportCoverage } from '@shared/types'
import { MessageStream } from '../views/chat/MessageStream'
import { applyImportFilter, type ImportStatus } from './sessionImportFilter'

const SOURCE_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', qoder: 'Qoder' }
const FILTERS = ['all', 'claude', 'codex', 'cursor', 'qoder'] as const

function fmtAgo(ms: number): string {
  const d = Date.now() - ms
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return `${Math.floor(d / 86_400_000)} 天前`
}

function toChatMessage(im: ImportedMessage, i: number): ChatMessage {
  return { id: String(i), who: im.who, text: im.text, ts: im.ts }
}
function key(s: DiscoveredSession) { return `${s.source}::${s.externalId}` }

export function SessionImportPane() {
  const [scanRes, setScanRes] = useState<ScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const [status, setStatus] = useState<ImportStatus>('all')
  const [importedKeys, setImportedKeys] = useState<Set<string>>(new Set())
  const [viewer, setViewer] = useState<{ title: string; msgs: ImportedMessage[] } | null>(null)
  const [gitRepos, setGitRepos] = useState<GitRepoCandidate[]>([])
  const [coverage, setCoverage] = useState<SessionImportCoverage | null>(null)
  const [showExisting, setShowExisting] = useState(false)

  useEffect(() => {
    window.forge.sessionImportList().then(idx => setImportedKeys(new Set(idx.sessions.map(key))))
    window.forge.sessionImportLastScan().then(c => { if (c) setScanRes(c) })
    window.forge.sessionImportCoverage().then(setCoverage)
  }, [])

  const doScan = async () => { setScanning(true); try { setScanRes(await window.forge.sessionImportScan()) } finally { setScanning(false) } }
  const doImport = async (sessions: DiscoveredSession[]) => {
    const res = await window.forge.sessionImportRun(sessions)
    setImportedKeys(prev => { const n = new Set(prev); sessions.forEach(s => n.add(key(s))); return n })
    setGitRepos(res.gitRepos)
  }
  const openViewer = async (s: DiscoveredSession) => {
    const msgs = await window.forge.sessionImportRead(s)
    setViewer({ title: s.title, msgs })
  }

  const groups = useMemo(() => {
    if (!scanRes) return []
    return scanRes.groups
      .map(g => ({ ...g, sessions: applyImportFilter(g.sessions, importedKeys, status, filter) }))
      .filter(g => g.sessions.length)
  }, [scanRes, filter, importedKeys, status])

  // Split: genuinely external sessions (importable as new workspaces) vs. those already living under
  // one of our workspaces (matched) — the latter don't need importing, so they're tucked away.
  const newGroups = useMemo(() => groups.filter(g => !g.matched), [groups])
  const existingGroups = useMemo(() => groups.filter(g => g.matched), [groups])

  const renderGroup = (g: typeof groups[number]) => (
    <div className="si-group" key={g.wsPath}>
      <div className="si-group-head">
        <span className="si-cwd">{g.cwd}</span>
        <span className={`si-tag${g.matched ? ' on' : ''}`}>{g.matched ? '✓已是工作区' : '＋新建轻量工作区'}</span>
        {/* matched groups already live under a workspace — importing again is a no-op, so no button */}
        {!g.matched && <button className="btn-ghost" onClick={() => doImport(g.sessions)}>导入全部</button>}
      </div>
      {g.sessions.map(s => {
        const imported = importedKeys.has(key(s))
        return (
          <div className="si-row" key={key(s)}>
            <span className="si-src">{SOURCE_LABEL[s.source]}</span>
            <button className="si-title" onClick={() => openViewer(s)} disabled={!s.hasBody}>{s.title}</button>
            <span className="si-count">{s.messageCount} 条</span>
            {/* sessions in an already-imported workspace stay browsable but offer no per-row 导入 */}
            {!g.matched && <button className="btn-ghost" onClick={() => doImport([s])} disabled={imported}>{imported ? '已导入' : '导入'}</button>}
          </div>
        )
      })}
    </div>
  )

  if (viewer) {
    return (
      <div className="set-group">
        <button className="btn-ghost" onClick={() => setViewer(null)}>← 返回</button>
        <h4>{viewer.title}</h4>
        {viewer.msgs.length === 0
          ? <p className="set-desc">本会话无可读取的对话内容。</p>
          : <div className="si-viewer"><MessageStream messages={viewer.msgs.map(toChatMessage)} streamingIds={new Set()} /></div>}
      </div>
    )
  }

  return (
    <div className="set-group">
      <h4>原生会话导入</h4>
      <p className="set-desc">扫描本机 Claude / Codex / Cursor / qoder 的会话记录,只读浏览并导入。不会改写原生 app 的任何文件。</p>
      {coverage && (
        <p className="set-desc">
          已支持导入：{coverage.supported.map(s => s.label).join(' · ')}
          {coverage.unsupported.length > 0 && <>｜暂不支持：{coverage.unsupported.map(u => `${u.label}（${u.reason}）`).join('、')}</>}
        </p>
      )}
      <div className="si-bar">
        <button className="btn-add" onClick={doScan} disabled={scanning}>{scanning ? '扫描中…' : scanRes ? '重新扫描' : '🔄 扫描本机会话'}</button>
        {scanRes && <span className="si-meta">上次扫描于 {fmtAgo(scanRes.scannedAt)} · 发现 {scanRes.groups.reduce((n, g) => n + g.sessions.length, 0)} 个会话</span>}
      </div>
      <div className="si-filters">
        {FILTERS.map(f => <button key={f} className={`si-chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>{f === 'all' ? '全部' : SOURCE_LABEL[f]}</button>)}
        <span className="si-sep">|</span>
        {(['all', 'new', 'imported'] as ImportStatus[]).map(s => (
          <button key={s} className={`si-chip${status === s ? ' on' : ''}`} onClick={() => setStatus(s)}>
            {s === 'all' ? '全部' : s === 'new' ? '未导入' : '已导入'}
          </button>
        ))}
      </div>
      {gitRepos.length > 0 && (
        <div className="si-git-guide">
          <p className="set-desc">发现 {gitRepos.length} 个 git 仓库，是否加入项目库？</p>
          {gitRepos.map(g => (
            <div className="si-row" key={g.cwd}>
              <span className="si-cwd">{g.cwd}</span>
              {g.repoUrl
                ? <button className="btn-ghost" onClick={async () => { await window.forge.addProject({ repoUrl: g.repoUrl!, branch: g.branch }); setGitRepos(prev => prev.filter(x => x.cwd !== g.cwd)) }}>加入</button>
                : <span className="si-tag">无远程地址，暂不可加入</span>}
            </div>
          ))}
        </div>
      )}
      {scanRes && newGroups.length === 0 && existingGroups.length === 0 && (
        <p className="set-desc">没有匹配的会话。</p>
      )}
      {newGroups.length > 0 && <div className="si-section-h">可导入为新工作区 · {newGroups.length}</div>}
      {newGroups.map(renderGroup)}
      {existingGroups.length > 0 && (
        <>
          <button className="si-section-h si-section-toggle" onClick={() => setShowExisting(v => !v)}>
            <span className="si-section-chev">{showExisting ? '▾' : '▸'}</span>
            已在工作区中 · {existingGroups.length}
            <span className="si-section-note">（这些已是你的工作区，无需再次导入）</span>
          </button>
          {showExisting && existingGroups.map(renderGroup)}
        </>
      )}
    </div>
  )
}
