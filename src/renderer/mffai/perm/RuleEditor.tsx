// 规则表格(08 §11):效果、规则文本、match/noMatch 标签式输入,上移/下移/删除,添加规则。
// 纯展示组件:不发请求,草稿和保存都在页面层。errors 按 index 对上行,标红并显示 reason/case。
import type { RuleError, RuleSpec } from '@mffai/protocol'
import { TagInput } from './TagInput'
import { CodeChip } from '../ui/CodeChip'

const EFFECTS: readonly RuleSpec['effect'][] = ['deny', 'ask', 'allow']
const EFFECT_LABEL: Record<RuleSpec['effect'], string> = { deny: '拒绝', ask: '询问', allow: '允许' }

export function RuleEditor({ rules, errors, onChange }: {
  rules: readonly RuleSpec[]
  errors: ReadonlyMap<number, RuleError>
  onChange: (rules: RuleSpec[]) => void
}) {
  const edit = (i: number, patch: Partial<RuleSpec>) => onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rules.length) return
    const next = rules.slice()
    const tmp = next[i]
    next[i] = next[j]
    next[j] = tmp
    onChange(next)
  }
  const remove = (i: number) => onChange(rules.filter((_, idx) => idx !== i))
  const add = () => onChange([...rules, { effect: 'ask', rule: '', match: [], noMatch: [] }])

  return (
    <div className="mffai-rules">
      {rules.map((r, i) => {
        const err = errors.get(i)
        return (
          <div key={i} className={`mffai-row mffai-rule${err ? ' mffai-rule-bad' : ''}`} data-rule={i}>
            <select aria-label="效果" value={r.effect} onChange={(e) => edit(i, { effect: e.target.value as RuleSpec['effect'] })}>
              {EFFECTS.map((e) => <option key={e} value={e}>{EFFECT_LABEL[e]}</option>)}
            </select>
            <input aria-label="规则" value={r.rule} onChange={(e) => edit(i, { rule: e.target.value })} />
            <TagInput label="应匹配" value={r.match ?? []} onChange={(match) => edit(i, { match })} />
            <TagInput label="不应匹配" value={r.noMatch ?? []} onChange={(noMatch) => edit(i, { noMatch })} />
            <button type="button" className="set-btn" disabled={i === 0} onClick={() => move(i, -1)}>上移</button>
            <button type="button" className="set-btn" disabled={i === rules.length - 1} onClick={() => move(i, 1)}>下移</button>
            <button type="button" className="set-btn" onClick={() => remove(i)}>删除</button>
            {err && (
              <span className="mffai-rule-error">
                <CodeChip code={err.reason} />
                {err.case !== undefined && <CodeChip code={err.case} />}
              </span>
            )}
          </div>
        )
      })}
      <button type="button" className="set-btn" onClick={add}>添加规则</button>
    </div>
  )
}
