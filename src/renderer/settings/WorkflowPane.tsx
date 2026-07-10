import { useState } from 'react'
import { PluginEditor } from '../components/PluginEditor'
import { StageConfigEditor } from '../components/StageConfigEditor'
import type { CfgWorkflow, CfgStage } from '../state/useConfig'
import type { ProviderInfo } from '@shared/types'
import type { Plugin } from '@shared/plugin'
import { movePluginBefore } from '../../shared/pluginReorder'
import { ImportModal, type ImportConfig } from '../components/ImportModal'
import { PLUGIN_SAMPLE, parsePlugins, type ParsedPlugin } from '../components/importParsers'

const IMP_UPLOAD = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
)

// Mirrors STAGE_KEYS/STAGE_NAMES in src/main/config/schema.ts exactly.
// Defined locally to avoid pulling main-process code (zod, etc.) into the renderer bundle.
const STAGE_KEYS = ['requirement', 'design', 'develop', 'test', 'review'] as const
const STAGE_NAMES: Record<string, string> = {
  requirement: '需求评估',
  design: '技术方案设计',
  develop: '代码开发',
  test: '写单测',
  review: '代码 CR'
}

// Verbatim copy of STAGE_PROMPTS from src/main/config/schema.ts — kept in sync manually.
// These are the default prompts shown as read-only in the StagePromptEditor.
const STAGE_DEFAULT_PROMPT: Record<string, string> = {
  requirement: '拆解本次需求,明确目标、范围边界与验收标准;识别关键风险与待澄清的问题,并把结论整理成要点交给后续阶段。',
  design: '基于需求产出技术方案:模块划分、接口/数据结构设计、关键技术决策与替代方案,并评估技术风险与影响面。',
  develop: '按技术方案实现代码变更,遵循项目既有规范与目录约定;保持改动聚焦、可回滚,并在必要处补充说明性注释。',
  test: '为本次改动补充单元 / 回归测试,覆盖核心路径与边界条件;确保测试可独立运行且能稳定复现回归。',
  review: '审查改动 diff:正确性、安全性、规范与可维护性;区分「必须修复」与「建议项」,并明确是否可以合并。',
}

// The 5 prototype presets — name + prompt only (no glyph, accepted minor gap per task spec)
const PLUGIN_PRESETS = [
  { name: '当前时间',     glyph: 'clock',  prompt: '输出当前系统日期与时间(ISO 8601),作为后续阶段的时间上下文。' },
  { name: '读取我的记忆', glyph: 'memory', prompt: '读取项目记忆与我的历史偏好,整理成要点后注入后续阶段的上下文。' },
  { name: '拉取最新主干', glyph: 'git',    prompt: '在开始前执行 git fetch,并基于最新 origin/main 创建工作分支。' },
  { name: '运行 Lint',    glyph: 'check',  prompt: '对改动文件运行项目 lint / 格式化,把问题列表交给下一阶段。' },
  { name: '空白插件',     glyph: 'puzzle', prompt: '' },
]

function afterLabel(after: string): string {
  if (after === '__start') return '流程开始前'
  const name = STAGE_NAMES[after]
  return (name ?? after) + ' 之后'
}

const TRASH = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
)

const PLUS_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

const PUZZLE_SVG = (
  <svg className="pz" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.6 2.6 0 0 1 0 5.2H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.6 2.6 0 0 1 5.2 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z" />
  </svg>
)

const X_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

interface WorkflowPaneProps {
  workflows: CfgWorkflow[]
  providers?: ProviderInfo[]
  onCreate: (name: string, stageKeys: string[]) => void
  onDelete: (id: string) => void
  onUpdateWorkflow: (id: string, plugins: Plugin[]) => void
  onUpdateStagePrompts: (id: string, stagePrompts: Record<string, string>) => void
  // Full stage-list edit (#3): add/rename/delete/reorder stages + per-stage prompt/agent/flags.
  onUpdateStages?: (id: string, stages: CfgStage[]) => void
}

// Editor state: which workflow + which position + which plugin (null = new)
interface EditState { wfId: string; after: string; editId: string | null }
// A new custom stage gets a generated key; keep it URL/id-safe and unique within the workflow.
function newCustomStage(existing: CfgStage[]): CfgStage {
  let n = existing.filter(s => s.key.startsWith('custom-')).length + 1
  let key = `custom-${n}`
  while (existing.some(s => s.key === key)) key = `custom-${++n}`
  return { key, name: '新阶段', defaultAgent: 'claude', defaultModel: '', prompt: '' }
}

export function WorkflowPane({ workflows, providers = [], onCreate, onDelete, onUpdateWorkflow, onUpdateStages }: WorkflowPaneProps) {
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(['develop']))
  const [editing, setEditing] = useState<EditState | null>(null)
  const [stageEdit, setStageEdit] = useState<{ wfId: string; key: string } | null>(null)
  const [addingStageWf, setAddingStageWf] = useState<string | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [importCfg, setImportCfg] = useState<ImportConfig | null>(null)

  // —— 阶段编辑(#3):增删改排 + 每阶段 prompt/agent/flags,经 onUpdateStages 持久化整个 stages 列表 ——
  const putStages = (wf: CfgWorkflow, stages: CfgStage[]) => onUpdateStages?.(wf.id, stages)
  function saveStageConfig(wf: CfgWorkflow, key: string, patch: Partial<CfgStage>) {
    putStages(wf, wf.stages.map(s => s.key === key ? { ...s, ...patch } : s))
    setStageEdit(null)
  }
  function deleteStage(wf: CfgWorkflow, key: string) {
    if (wf.stages.length <= 1) return   // a workflow must keep at least one stage
    putStages(wf, wf.stages.filter(s => s.key !== key))
    setStageEdit(null)
  }
  function moveStage(wf: CfgWorkflow, key: string, dir: -1 | 1) {
    const i = wf.stages.findIndex(s => s.key === key)
    const j = i + dir
    if (i < 0 || j < 0 || j >= wf.stages.length) return
    const next = wf.stages.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    putStages(wf, next)
  }
  function addStage(wf: CfgWorkflow, stage: CfgStage) {
    if (wf.stages.some(s => s.key === stage.key)) return
    putStages(wf, [...wf.stages, stage])
    setAddingStageWf(null)
    setStageEdit({ wfId: wf.id, key: stage.key })   // open the new stage's editor immediately
  }

  function openImport(wf: { id: string; name: string; stages: { key: string }[]; plugins: Plugin[] }) {
    // Stages this workflow actually has — an imported plugin's `after` is clamped to one of these
    // (else __start), so it can never land on a stage the workflow lacks and silently never run.
    const ownStages = new Set<string>(['__start', ...wf.stages.map(s => s.key)])
    setImportCfg({
      mark: 'plugin', title: '批量导入插件 · ' + wf.name, goLabel: '导入插件',
      desc: `一次性把多个插件 / hook 导入「${wf.name}」。每个插件含名称、prompt,可选技能 / 工具 / 插入位置。`,
      subTitle: '插件定义(JSON)', sample: PLUGIN_SAMPLE,
      placeholder: '粘贴插件 JSON 数组,或点「上传文件」。每条至少要有 name;after 决定插在哪个阶段后。',
      drop: 'after 缺省为「流程开始前」。未知的技能 / 工具、以及该工作流没有的阶段会落到「流程开始前」。',
      parse: (t) => parsePlugins(t),
      onImport: (items) => {
        const list = items as ParsedPlugin[]
        const added: Plugin[] = list.map(it => ({
          id: `pl-${crypto.randomUUID()}`, name: it.name, prompt: it.prompt,
          after: ownStages.has(it.after) ? it.after : '__start',
          skills: it.skills, tools: it.tools,
        }))
        onUpdateWorkflow(wf.id, [...wf.plugins, ...added])
        return `已向「${wf.name}」导入 ${added.length} 个插件`
      },
    })
  }

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function create() {
    const nm = name.trim()
    if (!nm || picked.size === 0) return
    onCreate(nm, STAGE_KEYS.filter((k) => picked.has(k)))
    setName('')
    setPicked(new Set(['develop']))
  }

  function openInsert(wfId: string, after: string) {
    setStageEdit(null)
    setEditing({ wfId, after, editId: null })
  }

  function openEdit(wfId: string, pluginId: string) {
    // Find the plugin's after from the workflow
    const wf = workflows.find(w => w.id === wfId)
    const pl = wf?.plugins.find(p => p.id === pluginId)
    if (!pl) return
    setStageEdit(null)
    setEditing({ wfId, after: pl.after, editId: pluginId })
  }

  function handleSave(wfId: string, result: { name: string; prompt: string; skills: string[]; tools: string[] }) {
    if (!editing) return
    const wf = workflows.find(w => w.id === wfId)
    if (!wf) return

    let newPlugins: Plugin[]
    if (editing.editId) {
      // Edit existing
      newPlugins = wf.plugins.map(p =>
        p.id === editing.editId
          ? { ...p, name: result.name, prompt: result.prompt, skills: result.skills, tools: result.tools }
          : p
      )
    } else {
      // Insert new
      const newPlugin: Plugin = {
        id: `pl-${crypto.randomUUID()}`,
        name: result.name,
        prompt: result.prompt,
        after: editing.after,
        skills: result.skills,
        tools: result.tools,
      }
      newPlugins = [...wf.plugins, newPlugin]
    }

    onUpdateWorkflow(wfId, newPlugins)
    setEditing(null)
  }

  function handleDelete(wfId: string, pluginId: string) {
    const wf = workflows.find(w => w.id === wfId)
    if (!wf) return
    onUpdateWorkflow(wfId, wf.plugins.filter(p => p.id !== pluginId))
  }

  const canCreate = name.trim().length > 0 && picked.size > 0

  return (
    <>
      <div className="set-group">
        <h4>工作流模板</h4>
        <p className="set-desc">
          定义研发流程的阶段顺序。新建工作区时可直接选用,并按需增删阶段、设置每个阶段使用的模型。
        </p>
        <div className="wf-mgr" style={{ marginTop: 14 }}>
          {workflows.length === 0 ? (
            <div className="cr-proj-empty">还没有工作流模板,在下方创建一个。</div>
          ) : (
            workflows.map((w) => {
              const plugCount = (w.plugins ?? []).length
              const isThisEditing = editing?.wfId === w.id
              return (
                <div className="wf-mgr-row" data-wf={w.id} key={w.id}>
                  <div className="wf-mgr-top">
                    <span className="nm">{w.name}</span>
                    <span className="ct">{w.stages.length} 阶段</span>
                    {plugCount > 0 && <span className="pc">{plugCount} 插件</span>}
                    <button className="imp-btn wf-imp" title="批量导入插件" onClick={() => openImport(w)}>
                      {IMP_UPLOAD}批量导入
                    </button>
                    <button className="del" title="删除" data-wfdel={w.id} onClick={() => onDelete(w.id)}>
                      {TRASH}
                    </button>
                  </div>

                  {/* Flow strip with insert buttons and plugin chips */}
                  <div className="wf-flow">
                    {/* Insert before all stages (__start) */}
                    <button
                      className="wf-ins"
                      data-after="__start"
                      title={`在「${afterLabel('__start')}」插入插件`}
                      onClick={() => openInsert(w.id, '__start')}
                    >
                      {PLUS_SVG}
                    </button>
                    {/* Plugins after __start */}
                    {(w.plugins ?? []).filter(p => p.after === '__start').map(p => (
                      <span
                        key={p.id}
                        className="wf-plug-chip click"
                        onClick={() => openEdit(w.id, p.id)}
                        title="编辑插件 prompt"
                        draggable
                        onDragStart={() => setDraggedId(p.id)}
                        onDragEnd={() => setDraggedId(null)}
                        onDragOver={e => e.preventDefault()}
                        onDrop={e => {
                          e.preventDefault()
                          if (draggedId && draggedId !== p.id) {
                            const cur = w.plugins ?? []
                            const next = movePluginBefore(cur, draggedId, p.id)
                            if (next !== cur) onUpdateWorkflow(w.id, next)
                          }
                          setDraggedId(null)
                        }}
                      >
                        {PUZZLE_SVG}
                        {p.name}
                        <button
                          className="x"
                          title="移除插件"
                          onClick={(e) => { e.stopPropagation(); handleDelete(w.id, p.id) }}
                        >
                          {X_SVG}
                        </button>
                      </span>
                    ))}

                    {/* Stages with insert buttons after each */}
                    {w.stages.map((s, i) => (
                      <span key={s.key} style={{ display: 'contents' }}>
                        <span
                          className={'wf-stage-chip click' + ((s.prompt || w.stagePrompts?.[s.key]) ? ' edited' : '')}
                          title={`点击编辑「${s.name || STAGE_NAMES[s.key] || s.key}」阶段`}
                          onClick={() => { setEditing(null); setAddingStageWf(null); setStageEdit({ wfId: w.id, key: s.key }) }}
                        >
                          <span className="n">{i + 1}</span>
                          {s.name || STAGE_NAMES[s.key] || s.key}
                          {(s.prompt || w.stagePrompts?.[s.key]) && <span className="dot" />}
                          <svg className="pen" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                        </span>
                        <button
                          className="wf-ins"
                          data-after={s.key}
                          title={`在「${afterLabel(s.key)}」插入插件`}
                          onClick={() => openInsert(w.id, s.key)}
                        >
                          {PLUS_SVG}
                        </button>
                        {/* Plugins after this stage */}
                        {(w.plugins ?? []).filter(p => p.after === s.key).map(p => (
                          <span
                            key={p.id}
                            className="wf-plug-chip click"
                            onClick={() => openEdit(w.id, p.id)}
                            title="编辑插件 prompt"
                            draggable
                            onDragStart={() => setDraggedId(p.id)}
                            onDragEnd={() => setDraggedId(null)}
                            onDragOver={e => e.preventDefault()}
                            onDrop={e => {
                              e.preventDefault()
                              if (draggedId && draggedId !== p.id) {
                                const cur = w.plugins ?? []
                                const next = movePluginBefore(cur, draggedId, p.id)
                                if (next !== cur) onUpdateWorkflow(w.id, next)
                              }
                              setDraggedId(null)
                            }}
                          >
                            {PUZZLE_SVG}
                            {p.name}
                            <button
                              className="x"
                              title="移除插件"
                              onClick={(e) => { e.stopPropagation(); handleDelete(w.id, p.id) }}
                            >
                              {X_SVG}
                            </button>
                          </span>
                        ))}
                      </span>
                    ))}
                    {/* 新增阶段(#3):内置预置 或 空白自定义阶段 */}
                    {onUpdateStages && (
                      <button
                        className="wf-add-stage"
                        title="新增阶段"
                        onClick={() => { setEditing(null); setStageEdit(null); setAddingStageWf(addingStageWf === w.id ? null : w.id) }}
                      >
                        {PLUS_SVG}阶段
                      </button>
                    )}
                  </div>

                  {/* 新增阶段选择器 */}
                  {addingStageWf === w.id && onUpdateStages && (
                    <div className="wf-add-picker">
                      <span className="wf-add-hint">加内置阶段:</span>
                      {STAGE_KEYS.filter(k => !w.stages.some(s => s.key === k)).map(k => (
                        <button key={k} className="wf-pick" onClick={() => addStage(w, { key: k, defaultAgent: 'claude', defaultModel: 'opus-4.8' })}>{STAGE_NAMES[k]}</button>
                      ))}
                      <button className="wf-pick custom" onClick={() => addStage(w, newCustomStage(w.stages))}>+ 自定义阶段</button>
                    </div>
                  )}

                  {/* PluginEditor shown inline under this workflow when editing */}
                  {isThisEditing && editing && (
                    <PluginEditor
                      afterLabel={afterLabel(editing.after)}
                      presets={editing.editId ? undefined : PLUGIN_PRESETS}
                      initial={editing.editId
                        ? w.plugins.find(p => p.id === editing.editId)
                        : undefined
                      }
                      onSave={(result) => handleSave(w.id, result)}
                      onCancel={() => setEditing(null)}
                    />
                  )}
                  {stageEdit?.wfId === w.id && onUpdateStages && (() => {
                    const s = w.stages.find(x => x.key === stageEdit.key)
                    if (!s) return null
                    const isBuiltin = STAGE_KEYS.includes(stageEdit.key as typeof STAGE_KEYS[number])
                    const idx = w.stages.findIndex(x => x.key === s.key)
                    return (
                      <div className="stage-cfg-wrap">
                        <div className="stage-cfg-tools">
                          <button className="scw-btn" disabled={idx <= 0} title="上移" onClick={() => moveStage(w, s.key, -1)}>↑</button>
                          <button className="scw-btn" disabled={idx >= w.stages.length - 1} title="下移" onClick={() => moveStage(w, s.key, 1)}>↓</button>
                          <button className="scw-btn del" disabled={w.stages.length <= 1} title="删除阶段" onClick={() => deleteStage(w, s.key)}>{TRASH}</button>
                        </div>
                        <StageConfigEditor
                          key={s.key}
                          stage={s}
                          isBuiltin={isBuiltin}
                          builtinName={STAGE_NAMES[s.key]}
                          builtinBasePrompt={STAGE_DEFAULT_PROMPT[s.key]}
                          providers={providers}
                          onSave={(patch) => saveStageConfig(w, s.key, patch)}
                          onCancel={() => setStageEdit(null)}
                        />
                      </div>
                    )
                  })()}
                </div>
              )
            })
          )}
        </div>
      </div>
      <div className="set-group">
        <h4>新建流程</h4>
        <div className="wf-new">
          <div className="row1">
            <input
              className="nm"
              placeholder="流程名称,例如:重构专用流程"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="mk" disabled={!canCreate} onClick={create}>
              创建
            </button>
          </div>
          <div className="pick-stages">
            {STAGE_KEYS.map((key) => (
              <button
                key={key}
                className={`wf-pick${picked.has(key) ? ' on' : ''}`}
                data-wfpick={key}
                onClick={() => toggle(key)}
              >
                {STAGE_NAMES[key]}
              </button>
            ))}
          </div>
        </div>
      </div>
      <ImportModal config={importCfg} onClose={() => setImportCfg(null)} />
    </>
  )
}
