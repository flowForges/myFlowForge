import { useState } from 'react'
import { PluginEditor } from '../components/PluginEditor'
import type { LibraryHook } from '@shared/plugin'
import { movePluginBefore } from '../../shared/pluginReorder'
import { ImportModal, type ImportConfig } from '../components/ImportModal'
import { PLUGIN_SAMPLE, parsePlugins, type ParsedPlugin } from '../components/importParsers'

// The 5 prototype presets (name + prompt), reused from the wizard/WorkflowPane.
const PLUGIN_PRESETS = [
  { name: '当前时间',     glyph: 'clock',  prompt: '输出当前系统日期与时间(ISO 8601),作为后续阶段的时间上下文。' },
  { name: '读取我的记忆', glyph: 'memory', prompt: '读取项目记忆与我的历史偏好,整理成要点后注入后续阶段的上下文。' },
  { name: '拉取最新主干', glyph: 'git',    prompt: '在开始前执行 git fetch,并基于最新 origin/main 创建工作分支。' },
  { name: '运行 Lint',    glyph: 'check',  prompt: '对改动文件运行项目 lint / 格式化,把问题列表交给下一阶段。' },
  { name: '空白 Hook',    glyph: 'puzzle', prompt: '' },
]

const IMP_UPLOAD = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
)
const PUZZLE_SVG = (
  <svg className="pz" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.6 2.6 0 0 1 0 5.2H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.6 2.6 0 0 1 5.2 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z" /></svg>
)
const PLUS_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
)
const X_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
)

interface HookLibraryPaneProps {
  hooks: LibraryHook[]
  onSave: (hook: LibraryHook) => void
  onDelete: (id: string) => void
  onSetAll: (hooks: LibraryHook[]) => void
}

// editId: string → editing that hook; null → adding a new one; undefined state (no editor) = closed.
type EditState = { editId: string | null } | null

export function HookLibraryPane({ hooks, onSave, onDelete, onSetAll }: HookLibraryPaneProps) {
  const [editing, setEditing] = useState<EditState>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [importCfg, setImportCfg] = useState<ImportConfig | null>(null)

  // movePluginBefore operates on {id, after}[]; library hooks have no `after`, so wrap with a constant
  // `after` for the reorder math, then strip it back off.
  const reorder = (dragId: string, targetId: string) => {
    const withAfter = hooks.map(h => ({ ...h, after: '__lib' }))
    const next = movePluginBefore(withAfter, dragId, targetId)
    if (next !== withAfter) onSetAll(next.map(({ after: _after, ...h }) => h))
  }

  const handleSave = (result: { name: string; prompt: string; skills: string[]; tools: string[] }) => {
    if (!editing) return
    if (editing.editId) {
      const cur = hooks.find(h => h.id === editing.editId)
      if (cur) onSave({ ...cur, name: result.name, prompt: result.prompt, skills: result.skills, tools: result.tools })
    } else {
      onSave({ id: `hk-${crypto.randomUUID()}`, name: result.name, prompt: result.prompt, skills: result.skills, tools: result.tools })
    }
    setEditing(null)
  }

  const openImport = () => setImportCfg({
    mark: 'plugin', title: '批量导入 Hook', goLabel: '导入 Hook',
    desc: '一次性把多个 hook 导入 Hook 库。每个 hook 含名称、prompt,可选技能 / 工具(插入位置在建区时选择,导入会忽略)。',
    subTitle: 'Hook 定义(JSON)', sample: PLUGIN_SAMPLE,
    placeholder: '粘贴 hook JSON 数组,或点「上传文件」。每条至少要有 name。',
    drop: 'after 字段会被忽略(库条目槽位无关)。未知的技能 / 工具会被丢弃。',
    parse: (t) => parsePlugins(t),
    onImport: (items) => {
      const list = items as ParsedPlugin[]
      const added: LibraryHook[] = list.map(it => ({
        id: `hk-${crypto.randomUUID()}`, name: it.name, prompt: it.prompt, skills: it.skills, tools: it.tools,
      }))
      onSetAll([...hooks, ...added])
      return `已向 Hook 库导入 ${added.length} 个 hook`
    },
  })

  return (
    <>
      <div className="set-group">
        <h4>Hook 库</h4>
        <p className="set-desc">
          管理可复用的插件 / hook。建区时可以在任意插入位置(基本信息后 / 涉及项目后 / 工作流各阶段间 / 工作流完成后)
          直接从这里选择,或在建区时新建并勾选「保存到 Hook 库」回存到这里。库条目与执行位置无关,选中时才决定插在哪。
        </p>

        <div className="wf-mgr" style={{ marginTop: 14 }}>
          <div className="wf-mgr-row">
            <div className="wf-mgr-top">
              <span className="nm">全部 Hook</span>
              <span className="ct">{hooks.length} 条</span>
              <button className="imp-btn wf-imp" title="批量导入 Hook" onClick={openImport}>
                {IMP_UPLOAD}批量导入
              </button>
            </div>

            <div className="wf-flow">
              {hooks.length === 0 && editing === null && (
                <span className="cr-proj-empty" style={{ margin: 0 }}>还没有 hook,点下面「新增 Hook」创建一个。</span>
              )}
              {hooks.map(h => (
                <span
                  key={h.id}
                  className="wf-plug-chip click"
                  data-hklib={h.id}
                  onClick={() => setEditing({ editId: h.id })}
                  title="编辑 hook"
                  draggable
                  onDragStart={() => setDraggedId(h.id)}
                  onDragEnd={() => setDraggedId(null)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); if (draggedId && draggedId !== h.id) reorder(draggedId, h.id); setDraggedId(null) }}
                >
                  {PUZZLE_SVG}
                  {h.name}
                  <button className="x" title="删除" onClick={e => { e.stopPropagation(); onDelete(h.id); setEditing(cur => cur?.editId === h.id ? null : cur) }}>
                    {X_SVG}
                  </button>
                </span>
              ))}
              <button className="wf-ins" title="新增 Hook" onClick={() => setEditing({ editId: null })}>
                {PLUS_SVG}
              </button>
            </div>

            {editing && (
              <PluginEditor
                afterLabel="可复用 Hook · 建区时选择插入位置"
                presets={editing.editId ? undefined : PLUGIN_PRESETS}
                initial={editing.editId ? hooks.find(h => h.id === editing.editId) : undefined}
                onSave={handleSave}
                onCancel={() => setEditing(null)}
              />
            )}
          </div>
        </div>
      </div>
      <ImportModal config={importCfg} onClose={() => setImportCfg(null)} />
    </>
  )
}
