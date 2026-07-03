import { useState } from 'react'
import './stagePromptEditor.css'

interface StagePromptEditorProps {
  stageName: string
  defaultPrompt: string
  initial?: string
  onSave: (append: string) => void
  onCancel: () => void
}

const PENCIL = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
)

export function StagePromptEditor({ stageName, defaultPrompt, initial, onSave, onCancel }: StagePromptEditorProps) {
  const [append, setAppend] = useState(initial ?? '')
  const has = append.trim().length > 0
  return (
    <div className="plug-editor stage-prompt-editor">
      <div className="pe-h">
        {PENCIL}
        编辑阶段提示词
        <span className={'pos' + (has ? '' : ' def')}>{stageName} · {has ? '已追加' : '默认'}</span>
      </div>

      <div className="pe-field">
        <label>默认提示词(固定)</label>
        <div className="pe-readonly">{defaultPrompt}</div>
      </div>

      <div className="pe-field">
        <label>补充要求 <span className="pe-hint">追加到默认提示词之后;不会替换默认内容</span></label>
        <textarea
          placeholder="例如:必须画时序图、评估对 X 模块的影响…"
          value={append}
          onChange={e => setAppend(e.target.value)}
        />
      </div>

      <div className="pe-foot">
        <button type="button" className="spe-reset" disabled={!has} onClick={() => setAppend('')}>清空追加</button>
        <span className="sp" />
        <button type="button" className="cancel" onClick={onCancel}>取消</button>
        <button type="button" className="save" onClick={() => onSave(append.trim())}>保存</button>
      </div>
    </div>
  )
}
