import { useState, type ReactElement } from 'react'
import { HOOK_SKILLS, HOOK_TOOLS } from '../../shared/plugin'
import type { Plugin } from '../../shared/plugin'
import './pluginEditor.css'

interface PluginEditorProps {
  initial?: Partial<Plugin>
  afterLabel: string
  presets?: { name: string; prompt: string; glyph?: string }[]
  // When true (create-workspace wizard, add mode only), show a「保存到 Hook 库」checkbox whose value is
  // returned as `saveToLibrary` so the caller can also persist the new hook to the reusable library.
  showSaveToLibrary?: boolean
  onSave: (p: { name: string; prompt: string; skills: string[]; tools: string[]; saveToLibrary?: boolean }) => void
  onCancel: () => void
}

// Puzzle SVG glyph — matches prototype PUZZLE_CHIP shape
function PuzzleSvg() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 2H9V4.5C9 5 9.5 5.5 10 5H12V9H9.5C9 9 8.5 9.5 8.5 10V12H4.5V9.5C4.5 9 4 8.5 3.5 8.5H2V4.5H4.5C5 4.5 5 4 5 3.5V2Z" />
    </svg>
  )
}

// Preset glyphs — mirror prototype PRESET_SVG (keyed by the preset's glyph id).
const PRESET_SVG: Record<string, ReactElement> = {
  clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 16 14" /></svg>,
  memory: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M12 3 4 7v5c0 5 3.4 8.2 8 9 4.6-.8 8-4 8-9V7Z" /><path d="M9 12h6M12 9v6" /></svg>,
  git: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><polyline points="20 6 9 17 4 12" /></svg>,
  puzzle: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.6 2.6 0 0 1 0 5.2H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.6 2.6 0 0 1 5.2 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z" /></svg>,
}

function toggle(arr: string[], id: string): string[] {
  return arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]
}

export function PluginEditor({ initial, afterLabel, presets, showSaveToLibrary, onSave, onCancel }: PluginEditorProps) {
  const isEditing = Boolean(initial?.name)
  const [name, setName] = useState(initial?.name ?? '')
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [skills, setSkills] = useState<string[]>(initial?.skills ?? [])
  const [tools, setTools] = useState<string[]>(initial?.tools ?? [])
  const [saveToLib, setSaveToLib] = useState(false)
  const canSaveToLib = Boolean(showSaveToLibrary) && !isEditing

  function handleSave() {
    onSave({ name: name.trim(), prompt, skills, tools, ...(canSaveToLib ? { saveToLibrary: saveToLib } : {}) })
  }

  function applyPreset(preset: { name: string; prompt: string }) {
    setName(preset.name)
    setPrompt(preset.prompt)
  }

  const saveDisabled = name.trim() === ''

  return (
    <div className="plug-editor">
      {/* Header */}
      <div className="pe-h">
        <PuzzleSvg />
        {isEditing ? '编辑插件' : '新增插件'}
        <span className="pos">{afterLabel}</span>
      </div>

      {/* Presets — only in add mode */}
      {!isEditing && presets && presets.length > 0 && (
        <div className="plug-presets">
          {presets.map((p, i) => (
            <button key={i} type="button" className="plug-preset" onClick={() => applyPreset(p)}>
              {p.glyph && PRESET_SVG[p.glyph]}
              {p.name}
            </button>
          ))}
        </div>
      )}

      {/* Name field */}
      <div className="pe-field">
        <label>插件名称</label>
        <input
          placeholder="例如:当前时间 / 读取我的记忆"
          value={name}
          onChange={e => setName(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {/* Prompt field */}
      <div className="pe-field">
        <label>插件 prompt</label>
        <textarea
          placeholder="描述这个插件要做什么 —— 它会作为一个 hook 步骤在该位置执行,并把输出注入后续阶段。"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
        />
      </div>

      {/* Skill chips */}
      <div className="pe-field">
        <label>
          技能 Skill
          <span className="pe-hint">运行时为该插件加载</span>
        </label>
        <div className="hk-picks">
          {HOOK_SKILLS.map(skill => (
            <button
              key={skill.id}
              type="button"
              className={`hk-pick${skills.includes(skill.id) ? ' on' : ''}`}
              onClick={() => setSkills(s => toggle(s, skill.id))}
              aria-pressed={skills.includes(skill.id)}
            >
              <span className="hk-b s">S</span>
              {skill.name}
            </button>
          ))}
        </div>
      </div>

      {/* Tool chips */}
      <div className="pe-field">
        <label>
          工具 Tool
          <span className="pe-hint">可选 · 不选则由 LLM 按 prompt 自行调用所需工具;选中则限定为这些</span>
        </label>
        <div className="hk-picks">
          {HOOK_TOOLS.map(tool => (
            <button
              key={tool.id}
              type="button"
              className={`hk-pick${tools.includes(tool.id) ? ' on' : ''}`}
              onClick={() => setTools(t => toggle(t, tool.id))}
              aria-pressed={tools.includes(tool.id)}
            >
              <span className="hk-b t">T</span>
              {tool.name}
            </button>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="pe-foot">
        {canSaveToLib && (
          <label className="pe-savelib" title="勾选后,这个 hook 也会存进设置 → Hook 库,以后建区可直接复用">
            <input type="checkbox" checked={saveToLib} onChange={e => setSaveToLib(e.target.checked)} />
            保存到 Hook 库
          </label>
        )}
        <span className="sp" />
        <button type="button" className="cancel" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="save" onClick={handleSave} disabled={saveDisabled}>
          {isEditing ? '保存' : '添加插件'}
        </button>
      </div>
    </div>
  )
}
