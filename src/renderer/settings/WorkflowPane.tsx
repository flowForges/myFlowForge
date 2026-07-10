import { useState } from 'react'
import { PluginEditor } from '../components/PluginEditor'
import { StageConfigEditor } from '../components/StageConfigEditor'
import type { CfgWorkflow, CfgStage, CfgCustomStage } from '../state/useConfig'
import type { ProviderInfo } from '@shared/types'
import type { Plugin } from '@shared/plugin'
import { movePluginBefore } from '../../shared/pluginReorder'
import { indexCustomStages, resolveStageDef, resolveStages, type CustomStageDef } from '../../shared/customStages'
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
  // Global custom-stage library — templates reference entries by libId (定义一次,处处引用).
  customStages?: CfgCustomStage[]
  // stages: ordered list of bare built-in keys or full custom stage configs.
  onCreate: (name: string, stages: (string | CfgStage)[]) => void
  onDelete: (id: string) => void
  onUpdateWorkflow: (id: string, plugins: Plugin[]) => void
  onUpdateStagePrompts: (id: string, stagePrompts: Record<string, string>) => void
  // Full stage-list edit (#3): add/rename/delete/reorder stages + per-stage prompt/agent/flags.
  onUpdateStages?: (id: string, stages: CfgStage[]) => void
  // Edit / create a global custom-stage-library definition (returns the resolved def with its libId).
  onUpsertCustomStage?: (id: string, patch: Partial<CfgCustomStage>) => Promise<CfgCustomStage>
}

// A template-unique custom-stage key (custom-N), used when inserting a library reference into a workflow.
function uniqueCustomKey(existing: { key: string }[]): string {
  let n = existing.filter(s => s.key.startsWith('custom-')).length + 1
  let key = `custom-${n}`
  while (existing.some(s => s.key === key)) key = `custom-${++n}`
  return key
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

const mkBuiltinStage = (key: string): CfgStage => ({ key, defaultAgent: 'claude', defaultModel: 'opus-4.8' })

export function WorkflowPane({ workflows, providers = [], customStages = [], onCreate, onDelete, onUpdateWorkflow, onUpdateStages, onUpsertCustomStage }: WorkflowPaneProps) {
  const byId = indexCustomStages(customStages as unknown as CustomStageDef[])
  const [name, setName] = useState('')
  // 新建流程:一个有序的草稿阶段列表(内置 + 自定义),可增删、可拖动排序。
  const [draft, setDraft] = useState<CfgStage[]>(() => [mkBuiltinStage('develop')])
  const [draftDragKey, setDraftDragKey] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [stageEdit, setStageEdit] = useState<{ wfId: string; key: string } | null>(null)
  const [addingStageWf, setAddingStageWf] = useState<string | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [stageDragKey, setStageDragKey] = useState<string | null>(null)   // dragging a stage chip in a saved workflow
  const [importCfg, setImportCfg] = useState<ImportConfig | null>(null)

  // Reorder a saved workflow's stages by drag: move `dragKey` to before `beforeKey`.
  function reorderStages(wf: CfgWorkflow, dragKey: string, beforeKey: string) {
    if (!dragKey || dragKey === beforeKey) return
    const arr = wf.stages.slice()
    const from = arr.findIndex(s => s.key === dragKey)
    if (from < 0) return
    const [moved] = arr.splice(from, 1)
    const to = arr.findIndex(s => s.key === beforeKey)
    arr.splice(to < 0 ? arr.length : to, 0, moved)
    putStages(wf, arr)
  }

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
  // Insert a reference to an EXISTING library def (从库选择): a template-unique key + libId + cached
  // name/agent/model (fallback if the lib is later deleted). Doesn't open the editor — editing a
  // reference edits the shared library, which the user opts into explicitly by clicking the chip.
  function addLibReference(wf: CfgWorkflow, def: CfgCustomStage) {
    const key = uniqueCustomKey(wf.stages)
    putStages(wf, [...wf.stages, { key, libId: def.id, name: def.name, defaultAgent: def.defaultAgent, defaultModel: def.defaultModel }])
    setAddingStageWf(null)
  }
  // 新建自定义阶段(共享): create a fresh library def, then insert a reference to it + open the editor.
  async function newLibStage(wf: CfgWorkflow) {
    if (!onUpsertCustomStage) return
    const id = crypto.randomUUID()
    const key = uniqueCustomKey(wf.stages)
    await onUpsertCustomStage(id, { key: id, name: '新阶段', defaultAgent: 'claude', defaultModel: '' })
    putStages(wf, [...wf.stages, { key, libId: id, name: '新阶段', defaultAgent: 'claude', defaultModel: '' }])
    setAddingStageWf(null)
    setStageEdit({ wfId: wf.id, key })
  }
  // Extract an INLINE custom stage (no libId) into the shared library, then turn the template stage into
  // a reference — so the same config becomes reusable + editable-once across templates.
  async function extractToLibrary(wf: CfgWorkflow, stage: CfgStage) {
    if (!onUpsertCustomStage) return
    const id = crypto.randomUUID()
    await onUpsertCustomStage(id, {
      key: id, name: stage.name || stage.key, defaultAgent: stage.defaultAgent, defaultModel: stage.defaultModel,
      ...(stage.prompt ? { prompt: stage.prompt } : {}),
      ...(stage.scope ? { scope: stage.scope } : {}),
      ...(stage.gate !== undefined ? { gate: stage.gate } : {}),
      ...(stage.review ? { review: stage.review } : {}),
      ...(stage.summary !== undefined ? { summary: stage.summary } : {}),
      ...(stage.projectAgent !== undefined ? { projectAgent: stage.projectAgent } : {}),
      ...(stage.producesDoc !== undefined ? { producesDoc: stage.producesDoc } : {}),
    })
    putStages(wf, wf.stages.map(s => s.key === stage.key
      ? { key: s.key, libId: id, name: stage.name || stage.key, defaultAgent: stage.defaultAgent, defaultModel: stage.defaultModel }
      : s))
    setStageEdit(null)
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

  // —— 新建流程草稿:增删、改名(自定义)、拖动排序 ——
  const addDraftBuiltin = (key: string) => setDraft(d => d.some(s => s.key === key) ? d : [...d, mkBuiltinStage(key)])
  // 新建流程里加自定义阶段 = 引用共享库(去掉了旧的"加空占位":自定义阶段统一在库里定义,模板只引用)。
  // 从库选择:插入对已有库定义的引用(缓存 name/agent/model 作库项被删时的兜底)。
  const addDraftLibRef = (def: CfgCustomStage) => setDraft(d =>
    d.some(s => s.libId === def.id) ? d
      : [...d, { key: uniqueCustomKey(d), libId: def.id, name: def.name, defaultAgent: def.defaultAgent, defaultModel: def.defaultModel }])
  // 新建(共享):在全局库建一条新定义,再往草稿插入对它的引用。名称/提示词等到「自定义阶段」页里配。
  const newDraftLibStage = async () => {
    if (!onUpsertCustomStage) return
    const id = crypto.randomUUID()
    await onUpsertCustomStage(id, { key: id, name: '新阶段', defaultAgent: 'claude', defaultModel: '' })
    setDraft(d => [...d, { key: uniqueCustomKey(d), libId: id, name: '新阶段', defaultAgent: 'claude', defaultModel: '' }])
  }
  const removeDraft = (key: string) => setDraft(d => d.length > 1 ? d.filter(s => s.key !== key) : d)
  function reorderDraft(dragKey: string, beforeKey: string) {
    if (!dragKey || dragKey === beforeKey) return
    setDraft(d => {
      const arr = d.slice()
      const from = arr.findIndex(s => s.key === dragKey)
      if (from < 0) return d
      const [moved] = arr.splice(from, 1)
      const to = arr.findIndex(s => s.key === beforeKey)
      arr.splice(to < 0 ? arr.length : to, 0, moved)
      return arr
    })
  }

  function create() {
    const nm = name.trim()
    if (!nm || draft.length === 0) return
    onCreate(nm, draft)
    setName('')
    setDraft([mkBuiltinStage('develop')])
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

  const canCreate = name.trim().length > 0 && draft.length > 0

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

                    {/* Stages: drag to reorder (when onUpdateStages), click to edit; insert buttons after each.
                        Resolve library references (libId) against the shared library so the chip shows the
                        CURRENT shared name — key/order are preserved by the resolver. */}
                    {resolveStages(w.stages, byId).map((s, i) => (
                      <span key={s.key} style={{ display: 'contents' }}>
                        <span
                          className={'wf-stage-chip click' + ((s.prompt || w.stagePrompts?.[s.key]) ? ' edited' : '') + (STAGE_KEYS.includes(s.key as typeof STAGE_KEYS[number]) ? '' : ' custom') + (s.libId ? ' shared' : '') + (stageDragKey === s.key ? ' dragging' : '')}
                          title={s.libId ? '共享阶段(来自自定义阶段库)· 编辑会影响所有引用它的模板' : (onUpdateStages ? '拖动排序 · 点击编辑' : `点击编辑「${s.name || STAGE_NAMES[s.key] || s.key}」阶段`)}
                          draggable={!!onUpdateStages}
                          onDragStart={() => setStageDragKey(s.key)}
                          onDragEnd={() => setStageDragKey(null)}
                          onDragOver={e => { if (stageDragKey) e.preventDefault() }}
                          onDrop={e => { e.preventDefault(); if (stageDragKey) reorderStages(w, stageDragKey, s.key); setStageDragKey(null) }}
                          onClick={() => { setEditing(null); setAddingStageWf(null); setStageEdit({ wfId: w.id, key: s.key }) }}
                        >
                          <span className="n">{i + 1}</span>
                          {s.name || STAGE_NAMES[s.key] || s.key}
                          {s.libId && <span className="st-custom-tag" title="共享阶段">共享</span>}
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
                      {onUpsertCustomStage ? (
                        <>
                          <span className="wf-add-hint">自定义阶段:</span>
                          <button className="wf-pick custom" data-newlibstage onClick={() => void newLibStage(w)}>+ 新建(共享)</button>
                          {customStages.filter(cs => !w.stages.some(s => s.libId === cs.id)).map(cs => (
                            <button key={cs.id} className="wf-pick" data-libpick={cs.id} title="从自定义阶段库引用" onClick={() => addLibReference(w, cs)}>{cs.name || cs.key}</button>
                          ))}
                        </>
                      ) : (
                        <button className="wf-pick custom" onClick={() => addStage(w, newCustomStage(w.stages))}>+ 自定义阶段</button>
                      )}
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
                    const orig = w.stages.find(x => x.key === stageEdit.key)
                    if (!orig) return null
                    // Resolve so the editor shows the CURRENT shared definition for a library reference.
                    const s = resolveStageDef(orig, byId)
                    const isBuiltin = STAGE_KEYS.includes(stageEdit.key as typeof STAGE_KEYS[number])
                    const idx = w.stages.findIndex(x => x.key === orig.key)
                    const isRef = !!orig.libId
                    // A live library reference (its def still exists) → edits sync to the shared library;
                    // a dangling reference (def deleted) or inline custom stage → edits stay on the template.
                    const editsLibrary = isRef && onUpsertCustomStage && byId[orig.libId!]
                    return (
                      <div className="stage-cfg-wrap">
                        <div className="stage-cfg-tools">
                          <button className="scw-btn" disabled={idx <= 0} title="上移" onClick={() => moveStage(w, orig.key, -1)}>↑</button>
                          <button className="scw-btn" disabled={idx >= w.stages.length - 1} title="下移" onClick={() => moveStage(w, orig.key, 1)}>↓</button>
                          {!isBuiltin && !isRef && onUpsertCustomStage && (
                            <button className="scw-btn" title="提取到共享库(供其它模板复用)" onClick={() => void extractToLibrary(w, orig)}>提取到共享库</button>
                          )}
                          <button className="scw-btn del" disabled={w.stages.length <= 1} title={isRef ? '从本模板移除引用(不影响库定义)' : '删除阶段'} onClick={() => deleteStage(w, orig.key)}>{TRASH}</button>
                        </div>
                        {editsLibrary && <div className="sce-shared-note" style={{ padding: '6px 10px', fontSize: 12, opacity: 0.75 }}>共享阶段 · 保存会同步到所有引用它的模板</div>}
                        <StageConfigEditor
                          key={orig.key}
                          stage={s}
                          isBuiltin={isBuiltin}
                          builtinName={STAGE_NAMES[orig.key]}
                          builtinBasePrompt={STAGE_DEFAULT_PROMPT[orig.key]}
                          providers={providers}
                          onSave={(patch) => {
                            if (editsLibrary) { void onUpsertCustomStage!(orig.libId!, patch); setStageEdit(null) }
                            else saveStageConfig(w, orig.key, patch)
                          }}
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
          {/* 有序草稿阶段:拖动排序、改名(自定义)、移除 */}
          <div className="wf-draft-flow">
            {draft.map((s, i) => {
              const isRef = !!s.libId
              const label = isRef ? (byId[s.libId!]?.name ?? s.name ?? s.key) : (STAGE_NAMES[s.key] ?? s.name ?? s.key)
              return (
                <span
                  key={s.key}
                  className={`wf-draft-chip${isRef ? ' custom shared' : ''}${draftDragKey === s.key ? ' dragging' : ''}`}
                  draggable
                  onDragStart={() => setDraftDragKey(s.key)}
                  onDragEnd={() => setDraftDragKey(null)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); if (draftDragKey) reorderDraft(draftDragKey, s.key); setDraftDragKey(null) }}
                  title={isRef ? '共享阶段(来自自定义阶段库)· 在「自定义阶段」页里配置' : '拖动排序'}
                >
                  <span className="n">{i + 1}</span>
                  {label}
                  {isRef && <span className="st-custom-tag" title="共享阶段">共享</span>}
                  <button className="x" title="移除" onClick={() => removeDraft(s.key)}>{X_SVG}</button>
                </span>
              )
            })}
          </div>
          <div className="wf-draft-add">
            <span className="lab">加阶段:</span>
            {STAGE_KEYS.filter(k => !draft.some(s => s.key === k)).map(key => (
              <button key={key} className="wf-pick" onClick={() => addDraftBuiltin(key)}>+ {STAGE_NAMES[key]}</button>
            ))}
            {onUpsertCustomStage && (
              <>
                <span className="lab">自定义阶段:</span>
                <button className="wf-pick custom" data-newdraftlibstage onClick={() => void newDraftLibStage()}>+ 新建(共享)</button>
                {customStages.filter(cs => !draft.some(s => s.libId === cs.id)).map(cs => (
                  <button key={cs.id} className="wf-pick" data-draftlibpick={cs.id} title="从自定义阶段库引用" onClick={() => addDraftLibRef(cs)}>{cs.name || cs.key}</button>
                ))}
              </>
            )}
          </div>
          <div className="wf-draft-hint">自定义阶段在「自定义阶段」页里定义与配置,这里只引用;创建后可在上方模板里继续调整每个阶段的提示词、代理与行为。</div>
        </div>
      </div>
      <ImportModal config={importCfg} onClose={() => setImportCfg(null)} />
    </>
  )
}
