// 规则表格(08 §11、评审修订 2):按稳定的行 id 操作和标错,不按下标——这样移动/增删后错误还跟着它的规则,
// 删掉的规则连错误一起消失(errors 里的键没有任何行对上,自然不显示)。纯展示组件:不发请求,草稿和保存
// 都在页面层;disabled 时所有控件锁住(评审修订:保存中不能再改)。
import type { RuleError, RuleSpec } from '@mffai/protocol'
import { TagInput } from './TagInput'
import { CodeChip } from '../ui/CodeChip'

const EFFECTS: readonly RuleSpec['effect'][] = ['deny', 'ask', 'allow']
const EFFECT_LABEL: Record<RuleSpec['effect'], string> = { deny: '拒绝', ask: '询问', allow: '允许' }

/** 一行规则 + 客户端自己发的稳定 id(后台不认识它,保存时只送 r) */
export interface RuleRow { id: string; r: RuleSpec }

export function RuleEditor({ rows, errors, disabled, onEdit, onMove, onRemove, onAdd, registerFlush }: {
  rows: readonly RuleRow[]
  /** 按行 id,不是下标:这样 move/delete 之后错误还跟着它的规则 */
  errors: ReadonlyMap<string, RuleError>
  disabled?: boolean
  onEdit: (id: string, patch: Partial<RuleSpec>) => void
  onMove: (id: string, dir: -1 | 1) => void
  onRemove: (id: string) => void
  onAdd: () => void
  registerFlush?: (flush: () => void) => () => void
}) {
  return (
    <div className="mffai-rules">
      {rows.map(({ id, r }, i) => {
        const err = errors.get(id)
        return (
          <div key={id} className={`mffai-row mffai-rule${err ? ' mffai-rule-bad' : ''}`} data-rule={id}>
            <select aria-label="效果" value={r.effect} disabled={disabled}
              onChange={(e) => onEdit(id, { effect: e.target.value as RuleSpec['effect'] })}>
              {EFFECTS.map((e) => <option key={e} value={e}>{EFFECT_LABEL[e]}</option>)}
            </select>
            <input aria-label="规则" value={r.rule} disabled={disabled} onChange={(e) => onEdit(id, { rule: e.target.value })} />
            <TagInput label="应匹配" value={r.match ?? []} disabled={disabled} registerFlush={registerFlush}
              onChange={(match) => onEdit(id, { match })} />
            <TagInput label="不应匹配" value={r.noMatch ?? []} disabled={disabled} registerFlush={registerFlush}
              onChange={(noMatch) => onEdit(id, { noMatch })} />
            <button type="button" className="set-btn" disabled={disabled || i === 0} onClick={() => onMove(id, -1)}>上移</button>
            <button type="button" className="set-btn" disabled={disabled || i === rows.length - 1} onClick={() => onMove(id, 1)}>下移</button>
            <button type="button" className="set-btn" disabled={disabled} onClick={() => onRemove(id)}>删除</button>
            {err && (
              <span className="mffai-rule-error">
                <CodeChip code={err.reason} />
                {err.case !== undefined && <CodeChip code={err.case} />}
              </span>
            )}
          </div>
        )
      })}
      <button type="button" className="set-btn" disabled={disabled} onClick={onAdd}>添加规则</button>
    </div>
  )
}
