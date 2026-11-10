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
      {rows.length > 0 && (
        <div className="mffai-rulehead" aria-hidden="true">
          <span /><span>效果</span><span>规则</span><span>应匹配</span><span>不应匹配</span><span />
        </div>
      )}
      {rows.map(({ id, r }, i) => {
        const err = errors.get(id)
        return (
          <div key={id} className={`mffai-row mffai-rule${err ? ' mffai-rule-bad' : ''}`} data-rule={id}>
            <svg className="mffai-i mffai-grip" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></svg>
            <div className="mffai-seg mffai-effseg" role="group" aria-label="效果">
              {EFFECTS.map((e) => (
                <button key={e} type="button" className={`${e}${r.effect === e ? ' on' : ''}`} aria-pressed={r.effect === e} disabled={disabled}
                  onClick={() => onEdit(id, { effect: e })}>{EFFECT_LABEL[e]}</button>
              ))}
            </div>
            <div className="mffai-rulecell">
              <input aria-label="规则" value={r.rule} disabled={disabled} onChange={(e) => onEdit(id, { rule: e.target.value })} />
              {err && (
                <span className="mffai-rule-error">
                  <svg className="mffai-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></svg>
                  <CodeChip code={err.reason} />
                  {err.case !== undefined && <CodeChip code={err.case} />}
                </span>
              )}
            </div>
            <TagInput label="应匹配" tone="ok" value={r.match ?? []} disabled={disabled} registerFlush={registerFlush}
              onChange={(match) => onEdit(id, { match })} />
            <TagInput label="不应匹配" tone="bad" value={r.noMatch ?? []} disabled={disabled} registerFlush={registerFlush}
              onChange={(noMatch) => onEdit(id, { noMatch })} />
            <span className="mffai-ruleops">
              <button type="button" className="mffai-iconbtn" aria-label="上移" disabled={disabled || i === 0} onClick={() => onMove(id, -1)}>
                <svg className="mffai-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </button>
              <button type="button" className="mffai-iconbtn" aria-label="下移" disabled={disabled || i === rows.length - 1} onClick={() => onMove(id, 1)}>
                <svg className="mffai-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
              </button>
              <button type="button" className="mffai-iconbtn mffai-danger" aria-label="删除" disabled={disabled} onClick={() => onRemove(id)}>
                <svg className="mffai-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
              </button>
            </span>
          </div>
        )
      })}
      <button type="button" className="set-btn mffai-addrule" disabled={disabled} onClick={onAdd}>
        <svg className="mffai-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>添加规则
      </button>
    </div>
  )
}
