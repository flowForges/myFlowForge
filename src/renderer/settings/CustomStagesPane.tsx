import { useState } from 'react'
import { StageConfigEditor } from '../components/StageConfigEditor'
import type { CfgCustomStage, CfgWorkflow } from '../state/useConfig'
import type { ProviderInfo } from '@shared/types'

const PLUS_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
)
const TRASH = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
)
const PEN = (
  <svg className="pen" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
)

interface CustomStagesPaneProps {
  customStages: CfgCustomStage[]
  workflows: CfgWorkflow[]
  providers?: ProviderInfo[]
  // Merge a patch onto the library def with this id (creating it if new). Returns the resolved def.
  onUpsert: (id: string, patch: Partial<CfgCustomStage>) => Promise<CfgCustomStage>
  onDelete: (id: string) => void
}

export function CustomStagesPane({ customStages, workflows, providers = [], onUpsert, onDelete }: CustomStagesPaneProps) {
  const [editId, setEditId] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  // How many workflow templates reference this library def (by libId).
  const usageOf = (id: string) => workflows.filter(w => (w.stages ?? []).some(s => s.libId === id)).length

  const addStage = async () => {
    const id = crypto.randomUUID()
    await onUpsert(id, { key: id, name: '新阶段', defaultAgent: 'claude', defaultModel: '' })
    setEditId(id)
  }

  return (
    <div className="set-group">
      <h4>自定义阶段</h4>
      <p className="set-desc">
        定义可复用的自定义工作流阶段:在这里定义一次,多个工作流模板即可引用它(在「工作流」里「从库选择」),
        编辑一次处处生效。删除某个阶段后,仍在引用它的模板会回退到各自缓存的名称。
      </p>

      <div className="wf-mgr" style={{ marginTop: 14 }}>
        {customStages.length === 0 ? (
          <div className="cr-proj-empty">还没有自定义阶段。点下面「新建自定义阶段」创建一个,然后到「工作流」里引用它。</div>
        ) : (
          customStages.map(cs => {
            const uses = usageOf(cs.id)
            const isEditing = editId === cs.id
            return (
              <div className="wf-mgr-row" data-cs={cs.id} key={cs.id}>
                <div className="wf-mgr-top">
                  <span className="nm">{cs.name || cs.key}</span>
                  <span className="ct">{uses > 0 ? `${uses} 个模板在用` : '未被引用'}</span>
                  <button className="imp-btn wf-imp" title={isEditing ? '收起' : '编辑'} onClick={() => setEditId(isEditing ? null : cs.id)}>
                    {PEN}{isEditing ? '收起' : '编辑'}
                  </button>
                  <button className="del" title="删除" data-csdel={cs.id} onClick={() => setConfirmDel(cs.id)}>
                    {TRASH}
                  </button>
                </div>

                {confirmDel === cs.id && (
                  <div className="cr-removal-warn">
                    <b>删除自定义阶段「{cs.name || cs.key}」?</b>
                    {uses > 0 ? ` 有 ${uses} 个模板在引用它 —— 删除后这些模板会回退到各自缓存的名称。` : ' 它尚未被任何模板引用。'}
                    <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                      <button className="sce-cancel" onClick={() => setConfirmDel(null)}>取消</button>
                      <button className="sce-save" data-csdelok={cs.id} onClick={() => { onDelete(cs.id); setConfirmDel(null); if (editId === cs.id) setEditId(null) }}>删除</button>
                    </div>
                  </div>
                )}

                {isEditing && (
                  <div className="stage-cfg-wrap">
                    <StageConfigEditor
                      key={cs.id}
                      stage={cs}
                      isBuiltin={false}
                      providers={providers}
                      onSave={(patch) => { void onUpsert(cs.id, patch); setEditId(null) }}
                      onCancel={() => setEditId(null)}
                    />
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <div className="wf-draft-add" style={{ marginTop: 12 }}>
        <button className="imp-btn cs-add" data-csnew onClick={() => void addStage()}>{PLUS_SVG} 新建自定义阶段</button>
      </div>
    </div>
  )
}
