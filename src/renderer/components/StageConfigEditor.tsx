import { useState } from 'react'
import type { ProviderInfo, ReviewConfig, ReviewLens } from '@shared/types'
import { REVIEW_LENSES, REVIEW_LENS_LABELS } from '@shared/types'
import type { CfgStage } from '../state/useConfig'

// Effective built-in defaults (mirror the main-process behavior tables) so a toggle shows the real
// effective value even when the flag is unset. Custom stages fall to the most conservative option.
export function builtinStageDefaults(key: string): { scope: 'root' | 'per-project'; gate: boolean; summary: boolean; review: ReviewConfig | undefined } {
  return {
    scope: key === 'develop' || key === 'design' ? 'per-project' : 'root',
    gate: true,
    summary: key === 'design',
    // ②多镜头CR: the review stage defaults to 并行多视角 with all four lenses (mirrors resolveStages.ts's
    // DEFAULT_REVIEW_CONFIG so the editor shows the real effective value).
    review: key === 'review' ? { mode: 'parallel', reviewers: [...REVIEW_LENSES] } : undefined,
  }
}

interface StageConfigEditorProps {
  stage: CfgStage
  isBuiltin: boolean
  builtinName?: string       // built-in display name (for the read-only name row)
  builtinBasePrompt?: string // built-in base prompt (shown read-only; the editable box is the append)
  providers: ProviderInfo[]
  onSave: (patch: Partial<CfgStage>) => void
  onCancel: () => void
}

export function StageConfigEditor({ stage, isBuiltin, builtinName, builtinBasePrompt, providers, onSave, onCancel }: StageConfigEditorProps) {
  const def = builtinStageDefaults(stage.key)
  const [name, setName] = useState(stage.name ?? '')
  const [prompt, setPrompt] = useState(stage.prompt ?? '')
  const [agent, setAgent] = useState(stage.defaultAgent || 'claude')
  const [model, setModel] = useState(stage.defaultModel || '')
  const [scope, setScope] = useState<'root' | 'per-project'>(stage.scope ?? def.scope)
  const [gate, setGate] = useState<boolean>(stage.gate ?? def.gate)
  const [summary, setSummary] = useState<boolean>(stage.summary ?? def.summary)
  // review tri-state: 'off' | 'single' | 'parallel'
  const initReview: 'off' | 'single' | 'parallel' = stage.review?.mode ?? (def.review ? def.review.mode : 'off')
  const [reviewMode, setReviewMode] = useState<'off' | 'single' | 'parallel'>(initReview)
  // ②多镜头CR: which lenses the 并行多视角 fan-out runs. Seed from an explicit lens array if present,
  // else all four (the default). Toggled below; empty selection falls back to all four on save (a
  // parallel review with zero reviewers makes no sense).
  const initLenses: ReviewLens[] = Array.isArray(stage.review?.reviewers)
    ? (stage.review!.reviewers as ReviewLens[])
    : [...REVIEW_LENSES]
  const [lenses, setLenses] = useState<ReviewLens[]>(initLenses)
  const toggleLens = (l: ReviewLens) => setLenses(prev => prev.includes(l) ? prev.filter(x => x !== l) : [...prev, l])

  const models = providers.find(p => p.id === agent)?.models ?? []

  function save() {
    // Keep REVIEW_LENSES canonical order; empty → all four.
    const picked = REVIEW_LENSES.filter(l => lenses.includes(l))
    const review: ReviewConfig | undefined =
      reviewMode === 'off' ? undefined
        : reviewMode === 'single' ? { mode: 'single' }
          : { mode: 'parallel', reviewers: picked.length ? picked : [...REVIEW_LENSES] }
    onSave({
      ...(isBuiltin ? {} : { name: name.trim() || stage.key }),
      defaultAgent: agent,
      defaultModel: model,
      prompt: prompt.trim() || undefined,
      scope,
      gate,
      summary,
      review,
    })
  }

  return (
    <div className="stage-cfg-editor">
      {!isBuiltin ? (
        <label className="sce-row">
          <span className="sce-label">阶段名称</span>
          <input className="sce-input" value={name} placeholder="例如:安全审计" onChange={e => setName(e.target.value)} />
        </label>
      ) : (
        <div className="sce-row"><span className="sce-label">阶段</span><span className="sce-fixed">{builtinName ?? stage.key}<span className="sce-hint"> · 内置阶段</span></span></div>
      )}

      {isBuiltin && builtinBasePrompt ? (
        <div className="sce-row col">
          <span className="sce-label">内置提示词(不可改)</span>
          <div className="sce-readonly">{builtinBasePrompt}</div>
        </div>
      ) : null}
      <label className="sce-row col">
        <span className="sce-label">{isBuiltin ? '追加要求(拼在内置提示词后)' : '阶段提示词(本阶段完整指令)'}</span>
        <textarea className="sce-ta" rows={isBuiltin ? 3 : 5} value={prompt}
          placeholder={isBuiltin ? '可留空;填写的内容作为对本阶段的额外要求' : '描述这个阶段要子代理做什么…'}
          onChange={e => setPrompt(e.target.value)} />
      </label>

      <div className="sce-row">
        <span className="sce-label">执行代理</span>
        <div className="sce-agents">
          <select className="sce-select" value={agent} onChange={e => { setAgent(e.target.value); setModel('') }}>
            {providers.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            {!providers.some(p => p.id === agent) ? <option value={agent}>{agent}</option> : null}
          </select>
          <select className="sce-select" value={model} onChange={e => setModel(e.target.value)}>
            <option value="">默认模型</option>
            {models.map(m => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
            {model && !models.some(m => m.id === model) ? <option value={model}>{model}</option> : null}
          </select>
        </div>
      </div>

      <div className="sce-flags">
        <button className={`sce-flag${scope === 'per-project' ? ' on' : ''}`} onClick={() => setScope(scope === 'per-project' ? 'root' : 'per-project')}
          title="按项目拆分:每个项目一个子代理,在各自 worktree 里跑">按项目拆分</button>
        <button className={`sce-flag${gate ? ' on' : ''}`} onClick={() => setGate(!gate)}
          title="人工门控:本阶段跑完暂停,你可继续 / 打回重做 / 终止">人工门控</button>
        <button className={`sce-flag${summary ? ' on' : ''}`} onClick={() => setSummary(!summary)}
          title="汇总代理:按项目跑完后追加一个代理,汇总各项目产出">汇总代理</button>
        <div className="sce-review">
          <span className="sce-flag-label">评审扇出</span>
          {(['off', 'single', 'parallel'] as const).map(m => (
            <button key={m} className={`sce-flag${reviewMode === m ? ' on' : ''}`} onClick={() => setReviewMode(m)}>
              {m === 'off' ? '关' : m === 'single' ? '单代理' : '并行多视角'}
            </button>
          ))}
        </div>
        {/* ②多镜头CR: pick which视角 the 并行多视角 fan-out runs — one reviewer per checked lens. */}
        {reviewMode === 'parallel' ? (
          <div className="sce-lenses">
            <span className="sce-flag-label">评审视角</span>
            {REVIEW_LENSES.map(l => (
              <button key={l} className={`sce-flag${lenses.includes(l) ? ' on' : ''}`} onClick={() => toggleLens(l)}
                title={`勾选后会有一个专门审「${REVIEW_LENS_LABELS[l]}」的评审员`}>
                {REVIEW_LENS_LABELS[l]}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="sce-actions">
        <button className="sce-save" onClick={save}>保存阶段</button>
        <button className="sce-cancel" onClick={onCancel}>取消</button>
      </div>
    </div>
  )
}
